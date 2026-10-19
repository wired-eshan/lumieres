/**
 * OpenAI-compatible chat transport.
 *
 * This is the only module that knows a provider exists. It runs directly in the
 * browser because Lumières has no backend; the user's own API key is passed in
 * per request and is never logged or stored here. `dangerouslyAllowBrowser`
 * acknowledges that the key is present in the page, which is why it lives in
 * browser-local settings and never in the graph document.
 *
 * The chat path uses `POST /chat/completions` rather than OpenAI's newer
 * Responses API so the same code works with OpenAI-compatible services (and
 * local servers) that implement the widely supported chat shape.
 *
 * Contract kept by callers (`chatRuntime.ts`):
 *  - one request belongs to one node and one request id
 *  - cancellation is an AbortSignal per request
 *  - deltas are delivered as they arrive, but state updates are the caller's job
 */

import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import type { ChatTurn } from './chatContext';
import { AIRequestError, describeError, isAbortError, isRetryable } from './errors';
import { isReasoningModel, type ReasoningEffort } from './reasoning';

export { AIRequestError, describeError };

/**
 * Output ceiling for one chat reply. Streaming removes the HTTP-timeout reason
 * to keep this small; the cap mainly bounds cost on a long answer. Reasoning
 * models spend part of this budget on reasoning tokens, so leave real headroom.
 */
export const CHAT_MAX_TOKENS = 16_000;

export interface StreamChatInput {
  apiKey: string;
  /** OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  model: string;
  /** Empty/undefined uses the provider default and omits the parameter. */
  reasoningEffort?: ReasoningEffort | '';
  system: string;
  messages: ChatTurn[];
  signal: AbortSignal;
  /** Called for every text delta, with the text received so far. */
  onText: (delta: string, snapshot: string) => void;
}

export interface StreamChatResult {
  text: string;
  stopReason: string | null;
}

export async function streamChat(input: StreamChatInput): Promise<StreamChatResult> {
  // Loaded on first send, not at app boot: the SDK is the largest dependency and
  // a canvas with no AI requests should not pay for it.
  let OpenAI: typeof import('openai').default;
  try {
    ({ default: OpenAI } = await import('openai'));
  } catch {
    throw new AIRequestError(
      'The AI transport could not be loaded. Check the connection and try again.',
      true,
    );
  }
  if (input.signal.aborted) throw new AIRequestError('Request stopped.', false);

  const client = new OpenAI({
    apiKey: input.apiKey,
    baseURL: input.baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });

  const params: ChatCompletionCreateParamsStreaming = {
    model: input.model,
    messages: [
      { role: 'system', content: input.system },
      ...input.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    stream: true,
  };

  // `reasoning_effort` is only valid on models that expose it. A selected
  // effort is enough to know the user's provider advertised support; otherwise
  // use the known-family inference.
  const reasoning = Boolean(input.reasoningEffort) || isReasoningModel(input.model);
  if (input.reasoningEffort) params.reasoning_effort = input.reasoningEffort;
  // o-series / gpt-5 reject the deprecated `max_tokens`; older chat models and
  // many compatible servers still expect it. Pick the parameter by family.
  if (reasoning) params.max_completion_tokens = CHAT_MAX_TOKENS;
  else params.max_tokens = CHAT_MAX_TOKENS;

  let text = '';
  let refusal = '';
  let stopReason: string | null = null;

  try {
    const stream = await client.chat.completions.create(params, { signal: input.signal });
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as { content?: unknown; refusal?: unknown } | undefined;
      const content = delta?.content;
      if (typeof content === 'string' && content.length > 0) {
        text += content;
        input.onText(content, text);
      }
      if (typeof delta?.refusal === 'string' && delta.refusal.length > 0) {
        refusal += delta.refusal;
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) {
      throw new AIRequestError('Request stopped.', false);
    }
    throw new AIRequestError(describeError(error), isRetryable(error));
  }

  if (refusal.length > 0) {
    throw new AIRequestError(
      'The model declined this request. Try rephrasing it or switch models in Settings.',
    );
  }
  if (stopReason === 'content_filter') {
    throw new AIRequestError(
      'The model declined this request because of its content filter. Try rephrasing it.',
    );
  }

  return { text, stopReason };
}
