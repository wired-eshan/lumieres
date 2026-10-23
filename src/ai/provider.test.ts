import { describe, expect, it } from 'vitest';
import {
  PROVIDERS,
  PROVIDER_ORDER,
  endpointUrlForConfig,
  getProviderDefinition,
  isValidBaseUrl,
  normalizeBaseUrl,
  protocolForProvider,
  resolveProviderConfig,
  validateProviderConfig,
  type ProviderProfile,
} from './provider';

function profile(patch: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    apiKey: 'sk-test',
    baseUrl: '',
    model: '',
    reasoningEffort: '',
    effortCapability: null,
    ...patch,
  };
}

describe('provider registry', () => {
  it('defines the expected endpoint, protocol and default model for each built-in', () => {
    expect(PROVIDERS.openai).toMatchObject({
      protocol: 'openai-responses',
      defaultBaseUrl: 'https://api.openai.com/v1',
    });
    expect(PROVIDERS.openrouter).toMatchObject({
      protocol: 'openai-responses',
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'openai/gpt-4o-mini',
    });
    expect(PROVIDERS.deepseek).toMatchObject({
      protocol: 'openai-responses',
      defaultBaseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-flash',
    });
    expect(PROVIDERS.anthropic).toMatchObject({
      protocol: 'anthropic-messages',
      defaultBaseUrl: 'https://api.anthropic.com',
    });

    // A provider's endpoint/default must never be treated as universal.
    const defaults = new Set(PROVIDER_ORDER.map((id) => PROVIDERS[id].defaultModel));
    expect(defaults.size).toBeGreaterThan(1);
  });

  it('maps custom to its chosen protocol and built-ins to their fixed protocol', () => {
    expect(protocolForProvider('openai', 'anthropic-messages')).toBe('openai-responses');
    expect(protocolForProvider('anthropic', 'openai-responses')).toBe('anthropic-messages');
    expect(protocolForProvider('custom', 'anthropic-messages')).toBe('anthropic-messages');
    expect(protocolForProvider('custom', 'openai-chat')).toBe('openai-chat');
  });

  it('does not pretend Anthropic supports the Responses protocol', () => {
    expect(PROVIDERS.anthropic.capabilities.responsesApi).toBe(false);
    expect(PROVIDERS.openai.capabilities.responsesApi).toBe(true);
    expect(PROVIDERS.openrouter.capabilities.supportsPreviousResponseId).toBe(false);
    expect(PROVIDERS.openrouter.capabilities.reasoningEfforts).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(PROVIDERS.openrouter.capabilities.requiresAssistantMessageMetadata).toBe(true);
    expect(PROVIDERS.deepseek.capabilities.supportsPreviousResponseId).toBe(false);
    expect(PROVIDERS.openai.capabilities.supportsPreviousResponseId).toBe(true);
  });
});

describe('base URL normalisation', () => {
  it('strips a pasted Responses endpoint without removing /v1', () => {
    expect(
      normalizeBaseUrl(
        'https://api.openai.com/v1/responses',
        PROVIDERS.openai.defaultBaseUrl,
        'openai-responses',
      ),
    ).toBe('https://api.openai.com/v1');
    expect(
      normalizeBaseUrl(
        'https://api.deepseek.com/responses',
        PROVIDERS.deepseek.defaultBaseUrl,
        'openai-responses',
      ),
    ).toBe('https://api.deepseek.com');
    expect(
      normalizeBaseUrl(
        'https://openrouter.ai/api/v1/responses/',
        PROVIDERS.openrouter.defaultBaseUrl,
        'openai-responses',
      ),
    ).toBe('https://openrouter.ai/api/v1');
  });

  it('strips Anthropic’s endpoint and duplicate version segment', () => {
    expect(
      normalizeBaseUrl(
        'https://api.anthropic.com/v1/messages',
        PROVIDERS.anthropic.defaultBaseUrl,
        'anthropic-messages',
      ),
    ).toBe('https://api.anthropic.com');
    expect(
      normalizeBaseUrl(
        'https://proxy.example/anthropic/v1',
        '',
        'anthropic-messages',
      ),
    ).toBe('https://proxy.example/anthropic');
  });

  it('strips a pasted Chat Completions endpoint but keeps /v1', () => {
    expect(
      normalizeBaseUrl(
        'https://proxy.example/v1/chat/completions',
        '',
        'openai-chat',
      ),
    ).toBe('https://proxy.example/v1');
  });

  it('strips another protocol’s endpoint rather than letting the SDK append after it', () => {
    expect(
      normalizeBaseUrl(
        'https://api.openai.com/v1/chat/completions',
        PROVIDERS.openai.defaultBaseUrl,
        'openai-responses',
      ),
    ).toBe('https://api.openai.com/v1');
    expect(
      normalizeBaseUrl(
        'https://proxy.example/v1/responses',
        '',
        'openai-chat',
      ),
    ).toBe('https://proxy.example/v1');
    expect(
      normalizeBaseUrl(
        'https://proxy.example/responses',
        '',
        'anthropic-messages',
      ),
    ).toBe('https://proxy.example');
    expect(
      normalizeBaseUrl(
        'https://api.openai.com/v1/messages',
        PROVIDERS.openai.defaultBaseUrl,
        'openai-responses',
      ),
    ).toBe('https://api.openai.com/v1');
  });

  it('does not append /v1 on its own', () => {
    expect(normalizeBaseUrl('https://api.example.com', '', 'openai-responses')).toBe(
      'https://api.example.com',
    );
  });

  it('returns the fallback for empty, non-http and credential-bearing values', () => {
    const fallback = PROVIDERS.openai.defaultBaseUrl;
    expect(normalizeBaseUrl('', fallback, 'openai-responses')).toBe(fallback);
    expect(normalizeBaseUrl('ftp://example.com/v1', fallback, 'openai-responses')).toBe(
      fallback,
    );
    expect(
      normalizeBaseUrl('https://user:pass@example.com/v1', fallback, 'openai-responses'),
    ).toBe(fallback);
    expect(normalizeBaseUrl('not a url', fallback, 'openai-responses')).toBe(fallback);
  });

  it('validates absolute http(s) URLs and rejects credentials', () => {
    expect(isValidBaseUrl('https://api.example.com/v1')).toBe(true);
    expect(isValidBaseUrl('http://localhost:11434/v1')).toBe(true);
    expect(isValidBaseUrl('ftp://api.example.com')).toBe(false);
    expect(isValidBaseUrl('https://user:pass@api.example.com')).toBe(false);
    expect(isValidBaseUrl('')).toBe(false);
  });

  it('shows the exact request URL the SDK will use', () => {
    expect(
      endpointUrlForConfig({
        baseUrl: 'https://api.openai.com/v1',
        protocol: 'openai-responses',
      }),
    ).toBe('https://api.openai.com/v1/responses');
    expect(
      endpointUrlForConfig({
        baseUrl: 'https://api.anthropic.com',
        protocol: 'anthropic-messages',
      }),
    ).toBe('https://api.anthropic.com/v1/messages');
    expect(
      endpointUrlForConfig({
        baseUrl: 'https://proxy/v1',
        protocol: 'openai-chat',
      }),
    ).toBe('https://proxy/v1/chat/completions');
  });
});

