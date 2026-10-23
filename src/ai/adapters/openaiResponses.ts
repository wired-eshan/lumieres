/**
 * OpenAI Responses adapter.
 *
 * Used by OpenAI, OpenRouter and DeepSeek, and by a custom endpoint that
 * declares the `openai-responses` protocol. All three providers share the
 * request shape; provider-specific differences live in the registry
 * (base URL, capabilities) and the effort table, never in `if (provider === …)`
 * branches here.
 *
 * The SDK appends `/responses` to the configured base URL. A pasted endpoint
 * path is stripped by `provider.ts` so it is not duplicated.
 *
 * Requests are non-idempotent generations, so the SDK is constructed with
 * `maxRetries: 0`: a hidden retry could duplicate visible output or incur an
 * unexpected charge. Retry is an explicit user action in the chat panel.
 *
 * Continuation: when the runtime provides `previousResponseId`, only the new
 * turn is sent. That id is provider-owned state, held in memory by
 * `chatRuntime` and never persisted or sent to a different provider. Providers
 * without an enabled continuation (DeepSeek, OpenRouter, an OpenAI base-URL
 * override that may be a proxy, or a custom endpoint) always receive the full
 * normalized history.
 */

import type {
  Response as OpenAIResponse,
  ResponseCreateParamsBase,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { ReasoningEffort as OpenAIReasoningEffort } from 'openai/resources/shared';
import { CHAT_MAX_TOKENS } from '../../config';
import { AIRequestError, describeError, isAbortError, isRetryable } from '../errors';
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

/** Stable, non-secret id for a replayed assistant turn on a stateless proxy. */
function replayMessageId(index: number, content: string): string {
  let hash = 2166136261;
  for (let cursor = 0; cursor < content.length; cursor += 1) {
    hash ^= content.charCodeAt(cursor);
    hash = Math.imul(hash, 16777619);
  }
  return `msg_lumieres_${index}_${(hash >>> 0).toString(36)}`;
}

/**
 * Normalized turns become plain Responses input items for OpenAI/DeepSeek.
 * OpenRouter's stateless proxy instead requires assistant history to be
 * replayed as output items with `id`/`status` and typed content parts.
 */
function buildInput(request: AdapterRequestBase): ResponseInput {
  if (!request.config.capabilities.requiresAssistantMessageMetadata) {
    return request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  }

  return request.messages.map((message, index): ResponseInputItem => {
    if (message.role === 'assistant') {
      return {
        type: 'message',
        role: 'assistant',
        id: replayMessageId(index, message.content),
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: message.content,
            annotations: [],
          },
        ],
      };
    }
    return {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: message.content }],
    };
  });
}

function buildRequest(request: AdapterRequestBase): ResponseCreateParamsBase {
  const params: ResponseCreateParamsBase = {
    model: request.config.model,
    instructions: request.system,
    input: buildInput(request),
    max_output_tokens: CHAT_MAX_TOKENS,
  };

  // Explicitly opt into provider-side storage only where continuation is a
  // supported capability. Responses are then retrievable by id for the next
  // turn; providers we treat as stateless keep their own defaults.
  if (request.config.continuationEnabled) {
    params.store = true;
    if (request.previousResponseId) {
      params.previous_response_id = request.previousResponseId;
    }
  }

  if (request.effort.value) {
    params.reasoning = { effort: request.effort.value as OpenAIReasoningEffort };
  }

  return params;
}

/**
 * Extracts assistant text from output items. `output_text` is an SDK
 * convenience; a raw REST response or a compatible proxy may provide only the
 * `output` array.
 */
function textFromOutput(output: readonly ResponseOutputItem[]): string {
  let text = '';
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block.type === 'output_text' && typeof block.text === 'string') text += block.text;
    }
  }
  return text;
}

function refusalFromOutput(output: readonly ResponseOutputItem[]): string {
  let refusal = '';
  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block.type === 'refusal' && typeof block.refusal === 'string') {
        refusal += block.refusal;
      }
    }
  }
  return refusal;
}

function responseError(response: OpenAIResponse): AIRequestError | null {
  if (response.status === 'failed') {
    const message = response.error?.message ?? 'The provider failed to finish the response.';
    return new AIRequestError(message, response.error?.code === 'rate_limit_exceeded');
  }
  if (response.incomplete_details?.reason === 'content_filter') {
    return new AIRequestError(
      'The model declined this request because of its content filter. Try rephrasing it.',
    );
  }
  if (response.error) {
    return new AIRequestError(
      typeof response.error.message === 'string' && response.error.message.length > 0
        ? response.error.message
        : 'The provider reported an error without a message.',
      false,
    );
  }
  return null;
}

