import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIRequestError } from '../errors';
import { mapEffortForRequest } from '../effort';
import {
  PROVIDERS,
  type ProviderId,
  type ResolvedProviderConfig,
} from '../provider';
import { openAIResponsesAdapter } from './openaiResponses';
import type { AdapterStreamRequest } from './types';

const openaiMock = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: openaiMock.responsesCreate };

    constructor(options: Record<string, unknown>) {
      openaiMock.options.push(options);
    }
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

function effort(value: ReturnType<typeof mapEffortForRequest>) {
  return value;
}

function generateRequest(requestConfig: ResolvedProviderConfig, requested: Parameters<typeof mapEffortForRequest>[0]['requested'] = '') {
  return {
    config: requestConfig,
    effort: effort(
      mapEffortForRequest({
        providerId: requestConfig.providerId,
        protocol: requestConfig.protocol,
        modelId: requestConfig.model,
        requested,
        stored: requestConfig.effortCapability,
      }),
    ),
    system: 'Be useful.',
    messages: [{ role: 'user' as const, content: 'Hello' }],
  };
}

function streamRequest(
  requestConfig: ResolvedProviderConfig,
  overrides: Partial<AdapterStreamRequest> = {},
): AdapterStreamRequest {
  return {
    ...generateRequest(requestConfig),
    signal: new AbortController().signal,
    onText: () => undefined,
    ...overrides,
  };
}

