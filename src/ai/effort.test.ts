import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_EFFORT_ALIASES,
  capabilitiesFor,
  mapEffortForRequest,
  type EffortCatalogueEntry,
} from './effort';
import type { ProviderEffortMetadata } from './provider';

function map(
  providerId: Parameters<typeof mapEffortForRequest>[0]['providerId'],
  modelId: string,
  requested: Parameters<typeof mapEffortForRequest>[0]['requested'],
  extra: Partial<Parameters<typeof mapEffortForRequest>[0]> = {},
) {
  return mapEffortForRequest({
    providerId,
    protocol: providerId === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
    modelId,
    requested,
    ...extra,
  });
}

const OPENROUTER_GPT5: EffortCatalogueEntry = {
  id: 'openai/gpt-5',
  reasoningEfforts: ['minimal', 'low', 'medium', 'high'],
  reasoningEffortSource: 'metadata',
  defaultReasoningEffort: 'medium',
  reasoningMandatory: true,
};

describe('OpenAI effort mapping', () => {
  it('offers documented family levels and nothing for unknown ids', () => {
    expect(capabilitiesFor({
      providerId: 'openai',
      protocol: 'openai-responses',
      modelId: 'gpt-5.2',
    }).efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh']);

    expect(capabilitiesFor({
      providerId: 'openai',
      protocol: 'openai-responses',
      modelId: 'gpt-5.6',
    }).efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

    expect(capabilitiesFor({
      providerId: 'openai',
      protocol: 'openai-responses',
      modelId: 'gpt-6-astra',
    }).efforts).toEqual(['low', 'medium', 'high', 'xhigh']);

    expect(capabilitiesFor({
      providerId: 'openai',
      protocol: 'openai-responses',
      modelId: 'gpt-5',
    }).efforts).toEqual(['minimal', 'low', 'medium', 'high']);

    expect(capabilitiesFor({
      providerId: 'openai',
      protocol: 'openai-responses',
      modelId: 'gpt-4o-mini',
    })).toMatchObject({ efforts: [], source: 'none' });
  });

  it('passes a supported value through unchanged', () => {
    const result = map('openai', 'gpt-5', 'high');
    expect(result).toMatchObject({ value: 'high', applied: true });
    expect(result.mappedFrom).toBeUndefined();
  });

  it('omits an unsupported value instead of silently substituting one', () => {
    const result = map('openai', 'gpt-5', 'max');
    expect(result.value).toBeNull();
    expect(result.applied).toBe(false);
    expect(result.note).toContain('not supported');
  });
});

describe('DeepSeek effort mapping', () => {
  it('preserves canonical values and reports documented aliases', () => {
    expect(map('deepseek', 'deepseek-flash', 'none')).toMatchObject({
      value: 'none',
      applied: true,
    });
    expect(map('deepseek', 'deepseek-flash', 'high')).toMatchObject({
      value: 'high',
      applied: true,
    });
    expect(map('deepseek', 'deepseek-flash', 'max')).toMatchObject({
      value: 'max',
      applied: true,
    });

    expect(map('deepseek', 'deepseek-flash', 'medium')).toMatchObject({
      value: 'high',
      applied: true,
      mappedFrom: 'medium',
    });
    expect(map('deepseek', 'deepseek-flash', 'xhigh')).toMatchObject({
      value: 'high',
      mappedFrom: 'xhigh',
    });
    expect(map('deepseek', 'deepseek-flash', 'minimal')).toMatchObject({
      value: 'low',
      mappedFrom: 'minimal',
    });
    expect(DEEPSEEK_EFFORT_ALIASES).toMatchObject({
      minimal: 'low',
      medium: 'high',
      xhigh: 'high',
    });
  });

  it('does not offer effort for retired or unknown model ids', () => {
    expect(capabilitiesFor({
      providerId: 'deepseek',
      protocol: 'openai-responses',
      modelId: 'deepseek-chat',
    })).toMatchObject({ efforts: [], source: 'none' });
  });
});

describe('Anthropic effort mapping', () => {
  it('uses output levels low through max and never sends none/minimal', () => {
    expect(capabilitiesFor({
      providerId: 'anthropic',
      protocol: 'anthropic-messages',
      modelId: 'claude-opus-5-5',
    }).efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

    const none = map('anthropic', 'claude-opus-5-5', 'none');
    expect(none.value).toBeNull();
    expect(none.applied).toBe(false);
    expect(none.note).toContain('not supported');

    const minimal = map('anthropic', 'claude-opus-5-5', 'minimal');
    expect(minimal.value).toBeNull();

    expect(map('anthropic', 'claude-opus-5-5', 'xhigh')).toMatchObject({
      value: 'xhigh',
      applied: true,
    });
  });

  it('knows that Claude 4.6 has max but not xhigh', () => {
    expect(capabilitiesFor({
      providerId: 'anthropic',
      protocol: 'anthropic-messages',
      modelId: 'claude-sonnet-4-6',
    }).efforts).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('does not offer effort for an older Claude id absent from the table', () => {
    expect(capabilitiesFor({
      providerId: 'anthropic',
      protocol: 'anthropic-messages',
      modelId: 'claude-3-5-sonnet',
    })).toMatchObject({ efforts: [], source: 'none' });
  });
});

describe('OpenRouter effort mapping', () => {
  it('treats a loaded catalogue as authoritative for the selected model', () => {
    const result = map('openrouter', 'openai/gpt-5', 'xhigh', {
      catalogue: [OPENROUTER_GPT5],
    });
    expect(result.value).toBeNull();
    expect(result.applied).toBe(false);
    expect(result.capability.efforts).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(result.capability.source).toBe('metadata');
  });

  it('passes an advertised value through', () => {
    const result = map('openrouter', 'openai/gpt-5', 'minimal', {
      catalogue: [OPENROUTER_GPT5],
    });
    expect(result.value).toBe('minimal');
    expect(result.applied).toBe(true);
    expect(result.capability.defaultEffort).toBe('medium');
  });

  it('honours a per-model catalogue entry that advertises xhigh', () => {
    const result = map('openrouter', 'anthropic/claude-sonnet-5.5', 'xhigh', {
      catalogue: [
        {
          id: 'anthropic/claude-sonnet-5.5',
          reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          reasoningEffortSource: 'metadata',
          defaultReasoningEffort: 'high',
          reasoningMandatory: true,
        },
      ],
    });
    expect(result.value).toBe('xhigh');
    expect(result.applied).toBe(true);
    expect(result.capability.efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('uses the four documented levels as a fallback only without a catalogue', () => {
    const result = map('openrouter', 'o4-mini', 'high');
    expect(result.value).toBe('high');
    expect(result.capability.source).toBe('inferred');
    expect(result.capability.efforts).toEqual(['low', 'medium', 'high']);
  });
});

describe('provider-declared metadata overrides family tables', () => {
  const metadata: EffortCatalogueEntry = {
    id: 'claude-opus-5-5',
    reasoningEfforts: ['low', 'high'],
    reasoningEffortSource: 'metadata',
    defaultReasoningEffort: 'low',
    reasoningMandatory: false,
  };

  it('honours Anthropic’s explicit levels', () => {
    expect(capabilitiesFor({
      providerId: 'anthropic',
      protocol: 'anthropic-messages',
      modelId: 'claude-opus-5-5',
      catalogue: [metadata],
    })).toMatchObject({
      efforts: ['low', 'high'],
      source: 'metadata',
    });
  });

  it('honours an explicit “no effort” from the Anthropic Models API', () => {
    expect(capabilitiesFor({
      providerId: 'anthropic',
      protocol: 'anthropic-messages',
      modelId: 'claude-opus-5-5',
      catalogue: [
        {
          ...metadata,
          reasoningEfforts: [],
          reasoningEffortSource: 'metadata',
        },
      ],
    })).toMatchObject({ efforts: [], source: 'none' });
  });

  it('honours metadata discovered through a custom Anthropic endpoint', () => {
    expect(capabilitiesFor({
      providerId: 'custom',
      protocol: 'anthropic-messages',
      modelId: 'claude-opus-5-5',
      catalogue: [metadata],
    })).toMatchObject({ efforts: ['low', 'high'], source: 'metadata' });
  });

  it('does not widen an explicit custom effort list with family inference', () => {
    expect(capabilitiesFor({
      providerId: 'custom',
      protocol: 'openai-responses',
      modelId: 'gpt-5',
      catalogue: [
        {
          id: 'gpt-5',
          reasoningEfforts: ['low', 'high'],
          reasoningEffortSource: 'metadata',
          defaultReasoningEffort: '',
          reasoningMandatory: false,
        },
      ],
    })).toMatchObject({ efforts: ['low', 'high'], source: 'metadata' });
  });
});

describe('stored profile capability', () => {
  const stored: ProviderEffortMetadata = {
    modelId: 'custom-model',
    efforts: ['low', 'high'],
    source: 'metadata',
    defaultEffort: 'high',
    mandatory: false,
    note: 'Saved from the catalogue.',
  };

  it('uses metadata saved for the exact model', () => {
    const result = map('custom', 'custom-model', 'medium', { stored });
    expect(result.value).toBeNull();
    expect(result.capability.efforts).toEqual(['low', 'high']);
    expect(result.capability.note).toBe('Saved from the catalogue.');
  });

  it('ignores metadata saved for a different model', () => {
    const result = map('custom', 'other-model', 'low', { stored });
    // Custom endpoints cannot be assumed to share a model's capabilities.
    expect(result.value).toBeNull();
    expect(result.capability.source).toBe('none');
  });
});

describe('custom endpoint effort uncertainty', () => {
  it('labels a recognised family as inferred, not guaranteed', () => {
    const capability = capabilitiesFor({
      providerId: 'custom',
      protocol: 'openai-responses',
      modelId: 'gpt-5',
    });
    expect(capability.source).toBe('inferred');
    expect(capability.note).toContain('inferred');
  });

  it('offers nothing for an unknown custom model id', () => {
    const result = map('custom', 'acme-unknown', 'high');
    expect(result.value).toBeNull();
    expect(result.applied).toBe(false);
    expect(result.capability.efforts).toEqual([]);
  });
});
