import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIRequestError } from '../errors';
import { mapEffortForRequest } from '../effort';
import {
  PROVIDERS,
  type ProviderId,
  type ResolvedProviderConfig,
} from '../provider';
import { anthropicMessagesAdapter } from './anthropicMessages';
import type { AdapterRequestBase, AdapterStreamRequest } from './types';

const anthropicMock = vi.hoisted(() => ({
  stream: vi.fn(),
  create: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { stream: anthropicMock.stream, create: anthropicMock.create };

    constructor(options: Record<string, unknown>) {
      anthropicMock.options.push(options);
    }
  },
}));

function config(
  providerId: ProviderId = 'anthropic',
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  const definition = PROVIDERS[providerId];
  return {
    providerId,
    definition,
    capabilities: definition.capabilities,
    protocol: 'anthropic-messages',
    apiKey: 'sk-ant-test',
    baseUrl: definition.defaultBaseUrl || 'https://api.anthropic.com',
    model: definition.defaultModel || 'claude-opus-5-5',
    reasoningEffort: '',
    effortCapability: null,
    continuationEnabled: false,
    ...overrides,
  };
}

function requestBase(
  requestConfig: ResolvedProviderConfig,
  requested: Parameters<typeof mapEffortForRequest>[0]['requested'] = '',
): AdapterRequestBase & { messages: AdapterRequestBase['messages'] } {
  return {
    config: requestConfig,
    effort: mapEffortForRequest({
      providerId: requestConfig.providerId,
      protocol: requestConfig.protocol,
      modelId: requestConfig.model,
      requested,
      stored: requestConfig.effortCapability,
    }),
    system: 'Be useful.',
    messages: [{ role: 'user', content: 'Hello' }],
  };
}

function streamRequest(
  requestConfig: ResolvedProviderConfig,
  overrides: Partial<AdapterStreamRequest> = {},
): AdapterStreamRequest {
  return {
    ...requestBase(requestConfig),
    signal: new AbortController().signal,
    onText: () => undefined,
    ...overrides,
  };
}

function finalMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'msg_1',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

function mockStream(events: unknown[], final: Record<string, unknown> = finalMessage()) {
  const iterator = (async function* generate() {
    for (const event of events) yield event;
  })();
  return Object.assign(iterator, {
    finalMessage: async () => final,
  });
}

beforeEach(() => {
  anthropicMock.stream.mockReset();
  anthropicMock.create.mockReset();
  anthropicMock.options.length = 0;
});

describe('Anthropic Messages adapter', () => {
  it('creates the SDK with the Anthropic key, endpoint and no hidden retries', async () => {
    anthropicMock.stream.mockReturnValue(
      mockStream([
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      ]),
    );

    await anthropicMessagesAdapter.stream(streamRequest(config()));

    expect(anthropicMock.options[0]).toMatchObject({
      apiKey: 'sk-ant-test',
      baseURL: 'https://api.anthropic.com',
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
    });
  });

  it('sends the configured custom base URL, not the registry default', async () => {
    anthropicMock.stream.mockReturnValue(mockStream([]));

    await anthropicMessagesAdapter.stream(
      streamRequest(config('anthropic', { baseUrl: 'https://gateway.example' })),
    );

    expect(anthropicMock.options[0]).toMatchObject({
      apiKey: 'sk-ant-test',
      baseURL: 'https://gateway.example',
    });
  });

  it('sends the Anthropic request shape, not an OpenAI Responses shape', async () => {
    anthropicMock.stream.mockReturnValue(mockStream([]));

    await anthropicMessagesAdapter.stream(
      streamRequest(config(), requestBase(config(), 'high')),
    );

    const params = anthropicMock.stream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: expect.any(Number),
      system: 'Be useful.',
      messages: [{ role: 'user', content: 'Hello' }],
      output_config: { effort: 'high' },
    });
    expect(params).not.toHaveProperty('input');
    expect(params).not.toHaveProperty('instructions');
    expect(params).not.toHaveProperty('reasoning');
    expect(params).not.toHaveProperty('previous_response_id');
  });

  it('omits output_config when the selected level is unsupported', async () => {
    anthropicMock.stream.mockReturnValue(mockStream([]));

    await anthropicMessagesAdapter.stream(
      streamRequest(config(), requestBase(config(), 'none')),
    );

    const params = anthropicMock.stream.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('output_config');
  });

  it('streams text deltas and reads the final message', async () => {
    const deltas: string[] = [];
    anthropicMock.stream.mockReturnValue(
      mockStream(
        [
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ],
        finalMessage({ content: [{ type: 'text', text: 'Hello' }] }),
      ),
    );

    const result = await anthropicMessagesAdapter.stream(
      streamRequest(config(), { onText: (delta) => deltas.push(delta) }),
    );

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({
      text: 'Hello',
      stopReason: 'end_turn',
      responseId: null,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('turns a refusal stop reason into an actionable error', async () => {
    anthropicMock.stream.mockReturnValue(
      mockStream([], finalMessage({ stop_reason: 'refusal', content: [] })),
    );

    await expect(
      anthropicMessagesAdapter.stream(streamRequest(config())),
    ).rejects.toThrow(/declined/i);
  });

  it('keeps partial text when the reply hits max_tokens', async () => {
    anthropicMock.stream.mockReturnValue(
      mockStream([], finalMessage({ stop_reason: 'max_tokens' })),
    );

    const result = await anthropicMessagesAdapter.stream(streamRequest(config()));
    expect(result).toMatchObject({ text: 'Hello', stopReason: 'max_tokens' });
  });

  it('rejects an empty max_tokens response with an actionable message', async () => {
    anthropicMock.stream.mockReturnValue(
      mockStream([], finalMessage({ stop_reason: 'max_tokens', content: [] })),
    );

    await expect(
      anthropicMessagesAdapter.stream(streamRequest(config())),
    ).rejects.toThrow(/output limit/i);
  });

  it('redacts the key from an Anthropic error', async () => {
    anthropicMock.stream.mockImplementation(() => {
      throw { status: 401, message: 'authentication_error: bad key sk-ant-secret-999999' };
    });

    let caught: unknown;
    try {
      await anthropicMessagesAdapter.stream(
        streamRequest(config('anthropic', { apiKey: 'sk-ant-secret-999999' })),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AIRequestError);
    expect((caught as Error).message).not.toContain('sk-ant-secret-999999');
    expect((caught as Error).message).toContain('rejected');
  });

  it('passes the signal to the SDK and maps a mid-stream abort to stopped', async () => {
    const controller = new AbortController();
    anthropicMock.stream.mockImplementation((_params, options) => {
      expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
      const iterator = (async function* generate() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } };
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
      })();
      return Object.assign(iterator, { finalMessage: async () => finalMessage() });
    });

    await expect(
      anthropicMessagesAdapter.stream(
        streamRequest(config(), { signal: controller.signal }),
      ),
    ).rejects.toThrow('Request stopped.');
  });

  it('rejects before calling the SDK when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      anthropicMessagesAdapter.stream(
        streamRequest(config(), { signal: controller.signal }),
      ),
    ).rejects.toThrow('Request stopped.');
    expect(anthropicMock.stream).not.toHaveBeenCalled();
  });

  it('implements the non-streaming generate path', async () => {
    anthropicMock.create.mockResolvedValue(finalMessage({ content: [{ type: 'text', text: 'Generated' }] }));

    const result = await anthropicMessagesAdapter.generate(requestBase(config()));
    expect(result).toMatchObject({ text: 'Generated', stopReason: 'end_turn' });
    const params = anthropicMock.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.stream).toBe(false);
  });
});
