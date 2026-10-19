import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  effortsForModel,
  fetchProviderModels,
  findProviderModel,
  isLikelyChatModel,
  parseProviderModels,
  pickModelId,
  type ProviderModel,
} from './models';
import { AIRequestError } from './errors';
import { inferReasoningEfforts, normalizeReasoningEffort, sortReasoningEfforts } from './reasoning';

const openaiMock = vi.hoisted(() => ({
  list: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    models = { list: openaiMock.list };

    constructor(options: Record<string, unknown>) {
      openaiMock.options.push(options);
    }
  },
}));

beforeEach(() => {
  openaiMock.list.mockReset();
  openaiMock.options.length = 0;
});

describe('provider model discovery', () => {
  it('parses the standard OpenAI /models shape and puts chat models first', () => {
    const models = parseProviderModels([
      { id: 'gpt-4o-mini', object: 'model', created: 1721172741, owned_by: 'system' },
      { id: 'text-embedding-3-small', object: 'model', created: 1705948997, owned_by: 'openai' },
      { id: 'gpt-4.1', object: 'model', created: 1744316542, owned_by: 'openai' },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      'gpt-4.1',
      'gpt-4o-mini',
      'text-embedding-3-small',
    ]);
    expect(models[0]).toEqual({
      id: 'gpt-4.1',
      ownedBy: 'openai',
      createdAt: 1744316542,
      reasoningEfforts: [],
      reasoningEffortSource: 'none',
    });
  });

  it('infers effort levels for known reasoning families when /models omits metadata', () => {
    const models = parseProviderModels([
      { id: 'gpt-5' },
      { id: 'gpt-5-mini' },
      { id: 'o3-mini' },
      { id: 'gpt-5-chat-latest' },
      { id: 'gpt-4o' },
    ]);
    const byId = new Map(models.map((model) => [model.id, model]));

    expect(byId.get('gpt-5')?.reasoningEffortSource).toBe('inferred');
    expect(byId.get('gpt-5')?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(byId.get('gpt-5-mini')?.reasoningEfforts).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    expect(byId.get('o3-mini')?.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(byId.get('gpt-5-chat-latest')?.reasoningEfforts).toEqual([]);
    expect(byId.get('gpt-4o')?.reasoningEfforts).toEqual([]);
  });

  it('reads OpenRouter-style supported_parameters', () => {
    const [model] = parseProviderModels([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        supported_parameters: ['temperature', 'reasoning_effort', 'max_tokens'],
      },
    ]);
    expect(model?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(model?.reasoningEffortSource).toBe('metadata');
  });

  it('reads explicit level lists at the top level and under capabilities', () => {
    const models = parseProviderModels([
      { id: 'custom-a', reasoning_efforts: ['low', 'high', 'not-a-level'] },
      { id: 'custom-b', capabilities: { reasoning_effort: { low: {}, high: {} } } },
      { id: 'custom-c', supported_parameters: ['reasoning_effort'] },
      { id: 'custom-d', reasoning: { supported_efforts: ['medium', 'high'] } },
      { id: 'custom-e', default_parameters: { reasoning_effort: 'medium' } },
    ]);
    const byId = new Map(models.map((model) => [model.id, model]));

    expect(byId.get('custom-a')?.reasoningEfforts).toEqual(['low', 'high']);
    expect(byId.get('custom-b')?.reasoningEfforts).toEqual(['low', 'high']);
    expect(byId.get('custom-c')?.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(byId.get('custom-d')?.reasoningEfforts).toEqual(['medium', 'high']);
    expect(byId.get('custom-d')?.reasoningEffortSource).toBe('metadata');
    expect(byId.get('custom-e')?.reasoningEfforts).toEqual(['low', 'medium', 'high']);
  });

  it('deduplicates repeated ids and skips malformed records', () => {
    const models = parseProviderModels([
      { id: 'same', owned_by: 'first' },
      { id: 'same', owned_by: 'second' },
      null,
      'not-a-model',
      { name: '' },
      { name: 'name-only' },
    ]);

    expect(models.map((model) => model.id)).toEqual(['name-only', 'same']);
    expect(findProviderModel(models, 'same')?.ownedBy).toBe('first');
  });

  it('falls back to family inference when the catalogue was not loaded', () => {
    const empty: ProviderModel[] = [];
    expect(effortsForModel(empty, 'o4-mini')).toEqual(['low', 'medium', 'high']);
    expect(effortsForModel(empty, 'llama-3.3-70b')).toEqual([]);
  });

  it('prefers a chat model when the saved model is not in the catalogue', () => {
    const models = parseProviderModels([
      { id: 'text-embedding-3-small' },
      { id: 'whisper-1' },
      { id: 'gpt-4o-mini' },
    ]);

    expect(isLikelyChatModel('gpt-4o-mini')).toBe(true);
    expect(isLikelyChatModel('text-embedding-3-small')).toBe(false);
    expect(isLikelyChatModel('whisper-1')).toBe(false);
    expect(pickModelId(models, 'not-listed')).toBe('gpt-4o-mini');
    expect(pickModelId(models, 'gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(pickModelId(models, 'whisper-1')).toBe('whisper-1');
  });

  it('fetches through the SDK with the configured base URL', async () => {
    openaiMock.list.mockResolvedValue({
      data: [{ id: 'gpt-5', created: 1, owned_by: 'openai' }],
      hasNextPage: () => false,
    });

    const models = await fetchProviderModels({
      apiKey: 'sk-test',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    expect(openaiMock.list).toHaveBeenCalledTimes(1);
    expect(openaiMock.options[0]).toMatchObject({
      apiKey: 'sk-test',
      baseURL: 'https://openrouter.ai/api/v1',
      dangerouslyAllowBrowser: true,
    });
    expect(models[0]?.reasoningEfforts).toContain('high');
  });

  it('requires a key before calling /models', async () => {
    await expect(
      fetchProviderModels({ apiKey: '  ', baseUrl: 'https://api.openai.com/v1' }),
    ).rejects.toBeInstanceOf(AIRequestError);
    expect(openaiMock.list).not.toHaveBeenCalled();
  });
});

describe('reasoning effort helpers', () => {
  it('normalises and orders levels', () => {
    expect(normalizeReasoningEffort('high')).toBe('high');
    expect(normalizeReasoningEffort('HIGH')).toBe('');
    expect(normalizeReasoningEffort('extreme')).toBe('');
    expect(normalizeReasoningEffort(undefined)).toBe('');
    expect(sortReasoningEfforts(['high', 'low', 'bogus', 'high', 'medium'])).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('does not infer support for arbitrary text', () => {
    expect(inferReasoningEfforts('gpt-3.5-turbo')).toEqual([]);
    expect(inferReasoningEfforts('o1')).toEqual(['low', 'medium', 'high']);
    expect(inferReasoningEfforts('audio-o3')).toEqual(['low', 'medium', 'high']);
  });
});
