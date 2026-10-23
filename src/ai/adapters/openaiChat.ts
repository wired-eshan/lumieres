/**
 * Legacy OpenAI Chat Completions adapter.
 *
 * This exists only for custom endpoints that have not implemented the
 * Responses API. Built-in providers never select it, so the app never falls
 * back from Responses to Chat Completions on its own. New integrations should
 * choose `openai-responses`.
 *
 * The custom endpoint's reasoning shape is not knowable, so the standard
 * OpenAI `reasoning_effort` field is used and only when the model matches a
 * documented family. The chart in `effort.ts` decides whether a value is
 * eligible; this adapter does not guess.
 */

import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { CHAT_MAX_TOKENS } from '../../config';
import { AIRequestError, describeError, isAbortError, isRetryable } from '../errors';
import { isReasoningModel } from '../reasoning';
import type {
  AdapterRequestBase,
  AdapterResult,
  AdapterStreamRequest,
  LLMAdapter,
} from './types';

type OpenAIClient = InstanceType<typeof import('openai').default>;

async function loadOpenAI(): Promise<typeof import('openai').default> {
  try {
    return (await import('openai')).default;
  } catch {
    throw new AIRequestError(
      'The OpenAI transport could not be loaded. Check the connection and try again.',
      true,
    );
  }
}

async function createClient(config: AdapterRequestBase['config']): Promise<OpenAIClient> {
  const OpenAI = await loadOpenAI();
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });
}

function buildRequest(
  request: AdapterRequestBase,
  stream: boolean,
): ChatCompletionCreateParamsStreaming {
  const params = {
    model: request.config.model,
    messages: [
      { role: 'system', content: request.system },
      ...request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ],
    stream,
    max_tokens: CHAT_MAX_TOKENS,
  } as ChatCompletionCreateParamsStreaming;

  if (request.effort.value) {
    params.reasoning_effort = request.effort.value as ChatCompletionCreateParamsStreaming['reasoning_effort'];
  }
  // o-series / GPT-5 reasoning models reject the deprecated `max_tokens`; the
  // chat model families and most compatible servers still expect it.
  if (isReasoningModel(request.config.model)) {
    delete (params as { max_tokens?: number }).max_tokens;
    params.max_completion_tokens = CHAT_MAX_TOKENS;
  }
  return params;
}

function handleFailure(error: unknown, request: AdapterRequestBase): never {
  if (request.signal?.aborted || isAbortError(error)) {
    throw new AIRequestError('Request stopped.', false);
  }
  if (error instanceof AIRequestError) throw error;
  throw new AIRequestError(
    describeError(error, {
      secrets: [request.config.apiKey],
      providerLabel: request.config.definition.label,
    }),
    isRetryable(error),
  );
}

export const openAIChatAdapter: LLMAdapter = {
  protocol: 'openai-chat',

  async stream(request: AdapterStreamRequest): Promise<AdapterResult> {
    if (request.signal.aborted) throw new AIRequestError('Request stopped.', false);
    const client = await createClient(request.config);

    let text = '';
    let refusal = '';
    let stopReason: string | null = null;

    try {
      const stream = await client.chat.completions.create(
        buildRequest(request, true),
        { signal: request.signal },
      );
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta as { content?: unknown; refusal?: unknown } | undefined;
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          text += delta.content;
          request.onText(delta.content, text);
        }
        if (typeof delta?.refusal === 'string' && delta.refusal.length > 0) {
          refusal += delta.refusal;
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }
    } catch (error) {
      handleFailure(error, request);
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
    return { text, stopReason, responseId: null };
  },

  async generate(request: AdapterRequestBase): Promise<AdapterResult> {
    if (request.signal?.aborted) throw new AIRequestError('Request stopped.', false);
    const client = await createClient(request.config);

    try {
      // The SDK's non-streaming overload; `stream: false` is the default shape.
      const response = await client.chat.completions.create(
        { ...buildRequest(request, false), stream: false },
        request.signal ? { signal: request.signal } : undefined,
      );
      const choice = response.choices[0];
      const refusal = choice?.message?.refusal;
      if (typeof refusal === 'string' && refusal.length > 0) {
        throw new AIRequestError(
          'The model declined this request. Try rephrasing it or switch models in Settings.',
        );
      }
      if (choice?.finish_reason === 'content_filter') {
        throw new AIRequestError(
          'The model declined this request because of its content filter. Try rephrasing it.',
        );
      }
      return {
        text: choice?.message?.content ?? '',
        stopReason: choice?.finish_reason ?? null,
        responseId: null,
      };
    } catch (error) {
      handleFailure(error, request);
    }
  },
};
