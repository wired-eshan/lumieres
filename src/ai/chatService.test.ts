import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIRequestError, generateChat, streamChat } from './chatService';
import {
  PROVIDERS,
  type ProviderId,
  type ResolvedProviderConfig,
} from './provider';

const adapterMock = vi.hoisted(() => ({
  stream: vi.fn(),
  generate: vi.fn(),
  protocols: [] as string[],
}));

vi.mock('./adapters', () => ({
  adapterForProtocol: (protocol: string) => {
    adapterMock.protocols.push(protocol);
    return {
      protocol,
      stream: adapterMock.stream,
      generate: adapterMock.generate,
    };
  },
}));

function config(
  providerId: ProviderId = 'openai',
  overrides: Partial<ResolvedProviderConfig> = {},
): ResolvedProviderConfig {
  const definition = PROVIDERS[providerId];
  return {
    providerId,
    definition,
    capabilities: definition.capabilities,
    protocol: definition.protocol,
    apiKey: 'sk-test',
    baseUrl: overrides.baseUrl ?? definition.defaultBaseUrl,
    model: definition.defaultModel,
    reasoningEffort: '',
    effortCapability: null,
    continuationEnabled:
      definition.capabilities.supportsPreviousResponseId &&
      (providerId !== 'openai' ||
        (overrides.baseUrl ?? definition.defaultBaseUrl) === definition.defaultBaseUrl),
    ...overrides,
  };
}

function input(overrides: Partial<Parameters<typeof streamChat>[0]> = {}) {
  return {
    config: config(),
    system: 'Be useful.',
    messages: [{ role: 'user' as const, content: 'Hello' }],
    signal: new AbortController().signal,
    onText: () => undefined,
    ...overrides,
  };
}

const adapterResult = {
  text: 'Hello',
  stopReason: 'completed',
  responseId: 'resp_1',
};

beforeEach(() => {
  adapterMock.stream.mockReset();
  adapterMock.generate.mockReset();
  adapterMock.protocols.length = 0;
  adapterMock.stream.mockResolvedValue({ ...adapterResult });
  adapterMock.generate.mockResolvedValue({ ...adapterResult, responseId: null });
});