function normalizeResult(
  response: OpenAIResponse | null,
  streamedText: string,
  refusal: string,
  includeResponseId: boolean,
): AdapterResult {
  if (refusal.length > 0) {
    throw new AIRequestError(
      'The model declined this request. Try rephrasing it or switch models in Settings.',
    );
  }
  const safeStreamedText = typeof streamedText === 'string' ? streamedText : '';
  if (response) {
    const error = responseError(response);
    // An incomplete response is allowed to keep its partial text: it is a real
    // answer cut off at the output limit, not a transport failure.
    if (error && response.incomplete_details?.reason !== 'max_output_tokens') throw error;

    // OpenRouter's prose `response.done` object is not guaranteed to carry the
    // SDK's convenience `output_text` field, so the streamed text is the
    // fallback whenever the final object omits or empties it.
    const outputText =
      typeof response.output_text === 'string' && response.output_text.length > 0
        ? response.output_text
        : Array.isArray(response.output)
          ? textFromOutput(response.output)
          : '';
    const text = outputText.trim().length > 0 ? outputText : safeStreamedText;
    if (text.trim().length === 0) {
      if (error) throw error;
      if (response.status === 'incomplete') {
        throw new AIRequestError(
          'The response was cut off before producing text. Raise the output limit or try a shorter prompt.',
        );
      }
    }
    return {
      text,
      stopReason: response.status === 'incomplete'
        ? `incomplete:${response.incomplete_details?.reason ?? 'unknown'}`
        : (response.status ?? 'completed'),
      responseId:
        includeResponseId && typeof response.id === 'string' && response.id.length > 0
          ? response.id
          : null,
      usage: {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      },
    };
  }

  return {
    text: safeStreamedText,
    stopReason: null,
    responseId: null,
  };
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

export const openAIResponsesAdapter: LLMAdapter = {
  protocol: 'openai-responses',

  async stream(request: AdapterStreamRequest): Promise<AdapterResult> {
    if (request.signal.aborted) throw new AIRequestError('Request stopped.', false);

    const client = await createClient(request.config);
    let text = '';
    let refusal = '';
    let final: OpenAIResponse | null = null;

    try {
      const stream = await client.responses.create(
        { ...buildRequest(request), stream: true },
        { signal: request.signal },
      );

      for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        switch (event.type) {
          case 'response.output_text.delta': {
            const delta = event.delta;
            if (typeof delta === 'string' && delta.length > 0) {
              text += delta;
              request.onText(delta, text);
            }
            break;
          }
          case 'response.refusal.delta':
            if (typeof event.delta === 'string') refusal += event.delta;
            break;
          case 'response.completed':
          case 'response.failed':
          case 'response.incomplete':
            final = event.response;
            break;
          case 'error':
            throw new AIRequestError(
              describeError(
                { status: null, message: event.message },
                {
                  secrets: [request.config.apiKey],
                  providerLabel: request.config.definition.label,
                },
              ),
              false,
            );
          default: {
            // OpenRouter's prose streaming docs use a different pair of names
            // from its OpenAPI schema (and the OpenAI SDK). Accept both so a
            // proxy cannot silently produce an empty response.
            const legacy = event as unknown as {
              type?: string;
              delta?: unknown;
              response?: OpenAIResponse;
            };
            if (legacy.type === 'response.content_part.delta') {
              if (typeof legacy.delta === 'string' && legacy.delta.length > 0) {
                text += legacy.delta;
                request.onText(legacy.delta, text);
              }
            } else if (legacy.type === 'response.done' && legacy.response) {
              final = legacy.response;
            }
            break;
          }
        }
      }
    } catch (error) {
      if (request.signal.aborted || isAbortError(error)) {
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

    if (refusal.length === 0 && final && Array.isArray(final.output)) {
      refusal = refusalFromOutput(final.output);
    }
    return normalizeResult(
      final,
      text,
      refusal,
      request.config.continuationEnabled,
    );
  },

  async generate(request: AdapterRequestBase): Promise<AdapterResult> {
    if (request.signal?.aborted) throw new AIRequestError('Request stopped.', false);
    const client = await createClient(request.config);

    try {
      const response = await client.responses.create(
        { ...buildRequest(request), stream: false },
        request.signal ? { signal: request.signal } : undefined,
      );
      return normalizeResult(
        response,
        response.output_text,
        Array.isArray(response.output) ? refusalFromOutput(response.output) : '',
        request.config.continuationEnabled,
      );
    } catch (error) {
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
  },
};