function streamOf(...events: unknown[]): AsyncIterable<unknown> {
  return (async function* generate() {
    for (const event of events) yield event;
  })();
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_1',
    output_text: 'Hello',
    output: [],
    status: 'completed',
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

beforeEach(() => {
  openaiMock.responsesCreate.mockReset();
  openaiMock.options.length = 0;
});

describe('OpenAI Responses adapter', () => {
  it('creates the SDK with the selected key, endpoint and no hidden retries', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf(
        { type: 'response.output_text.delta', delta: 'Hi' },
        { type: 'response.completed', response: response({ output_text: 'Hi' }) },
      ),
    );

    await openAIResponsesAdapter.stream(streamRequest(config()));

    expect(openaiMock.options[0]).toMatchObject({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
    });
  });

  it('sends the configured custom base URL, not the registry default', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({ type: 'response.completed', response: response({ output_text: 'ok' }) }),
    );

    await openAIResponsesAdapter.stream(
      streamRequest(config('openai', { baseUrl: 'https://gateway.example/v1' })),
    );

    expect(openaiMock.options[0]).toMatchObject({
      apiKey: 'sk-test',
      baseURL: 'https://gateway.example/v1',
    });
    const params = openaiMock.responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    // A proxy override is stateless: no provider-side storage or continuation.
    expect(params).not.toHaveProperty('store');
    expect(params).not.toHaveProperty('previous_response_id');
  });

  it('sends model, system instructions, history, output cap and effort', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({ type: 'response.completed', response: response({ output_text: 'ok' }) }),
    );

    await openAIResponsesAdapter.stream(
      streamRequest(config('openai', { model: 'gpt-5.2' }), {
        ...generateRequest(config('openai', { model: 'gpt-5.2' }), 'high'),
      }),
    );

    const params = openaiMock.responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: 'gpt-5.2',
      instructions: 'Be useful.',
      input: [{ role: 'user', content: 'Hello' }],
      max_output_tokens: expect.any(Number),
      store: true,
      reasoning: { effort: 'high' },
    });
    expect(params).not.toHaveProperty('previous_response_id');
  });

  it('streams text deltas and returns the final text, id and usage', async () => {
    const deltas: string[] = [];
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf(
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        {
          type: 'response.completed',
          response: response({ output_text: 'Hello', id: 'resp_42' }),
        },
      ),
    );

    const result = await openAIResponsesAdapter.stream(
      streamRequest(config(), {
        onText: (delta) => deltas.push(delta),
      }),
    );

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({
      text: 'Hello',
      stopReason: 'completed',
      responseId: 'resp_42',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('uses response.output_text when a provider does not emit deltas', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({
        type: 'response.completed',
        response: response({ output_text: 'Complete answer' }),
      }),
    );

    const result = await openAIResponsesAdapter.stream(streamRequest(config()));
    expect(result.text).toBe('Complete answer');
  });

  it('sends previous_response_id only when the config supplies one', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({ type: 'response.completed', response: response({ output_text: 'ok' }) }),
    );

    await openAIResponsesAdapter.stream(
      streamRequest(config(), {
        previousResponseId: 'resp_previous',
        messages: [{ role: 'user', content: 'next' }],
      }),
    );

    const params = openaiMock.responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({ previous_response_id: 'resp_previous' });
    expect(params.input).toEqual([{ role: 'user', content: 'next' }]);
  });

  it('does not store or continue for a stateless Responses provider', async () => {
    const deepseek = config('deepseek', { model: 'deepseek-flash' });
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({ type: 'response.completed', response: response({ output_text: 'ok' }) }),
    );

    await openAIResponsesAdapter.stream(
      streamRequest(deepseek, {
        previousResponseId: 'resp_must_not_be_sent',
        messages: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'one answer' },
          { role: 'user', content: 'two' },
        ],
      }),
    );

    const params = openaiMock.responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('previous_response_id');
    expect(params).not.toHaveProperty('store');
    expect(params.input).toHaveLength(3);
  });

  it('replays OpenRouter assistant history as output items with id and status', async () => {
    const openrouter = config('openrouter', { model: 'openai/gpt-4o-mini' });
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({ type: 'response.completed', response: response({ output_text: 'ok' }) }),
    );

    await openAIResponsesAdapter.stream(
      streamRequest(openrouter, {
        messages: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'one answer' },
          { role: 'user', content: 'two' },
        ],
      }),
    );

    const params = openaiMock.responsesCreate.mock.calls[0]?.[0] as {
      input: Array<Record<string, unknown>>;
      store?: unknown;
      previous_response_id?: unknown;
    };
    expect(params.input[0]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'one' }],
    });
    expect(params.input[1]).toMatchObject({
      type: 'message',
      role: 'assistant',
      id: expect.stringMatching(/^msg_lumieres_/),
      status: 'completed',
      content: [
        { type: 'output_text', text: 'one answer', annotations: [] },
      ],
    });
    expect(params.input[2]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'two' }],
    });
    expect(params).not.toHaveProperty('store');
    expect(params).not.toHaveProperty('previous_response_id');
  });

  it('accepts OpenRouter’s prose response.content_part.delta / response.done names', async () => {
    const deltas: string[] = [];
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf(
        { type: 'response.content_part.delta', delta: 'Hel' },
        { type: 'response.content_part.delta', delta: 'lo' },
        {
          type: 'response.done',
          // This prose-shaped object is not guaranteed to carry output_text.
          response: { id: 'resp_openrouter', status: 'completed' },
        },
      ),
    );

    const result = await openAIResponsesAdapter.stream(
      streamRequest(config('openrouter', { model: 'openai/gpt-4o-mini' }), {
        onText: (delta) => deltas.push(delta),
      }),
    );

    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({
      text: 'Hello',
      stopReason: 'completed',
      // OpenRouter is stateless and does not support continuation ids.
      responseId: null,
    });
  });

  it('keeps partial text from an output-limit incomplete response', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf(
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.incomplete',
          response: response({
            output_text: 'partial',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          }),
        },
      ),
    );

    const result = await openAIResponsesAdapter.stream(streamRequest(config()));
    expect(result).toMatchObject({
      text: 'partial',
      stopReason: 'incomplete:max_output_tokens',
    });
  });

  it('surfaces a failed response with its provider message', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({
        type: 'response.failed',
        response: response({
          status: 'failed',
          output_text: '',
          error: { code: 'server_error', message: 'The model failed.' },
        }),
      }),
    );

    await expect(openAIResponsesAdapter.stream(streamRequest(config()))).rejects.toThrow(
      'The model failed.',
    );
  });

  it('surfaces an SSE error event', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({ type: 'error', message: 'upstream exploded' }),
    );

    await expect(openAIResponsesAdapter.stream(streamRequest(config()))).rejects.toThrow(
      'upstream exploded',
    );
  });

  it('rejects an incomplete response that produced no text', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({
        type: 'response.incomplete',
        response: response({
          output_text: '',
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      }),
    );

    await expect(openAIResponsesAdapter.stream(streamRequest(config()))).rejects.toThrow(
      /cut off/i,
    );
  });

  it('passes the signal to the SDK and maps a mid-stream abort to stopped', async () => {
    const controller = new AbortController();
    openaiMock.responsesCreate.mockImplementation(async (_params, options) => {
      expect((options as { signal?: AbortSignal }).signal).toBe(controller.signal);
      return (async function* generate() {
        yield { type: 'response.output_text.delta', delta: 'partial' };
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
      })();
    });

    await expect(
      openAIResponsesAdapter.stream(
        streamRequest(config(), { signal: controller.signal }),
      ),
    ).rejects.toThrow('Request stopped.');
  });

  it('turns a refusal into an actionable error', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      streamOf({ type: 'response.refusal.delta', delta: 'I cannot help with that.' }),
    );

    await expect(openAIResponsesAdapter.stream(streamRequest(config()))).rejects.toThrow(
      /declined/i,
    );
  });

  it('redacts the API key from provider errors', async () => {
    openaiMock.responsesCreate.mockRejectedValue({
      status: 401,
      message: 'Incorrect API key provided: sk-secret-123456',
    });

    let caught: unknown;
    try {
      await openAIResponsesAdapter.stream(
        streamRequest(config('openai', { apiKey: 'sk-secret-123456' })),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AIRequestError);
    expect((caught as Error).message).not.toContain('sk-secret-123456');
    expect((caught as Error).message).toContain('rejected');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openAIResponsesAdapter.stream(
        streamRequest(config(), { signal: controller.signal }),
      ),
    ).rejects.toThrow('Request stopped.');
    expect(openaiMock.responsesCreate).not.toHaveBeenCalled();
  });

  it('implements the non-streaming generate path with response.output_text', async () => {
    openaiMock.responsesCreate.mockResolvedValue(response({ output_text: 'Generated' }));

    const result = await openAIResponsesAdapter.generate(generateRequest(config()));
    expect(result).toMatchObject({ text: 'Generated', stopReason: 'completed' });
    const params = openaiMock.responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.stream).toBe(false);
  });

  it('reads text from output items when a raw response omits output_text', async () => {
    openaiMock.responsesCreate.mockResolvedValue(
      response({
        output_text: undefined,
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'From output', annotations: [] },
            ],
          },
        ],
      }),
    );

    const result = await openAIResponsesAdapter.generate(generateRequest(config()));
    expect(result.text).toBe('From output');
  });

});