describe('chat transport dispatcher', () => {
  it('routes by protocol, never by a scattered provider check', async () => {
    await streamChat(input({ config: config('openai') }));
    await streamChat(input({ config: config('anthropic') }));
    await streamChat(
      input({
        config: config('custom', {
          protocol: 'openai-responses',
          baseUrl: 'https://proxy.example/v1',
          model: 'custom-responses',
        }),
      }),
    );
    await streamChat(
      input({
        config: config('custom', {
          protocol: 'openai-chat',
          baseUrl: 'https://proxy.example/v1',
          model: 'legacy',
        }),
      }),
    );

    expect(adapterMock.protocols).toEqual([
      'openai-responses',
      'anthropic-messages',
      'openai-responses',
      'openai-chat',
    ]);
  });

  it('passes a normalized request to the adapter and returns its effort decision', async () => {
    const result = await streamChat(input({ config: config('openai') }));

    expect(adapterMock.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          providerId: 'openai',
          model: PROVIDERS.openai.defaultModel,
        }),
        system: 'Be useful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    );
    expect(result.text).toBe('Hello');
    expect(result.effort).toMatchObject({ requested: '', value: null });
  });

  it('does not forward a continuation id to a stateless provider', async () => {
    await streamChat(
      input({
        config: config('deepseek'),
        previousResponseId: 'resp_must_not_be_sent',
      }),
    );

    const request = adapterMock.stream.mock.calls[0]?.[0] as {
      previousResponseId?: string;
    };
    expect(request.previousResponseId).toBeUndefined();
  });

  it('forwards a continuation id only for a capability that supports it', async () => {
    await streamChat(
      input({
        config: config('openai'),
        previousResponseId: 'resp_previous',
      }),
    );

    const request = adapterMock.stream.mock.calls[0]?.[0] as {
      previousResponseId?: string;
    };
    expect(request.previousResponseId).toBe('resp_previous');
  });

  it('maps the selected effort for the active provider, including DeepSeek aliases', async () => {
    const result = await streamChat(
      input({
        config: config('deepseek', {
          model: 'deepseek-flash',
          reasoningEffort: 'medium',
        }),
      }),
    );

    const request = adapterMock.stream.mock.calls[0]?.[0] as {
      effort: { value: string | null; mappedFrom?: string };
    };
    expect(request.effort.value).toBe('high');
    expect(request.effort.mappedFrom).toBe('medium');
    expect(result.effort.mappedFrom).toBe('medium');
  });

  it('omits an effort level Anthropic does not support rather than substituting one', async () => {
    const result = await streamChat(
      input({
        config: config('anthropic', { reasoningEffort: 'none' }),
      }),
    );

    const request = adapterMock.stream.mock.calls[0]?.[0] as {
      effort: { value: string | null; applied: boolean };
    };
    expect(request.effort.value).toBeNull();
    expect(request.effort.applied).toBe(false);
    expect(result.effort.note).toMatch(/not supported/i);
  });

  it('uses capability metadata saved with the profile', async () => {
    await streamChat(
      input({
        config: config('custom', {
          protocol: 'openai-responses',
          baseUrl: 'https://proxy.example/v1',
          model: 'acme-chat',
          reasoningEffort: 'medium',
          effortCapability: {
            modelId: 'acme-chat',
            efforts: ['low', 'high'],
            source: 'metadata',
            defaultEffort: 'low',
            mandatory: false,
            note: 'Catalogue metadata.',
          },
        }),
      }),
    );

    const request = adapterMock.stream.mock.calls[0]?.[0] as {
      effort: { value: string | null; applied: boolean };
    };
    expect(request.effort.value).toBeNull();
    expect(request.effort.applied).toBe(false);
  });

  it('refuses to call an adapter without a selected provider key', async () => {
    await expect(
      streamChat(input({ config: config('openai', { apiKey: '' }) })),
    ).rejects.toBeInstanceOf(AIRequestError);
    expect(adapterMock.stream).not.toHaveBeenCalled();
  });

  it('refuses an incomplete custom configuration with an actionable message', async () => {
    await expect(
      streamChat(
        input({
          config: config('custom', {
            baseUrl: '',
            model: '',
          }),
        }),
      ),
    ).rejects.toThrow(/model|base URL/i);
    expect(adapterMock.stream).not.toHaveBeenCalled();
  });

  it('normalizes adapter failures and never leaks the key', async () => {
    adapterMock.stream.mockRejectedValue(new Error('provider said sk-secret-987654'));

    let caught: unknown;
    try {
      await streamChat(
        input({ config: config('openai', { apiKey: 'sk-secret-987654' }) }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AIRequestError);
    expect((caught as Error).message).not.toContain('sk-secret-987654');
  });

  it('redacts an AIRequestError that an adapter already translated', async () => {
    adapterMock.stream.mockRejectedValue(
      new AIRequestError('provider rejected sk-secret-987654'),
    );

    let caught: unknown;
    try {
      await streamChat(
        input({ config: config('openai', { apiKey: 'sk-secret-987654' }) }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AIRequestError);
    expect((caught as Error).message).not.toContain('sk-secret-987654');
  });

  it('passes the request signal to the adapter for cancellation', async () => {
    const controller = new AbortController();
    await streamChat(input({ signal: controller.signal }));

    const request = adapterMock.stream.mock.calls[0]?.[0] as {
      signal: AbortSignal;
    };
    expect(request.signal).toBe(controller.signal);
  });

  it('turns an aborted adapter rejection into a stopped request', async () => {
    const controller = new AbortController();
    controller.abort();
    adapterMock.stream.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );

    await expect(
      streamChat(input({ signal: controller.signal })),
    ).rejects.toThrow('Request stopped.');
  });

  it('implements the non-streaming generate path through the same adapter choice', async () => {
    const result = await generateChat({
      config: config('anthropic'),
      system: 'Be useful.',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(adapterMock.protocols).toEqual(['anthropic-messages']);
    expect(result).toMatchObject({ text: 'Hello', effort: { requested: '' } });
  });
});
