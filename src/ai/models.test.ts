import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProviderEffortMetadata,
  effortCapabilityForModel,
  effortsForModel,
  enrichWithOpenRouterMetadata,
  fetchOpenRouterModels,
  fetchProviderModels,
  findProviderModel,
  isLikelyChatModel,
  parseAnthropicModel,
  parseOpenRouterModels,
  parseProviderModels,
  pickModelId,
  seedProviderModels,
  type ProviderModel,
} from './models';
import { AIRequestError } from './errors';
import { OPENROUTER_MODELS_URL, PROVIDERS } from './provider';
import { inferReasoningEfforts, normalizeReasoningEffort, sortReasoningEfforts } from './reasoning';

const openaiMock = vi.hoisted(() => ({
  list: vi.fn(),
  options: [] as Array<Record<string, unknown>>,
}));

const anthropicMock = vi.hoisted(() => ({
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

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    models = { list: anthropicMock.list };

    constructor(options: Record<string, unknown>) {
      anthropicMock.options.push(options);
    }
  },
}));

const OPENROUTER_SAMPLE = [
  {
    id: 'openai/gpt-5',
    name: 'OpenAI: GPT-5',
    created: 1,
    context_length: 400_000,
    supported_parameters: ['reasoning_effort', 'max_tokens'],
    reasoning: {
      mandatory: true,
      supported_efforts: ['high', 'medium', 'low', 'minimal'],
      default_effort: 'medium',
    },
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Anthropic: Claude Sonnet 5.5',
    created: 2,
    context_length: 1_000_000,
    supported_parameters: ['reasoning_effort'],
    reasoning: {
      mandatory: true,
      supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'],
      default_effort: 'high',
    },
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'OpenAI: GPT-4o-mini',
    created: 3,
    context_length: 128_000,
    supported_parameters: ['max_tokens'],
    reasoning: null,
  },
  {
    id: 'acme/flex',
    name: 'Acme Flex',
    created: 4,
    supported_parameters: ['reasoning_effort'],
    reasoning: { supported_efforts: null, default_enabled: true },
  },
  {
    id: 'acme/no-selector',
    name: 'Acme No Selector',
    supported_parameters: ['reasoning_effort'],
    reasoning: { mandatory: false },
  },
  {
    id: 'acme/mandatory',
    name: 'Acme Mandatory',
    supported_parameters: ['reasoning_effort'],
    reasoning: {
      mandatory: true,
      supported_efforts: ['none', 'low', 'high'],
      default_effort: 'none',
    },
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  openaiMock.list.mockReset();
  openaiMock.options.length = 0;
  anthropicMock.list.mockReset();
  anthropicMock.options.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouter model catalogue', () => {
  it('reads supported_efforts, defaults and mandatory reasoning', () => {
    const models = parseOpenRouterModels(OPENROUTER_SAMPLE);
    const byId = new Map(models.map((model) => [model.id, model]));

    expect(byId.get('openai/gpt-5')).toMatchObject({
      name: 'OpenAI: GPT-5',
      contextLength: 400_000,
      reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
      reasoningEffortSource: 'metadata',
      defaultReasoningEffort: 'medium',
      reasoningMandatory: true,
    });

    expect(byId.get('anthropic/claude-sonnet-5.5')?.reasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);

    // A model with no `reasoning` object has no effort selector, even when the
    // provider's generic `supported_parameters` mentions `reasoning_effort`.
    expect(byId.get('openai/gpt-4o-mini')).toMatchObject({
      reasoningEfforts: [],
      reasoningEffortSource: 'none',
      reasoningMandatory: false,
    });
    expect(byId.get('acme/no-selector')?.reasoningEfforts).toEqual([]);

    // `supported_efforts: null` means every gateway level is accepted.
    expect(byId.get('acme/flex')?.reasoningEfforts).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('never offers `none` when reasoning is mandatory', () => {
    const [model] = parseOpenRouterModels([
      {
        id: 'acme/mandatory',
        reasoning: {
          mandatory: true,
          supported_efforts: ['none', 'low', 'high'],
          default_effort: 'none',
        },
      },
    ]);

    expect(model?.reasoningEfforts).toEqual(['low', 'high']);
    expect(model?.defaultReasoningEffort).toBe('');
  });

  it('puts chat models first and keeps all catalogue entries', () => {
    const models = parseOpenRouterModels([
      ...OPENROUTER_SAMPLE,
      { id: 'openai/text-embedding-3-small', reasoning: null },
    ]);

    expect(models.map((model) => model.id)).toEqual([
      'acme/flex',
      'acme/mandatory',
      'acme/no-selector',
      'anthropic/claude-sonnet-5.5',
      'openai/gpt-4o-mini',
      'openai/gpt-5',
      'openai/text-embedding-3-small',
    ]);
  });

  it('fetches the public OpenRouter endpoint without sending a key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: OPENROUTER_SAMPLE }));

    const models = await fetchOpenRouterModels({ fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      OPENROUTER_MODELS_URL,
      expect.objectContaining({ method: 'GET' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toEqual({ Accept: 'application/json' });
    expect(init?.headers).not.toHaveProperty('Authorization');
    expect(models).toHaveLength(OPENROUTER_SAMPLE.length);
  });

  it('reports catalogue HTTP failures with an actionable message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 429));

    await expect(fetchOpenRouterModels({ fetchImpl: fetchMock })).rejects.toMatchObject({
      name: 'AIRequestError',
      retryable: true,
    });
  });
});

describe('custom provider model discovery', () => {
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
      name: null,
      ownedBy: 'openai',
      createdAt: 1744316542,
      contextLength: null,
      reasoningEfforts: [],
      reasoningEffortSource: 'none',
      defaultReasoningEffort: '',
      reasoningMandatory: false,
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
    expect(byId.get('custom-e')?.defaultReasoningEffort).toBe('medium');
  });

  it('does not widen an explicit effort list with family inference', () => {
    const [model] = parseProviderModels([
      { id: 'gpt-5', reasoning_efforts: ['low', 'high'] },
    ]);
    expect(model?.reasoningEfforts).toEqual(['low', 'high']);
    expect(model?.reasoningEffortSource).toBe('metadata');

    const applied = applyProviderEffortMetadata(
      model ? [model] : [],
      'custom',
      'openai-responses',
    );
    expect(applied[0]?.reasoningEfforts).toEqual(['low', 'high']);
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

  it('enriches provider ids with OpenRouter effort metadata by unique suffix', () => {
    const catalogue = parseOpenRouterModels(OPENROUTER_SAMPLE);
    const providerModels = parseProviderModels([
      { id: 'gpt-5', owned_by: 'openai' },
      { id: 'gpt-4o-mini', owned_by: 'openai' },
      { id: 'unknown-model' },
    ]);

    const enriched = enrichWithOpenRouterMetadata(providerModels, catalogue);
    const byId = new Map(enriched.map((model) => [model.id, model]));

    expect(byId.get('gpt-5')).toMatchObject({
      reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
      reasoningEffortSource: 'metadata',
      defaultReasoningEffort: 'medium',
      name: 'OpenAI: GPT-5',
    });
    expect(byId.get('gpt-4o-mini')?.reasoningEfforts).toEqual([]);
    expect(byId.get('gpt-4o-mini')?.reasoningEffortSource).toBe('none');
    expect(byId.get('unknown-model')?.reasoningEffortSource).toBe('none');
  });

  it('fetches a provider through the SDK and applies its declared effort table', async () => {
    openaiMock.list.mockResolvedValue({
      data: [{ id: 'gpt-5', created: 1, owned_by: 'openai' }],
      hasNextPage: () => false,
    });

    const models = await fetchProviderModels({
      providerId: 'openai',
      protocol: 'openai-responses',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(openaiMock.list).toHaveBeenCalledTimes(1);
    expect(openaiMock.options[0]).toMatchObject({
      apiKey: 'sk-test',
      baseURL: 'https://api.openai.com/v1',
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
    });
    expect(models[0]?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(models[0]?.reasoningEffortSource).toBe('declared');
  });

  it('uses OpenRouter’s catalogue directly when that is the selected provider', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: OPENROUTER_SAMPLE }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchProviderModels({
      providerId: 'openrouter',
      protocol: 'openai-responses',
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    expect(openaiMock.list).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(models.map((model) => model.id)).toContain('anthropic/claude-sonnet-5.5');
  });

  it('follows an overridden OpenRouter base URL instead of the public catalogue', async () => {
    openaiMock.list.mockResolvedValue({
      data: [{ id: 'openai/gpt-5', created: 1, owned_by: 'openai' }],
      hasNextPage: () => false,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchProviderModels({
      providerId: 'openrouter',
      protocol: 'openai-responses',
      apiKey: 'sk-or-test',
      baseUrl: 'https://gateway.example/v1',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(openaiMock.options[0]).toMatchObject({
      apiKey: 'sk-or-test',
      baseURL: 'https://gateway.example/v1',
    });
    expect(models.map((model) => model.id)).toContain('openai/gpt-5');
    // Without the public catalogue, OpenRouter effort metadata is inferred.
    expect(models[0]?.reasoningEffortSource).toBe('inferred');
  });

  it('uses the Anthropic Models API for a custom Anthropic protocol endpoint', async () => {
    anthropicMock.list.mockImplementation(async function* generate() {
      yield {
        id: 'claude-opus-5-5',
        display_name: 'Claude Opus 5.5',
        lifecycle: 'active',
        line: 'opus',
        max_input_tokens: 1_000_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            xhigh: { supported: true },
            max: { supported: true },
          },
        },
      };
    });

    const models = await fetchProviderModels({
      providerId: 'custom',
      protocol: 'anthropic-messages',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://proxy.example',
    });

    expect(anthropicMock.options[0]).toMatchObject({
      apiKey: 'sk-ant-test',
      baseURL: 'https://proxy.example',
    });
    expect(models[0]).toMatchObject({
      id: 'claude-opus-5-5',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      reasoningEffortSource: 'metadata',
    });
  });

  it('requires the selected provider’s key for non-OpenRouter discovery', async () => {
    await expect(
      fetchProviderModels({
        providerId: 'deepseek',
        protocol: 'openai-responses',
        apiKey: '  ',
        baseUrl: 'https://api.deepseek.com',
      }),
    ).rejects.toBeInstanceOf(AIRequestError);
    expect(openaiMock.list).not.toHaveBeenCalled();
  });

  it('reads Anthropic’s per-model effort capability from the Models API', async () => {
    anthropicMock.list.mockImplementation(async function* generate() {
      yield {
        id: 'claude-opus-5-5',
        display_name: 'Claude Opus 5.5',
        created_at: '2026-09-01T00:00:00Z',
        lifecycle: 'active',
        line: 'opus',
        max_input_tokens: 1_000_000,
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            xhigh: { supported: true },
            max: { supported: true },
          },
        },
      };
      yield {
        id: 'claude-haiku-4-5',
        display_name: 'Claude Haiku 4.5',
        created_at: '2025-10-01T00:00:00Z',
        lifecycle: 'active',
        line: 'haiku',
        max_input_tokens: 200_000,
        capabilities: { effort: { supported: false } },
      };
    });

    const models = await fetchProviderModels({
      providerId: 'anthropic',
      protocol: 'anthropic-messages',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(anthropicMock.options[0]).toMatchObject({
      apiKey: 'sk-ant-test',
      baseURL: 'https://api.anthropic.com',
      dangerouslyAllowBrowser: true,
      maxRetries: 0,
    });
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get('claude-opus-5-5')).toMatchObject({
      name: 'Claude Opus 5.5',
      contextLength: 1_000_000,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      reasoningEffortSource: 'metadata',
    });
    expect(byId.get('claude-haiku-4-5')?.reasoningEfforts).toEqual([]);
    // The API explicitly said supported:false; that is metadata, not missing
    // data, so it must not be replaced by the family table.
    expect(byId.get('claude-haiku-4-5')?.reasoningEffortSource).toBe('metadata');
  });
});

describe('provider-aware effort metadata and seeds', () => {
  it('uses declared DeepSeek levels and labels them honestly', () => {
    const capability = effortCapabilityForModel(
      [],
      'deepseek',
      'openai-responses',
      'deepseek-flash',
    );
    expect(capability.efforts).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(capability.source).toBe('declared');
    expect(capability.defaultEffort).toBe('high');
  });

  it('does not infer effort for an unknown custom model', () => {
    const capability = effortCapabilityForModel(
      [],
      'custom',
      'openai-responses',
      'totally-unknown',
    );
    expect(capability.efforts).toEqual([]);
    expect(capability.source).toBe('none');
  });

  it('seeds per-provider defaults instead of one universal model', () => {
    const openai = seedProviderModels('openai', 'openai-responses');
    const deepseek = seedProviderModels('deepseek', 'openai-responses');
    const anthropic = seedProviderModels('anthropic', 'anthropic-messages');
    const custom = seedProviderModels('custom', 'openai-responses');

    expect(openai[0]?.id).toBe(PROVIDERS.openai.defaultModel);
    expect(deepseek.map((model) => model.id)).toEqual(
      expect.arrayContaining(['deepseek-flash', 'deepseek-v4-pro']),
    );
    expect(anthropic.map((model) => model.id)).toContain('claude-opus-5-5');
    expect(custom).toEqual([]);
  });

  it('rewrites guessed metadata with the provider table', () => {
    const parsed = parseProviderModels([{ id: 'gpt-5' }, { id: 'o3' }]);
    const applied = applyProviderEffortMetadata(parsed, 'openai', 'openai-responses');
    expect(applied[0]?.reasoningEffortSource).toBe('declared');
    expect(applied[0]?.reasoningEfforts).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(applied[1]?.reasoningEfforts).toEqual(['low', 'medium', 'high']);
  });
});

describe('Anthropic model parsing', () => {
  it('filters retired models and honours capability flags', () => {
    expect(parseAnthropicModel({ id: 'old', lifecycle: 'retired' })).toBeNull();
    const model = parseAnthropicModel({
      id: 'claude-sonnet-5-5',
      display_name: 'Claude Sonnet 5.5',
      lifecycle: 'active',
      line: 'sonnet',
      max_input_tokens: 1_000_000,
      capabilities: {
        effort: {
          supported: true,
          low: { supported: true },
          medium: { supported: true },
          high: { supported: true },
          xhigh: { supported: false },
          max: { supported: true },
        },
      },
    });
    expect(model?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'max']);
    expect(model?.reasoningEffortSource).toBe('metadata');
  });
});

describe('model selection helpers', () => {
  it('returns catalogue levels when loaded and only infers when it is not', () => {
    const catalogue = parseOpenRouterModels(OPENROUTER_SAMPLE);

    expect(effortsForModel(catalogue, 'openai/gpt-5')).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
    ]);
    // A loaded catalogue is authoritative: an unknown id gets no effort guess.
    expect(effortsForModel(catalogue, 'o4-mini')).toEqual([]);
    expect(effortsForModel([], 'o4-mini')).toEqual(['low', 'medium', 'high']);
    expect(effortsForModel([], 'llama-3.3-70b')).toEqual([]);
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

  it('prefers the provider default before an arbitrary first entry', () => {
    const models: ProviderModel[] = parseProviderModels([
      { id: 'aaa-chat' },
      { id: 'provider-default' },
    ]);
    expect(pickModelId(models, 'not-listed', 'provider-default')).toBe('provider-default');
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
