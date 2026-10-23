/**
 * Anthropic Messages adapter.
 *
 * Anthropic is **not** routed through the OpenAI Responses API. It has a native
 * request/stream shape (`POST /v1/messages`) and its own effort parameter:
 * `output_config.effort` with low/medium/high/xhigh/max. There is no `none` or
 * `minimal`, so those levels are reported as unsupported by the effort layer
 * rather than being translated into something the user did not choose.
 *
 * The SDK appends `/v1/messages` to the configured base URL; `provider.ts`
 * normalises a pasted full endpoint so it is not duplicated.
 *
 * Browser use is an intentional BYOK trade-off: this app has no backend, so the
 * user's key is in the page. `dangerouslyAllowBrowser` acknowledges that, and
 * the settings dialog warns that anyone with access to the browser profile can
 * read the key. The key is passed only to the configured Anthropic endpoint.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageCreateParamsBase,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages';
import { CHAT_MAX_TOKENS } from '../../config';
import { AIRequestError, describeError, isAbortError, isRetryable } from '../errors';
import type {
  AdapterRequestBase,
  AdapterResult,
  AdapterStreamRequest,
  LLMAdapter,
} from './types';

type AnthropicClient = InstanceType<typeof Anthropic>;

async function loadAnthropic(): Promise<typeof Anthropic> {
  try {
    return (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new AIRequestError(
      'The Anthropic transport could not be loaded. Check the connection and try again.',
      true,
    );
  }
}

async function createClient(config: AdapterRequestBase['config']): Promise<AnthropicClient> {
  const AnthropicSdk = await loadAnthropic();
  return new AnthropicSdk({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });
}

function toMessages(messages: AdapterRequestBase['messages']): MessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function buildRequest(request: AdapterRequestBase): MessageCreateParamsBase {
  const params: MessageCreateParamsBase = {
    model: request.config.model,
    max_tokens: CHAT_MAX_TOKENS,
    system: request.system,
    messages: toMessages(request.messages),
  };

  if (request.effort.value) {
    params.output_config = {
      effort: request.effort.value as NonNullable<
        MessageCreateParamsBase['output_config']
      >['effort'],
    };
  }
  return params;
}

function textFromMessage(message: Message): string {
  let text = '';
  if (!Array.isArray(message.content)) return text;
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
  }
  return text;
}

function resultFromMessage(message: Message, streamedText: string): AdapterResult {
  if (message.stop_reason === 'refusal') {
    throw new AIRequestError(
      'The model declined this request. Try rephrasing it or switch models in Settings.',
    );
  }

  const safeStreamedText = typeof streamedText === 'string' ? streamedText : '';
  const text = textFromMessage(message) || safeStreamedText;
  if (message.stop_reason === 'max_tokens' && text.trim().length === 0) {
    throw new AIRequestError(
      'The response reached the output limit before producing text. Raise the limit or try a shorter prompt.',
    );
  }

  return {
    text,
    // Preserve the provider's reason so a caller can distinguish a complete
    // answer from one cut off at max_tokens.
    stopReason: message.stop_reason ?? null,
    // Anthropic Messages is stateless; the app always sends normalized history.
    responseId: null,
    usage: {
      inputTokens: message.usage?.input_tokens ?? null,
      outputTokens: message.usage?.output_tokens ?? null,
    },
  };
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

export const anthropicMessagesAdapter: LLMAdapter = {
  protocol: 'anthropic-messages',

  async stream(request: AdapterStreamRequest): Promise<AdapterResult> {
    if (request.signal.aborted) throw new AIRequestError('Request stopped.', false);
    const client = await createClient(request.config);

    let text = '';

    try {
      const stream = client.messages.stream(
        { ...buildRequest(request), stream: true } as MessageCreateParamsStreaming,
        { signal: request.signal },
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const delta = event.delta.text;
          if (delta.length > 0) {
            text += delta;
            request.onText(delta, text);
          }
        }
      }

      const final = await stream.finalMessage();
      return resultFromMessage(final, text);
    } catch (error) {
      handleFailure(error, request);
    }
  },

  async generate(request: AdapterRequestBase): Promise<AdapterResult> {
    if (request.signal?.aborted) throw new AIRequestError('Request stopped.', false);
    const client = await createClient(request.config);

    try {
      const message = await client.messages.create(
        { ...buildRequest(request), stream: false } as MessageCreateParamsNonStreaming,
        request.signal ? { signal: request.signal } : undefined,
      );
      return resultFromMessage(message, '');
    } catch (error) {
      handleFailure(error, request);
    }
  },
};
