import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIRequestError,
  CHAT_MAX_TOKENS,
  describeError,
  streamChat,
  type StreamChatInput,
} from './chatService';

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

beforeEach(() => {
  openaiMock.create.mockReset();
  openaiMock.options.length = 0;
});

function input(overrides: Partial<StreamChatInput> = {}): StreamChatInput {
  return {
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    reasoningEffort: '',
    system: 'Be useful.',
    messages: [{ role: 'user', content: 'Hello' }],
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

describe('OpenAI chat transport', () => {
  it('streams deltas and sends the configured provider, model and effort', async () => {
    openaiMock.create.mockResolvedValue(
      streamOf(
        { choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
        { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      ),
    );
    const deltas: string[] = [];

    const result = await streamChat(
      input({
        model: 'o3-mini',
        reasoningEffort: 'high',
        onText: (delta) => deltas.push(delta),
      }),
    );

    expect(result).toEqual({ text: 'Hello', stopReason: 'stop' });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(openaiMock.options[0]).toMatchObject({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      dangerouslyAllowBrowser: true,
    });

    const params = openaiMock.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: 'o3-mini',
      stream: true,
      reasoning_effort: 'high',
      max_completion_tokens: CHAT_MAX_TOKENS,
      messages: [
        { role: 'system', content: 'Be useful.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(params).not.toHaveProperty('max_tokens');
  });

  it('uses max_tokens and omits effort for non-reasoning models', async () => {
    openaiMock.create.mockResolvedValue(streamOf({ choices: [{ delta: { content: 'ok' } }] }));

    await streamChat(input());

    const params = openaiMock.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(params.max_tokens).toBe(CHAT_MAX_TOKENS);
    expect(params).not.toHaveProperty('max_completion_tokens');
    expect(params).not.toHaveProperty('reasoning_effort');
  });

  it('turns a content-filter finish into an actionable error', async () => {
    openaiMock.create.mockResolvedValue(
      streamOf({ choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] }),
    );

    await expect(streamChat(input())).rejects.toThrow(/content filter/i);
  });

  it('keeps a partial stream when the user aborts', async () => {
    const controller = new AbortController();
    openaiMock.create.mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'APIUserAbortError' });
    });

    await expect(
      streamChat(input({ signal: controller.signal })),
    ).rejects.toMatchObject({ message: 'Request stopped.' });
  });
});

describe('AI error messages', () => {
  it('maps provider statuses to actionable messages', () => {
    expect(describeError({ status: 401 })).toContain('key was rejected');
    expect(describeError({ status: 403 })).toContain('permission');
    expect(describeError({ status: 404 })).toContain('model or endpoint was not found');
    expect(describeError({ status: 429 })).toContain('Rate limited');
    expect(describeError({ status: 400, message: 'bad params' })).toContain('bad params');
  });

  it('recognises connection failures', () => {
    const error = new Error('offline');
    error.name = 'APIConnectionError';
    expect(describeError(error)).toContain('Could not reach the AI provider');
  });

  it('reads a nested provider error body', () => {
    expect(describeError({ status: 400, error: { message: 'unsupported parameter' } })).toContain(
      'unsupported parameter',
    );
    expect(describeError({ status: 500 })).toContain('server error');
  });

  it('passes through its own request errors', () => {
    expect(describeError(new AIRequestError('declined', false))).toBe('declined');
  });

  it('never throws on unknown values', () => {
    expect(describeError(null)).toBe('The request failed for an unknown reason.');
    expect(describeError('weird')).toBe('The request failed for an unknown reason.');
  });
});
