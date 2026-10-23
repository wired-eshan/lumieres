import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIRequestError } from '../errors';
import { mapEffortForRequest } from '../effort';
import {
  PROVIDERS,
  type ResolvedProviderConfig,
} from '../provider';
import { openAIChatAdapter } from './openaiChat';
import type { AdapterRequestBase, AdapterStreamRequest } from './types';

const openaiMock = vi.hoisted(() => ({
  create: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: openaiMock.create } };

    constructor(options: Record<string, unknown>) {
      openaiMock.options.push(options);
    }
  },
}));

function config(overrides: Partial<ResolvedProviderConfig> = {}): ResolvedProviderConfig {
  const definition = PROVIDERS.custom;
  return {
    providerId: 'custom',
    definition,
    capabilities: definition.capabilities,
    protocol: 'openai-chat',
    apiKey: 'sk-test',
    baseUrl: 'https://proxy.example/v1',
    model: 'legacy-model',
    reasoningEffort: '',
    effortCapability: null,
    continuationEnabled: false,
    ...overrides,
  };
}

function requestBase(
  requestConfig: ResolvedProviderConfig,
  requested: Parameters<typeof mapEffortForRequest>[0]['requested'] = '',
): AdapterRequestBase {
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

function streamOf(...chunks: unknown[]): AsyncIterable<unknown> {
  return (async function* generate() {
    for (const chunk of chunks) yield chunk;
  })();
}

beforeEach(() => {
  openaiMock.create.mockReset();
  openaiMock.options.length = 0;
});

describe('legacy OpenAI Chat adapter', () => {
  it('uses the custom key and endpoint without hidden retries', async () => {
    openaiMock.create.mockResolvedValue(
      streamOf({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    );

    await openAIChatAdapter.stream(streamRequest(config()));

    expect(openaiMock.options[0]).toMatchObject({
      apiKey: 'sk-test',
      baseURL: 'https://proxy.example/v1',
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
    });
  });

  it('sends system and conversation turns in the Chat Completions shape', async () => {
    openaiMock.create.mockResolvedValue(
      streamOf({ choices: [{ delta: { content: 'ok' } }] }),
    );

    await openAIChatAdapter.stream(
      streamRequest(config(), requestBase(config(), 'low')),
    );

    const params = openaiMock.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: 'legacy-model',
      stream: true,
      messages: [
        { role: 'system', content: 'Be useful.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: expect.any(Number),
    });
    // Unknown custom model: effort cannot be verified, so it is omitted rather
    // than sent speculatively.
    expect(params).not.toHaveProperty('reasoning_effort');
    expect(params).not.toHaveProperty('input');
    expect(params).not.toHaveProperty('previous_response_id');
  });

  it('uses max_completion_tokens and sends effort for a recognised reasoning family', async () => {
    openaiMock.create.mockResolvedValue(
      streamOf({ choices: [{ delta: { content: 'ok' } }] }),
    );

    // A known reasoning family triggers the OpenAI-specific token parameter.
    await openAIChatAdapter.stream(
      streamRequest(config({ model: 'gpt-5' }), {
        ...requestBase(config({ model: 'gpt-5' }), 'high'),
      }),
    );

    const params = openaiMock.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.max_completion_tokens).toBeGreaterThan(0);
    expect(params).not.toHaveProperty('max_tokens');
    expect(params.reasoning_effort).toBe('high');
  });

  it('streams deltas and reports the finish reason', async () => {
    openaiMock.create.mockResolvedValue(
      streamOf(
        { choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      ),
    );

    const result = await openAIChatAdapter.stream(streamRequest(config()));
    expect(result).toEqual({ text: 'Hello', stopReason: 'stop', responseId: null });
  });

  it('turns a content filter into an actionable error', async () => {
    openaiMock.create.mockResolvedValue(
      streamOf({ choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] }),
    );
    await expect(
      openAIChatAdapter.stream(streamRequest(config())),
    ).rejects.toThrow(/content filter/i);
  });

  it('turns a refusal delta into an actionable error', async () => {
    openaiMock.create.mockResolvedValue(
      streamOf({ choices: [{ delta: { refusal: 'I cannot do that.' } }] }),
    );
    await expect(
      openAIChatAdapter.stream(streamRequest(config())),
    ).rejects.toThrow(/declined/i);
  });

  it('passes the signal to the SDK and maps a mid-stream abort to stopped', async () => {
    const controller = new AbortController();
    openaiMock.create.mockImplementation((_params, options) => {
      expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
      return (async function* generate() {
        yield { choices: [{ delta: { content: 'partial' } }] };
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
      })();
    });

    await expect(
      openAIChatAdapter.stream(
        streamRequest(config(), { signal: controller.signal }),
      ),
    ).rejects.toThrow('Request stopped.');
  });

  it('redacts a key echoed by a provider error', async () => {
    openaiMock.create.mockRejectedValue({
      status: 401,
      message: 'bad key sk-test-secret-123456',
    });

    let caught: unknown;
    try {
      await openAIChatAdapter.stream(
        streamRequest(config({ apiKey: 'sk-test-secret-123456' })),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AIRequestError);
    expect((caught as Error).message).not.toContain('sk-test-secret-123456');
  });

  it('implements generate without streaming', async () => {
    openaiMock.create.mockResolvedValue({
      choices: [{ message: { content: 'Generated' }, finish_reason: 'stop' }],
    });

    const result = await openAIChatAdapter.generate(requestBase(config()));
    expect(result).toMatchObject({ text: 'Generated', stopReason: 'stop' });
    const params = openaiMock.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.stream).toBe(false);
  });
});