describe('provider configuration resolution', () => {
  it('uses per-provider defaults and never one universal default', () => {
    const openai = resolveProviderConfig({
      providerId: 'openai',
      profile: profile(),
      customProtocol: 'openai-responses',
    });
    const anthropic = resolveProviderConfig({
      providerId: 'anthropic',
      profile: profile({ apiKey: 'sk-ant' }),
      customProtocol: 'openai-responses',
    });

    expect(openai).toMatchObject({
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      model: PROVIDERS.openai.defaultModel,
      apiKey: 'sk-test',
      continuationEnabled: true,
    });
    expect(anthropic).toMatchObject({
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      model: PROVIDERS.anthropic.defaultModel,
      apiKey: 'sk-ant',
      continuationEnabled: false,
    });
  });

  it('disables OpenAI continuation for a base-URL override that may be a proxy', () => {
    const official = resolveProviderConfig({
      providerId: 'openai',
      profile: profile(),
      customProtocol: 'openai-responses',
    });
    const proxied = resolveProviderConfig({
      providerId: 'openai',
      profile: profile({ baseUrl: 'https://proxy.example/v1' }),
      customProtocol: 'openai-responses',
    });

    expect(official.continuationEnabled).toBe(true);
    expect(proxied).toMatchObject({
      baseUrl: 'https://proxy.example/v1',
      continuationEnabled: false,
    });
  });

  it('resolves a custom profile with the chosen protocol and normalised base', () => {
    const config = resolveProviderConfig({
      providerId: 'custom',
      profile: profile({
        baseUrl: 'https://proxy.example/v1/responses',
        model: 'my-model',
        reasoningEffort: 'high',
      }),
      customProtocol: 'openai-responses',
    });

    expect(config).toMatchObject({
      protocol: 'openai-responses',
      baseUrl: 'https://proxy.example/v1',
      model: 'my-model',
      reasoningEffort: 'high',
    });
  });

  it('reports actionable configuration issues', () => {
    const missingKey = resolveProviderConfig({
      providerId: 'deepseek',
      profile: profile({ apiKey: '' }),
      customProtocol: 'openai-responses',
    });
    expect(validateProviderConfig(missingKey).map((issue) => issue.code)).toContain(
      'missing_api_key',
    );

    const custom = resolveProviderConfig({
      providerId: 'custom',
      profile: profile({ baseUrl: '', model: '' }),
      customProtocol: 'openai-responses',
    });
    const codes = validateProviderConfig(custom).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(['missing_model', 'missing_base_url']),
    );

    const invalid = resolveProviderConfig({
      providerId: 'custom',
      profile: profile({ baseUrl: 'https://ok.example/v1', model: 'm' }),
      customProtocol: 'openai-responses',
    });
    // Force an invalid base after resolution to exercise the validator itself.
    invalid.baseUrl = 'not a url';
    expect(validateProviderConfig(invalid).map((issue) => issue.code)).toContain(
      'invalid_base_url',
    );
  });

  it('rejects a protocol that does not match a built-in provider', () => {
    const config = resolveProviderConfig({
      providerId: 'anthropic',
      profile: profile({ apiKey: 'sk-ant' }),
      customProtocol: 'openai-responses',
    });
    config.protocol = 'openai-responses';
    expect(validateProviderConfig(config).map((issue) => issue.code)).toContain(
      'unsupported_protocol',
    );
  });

  it('exposes registry definitions by id', () => {
    expect(getProviderDefinition('openrouter').label).toBe('OpenRouter');
    expect(getProviderDefinition('custom').defaultModel).toBe('');
  });
});
