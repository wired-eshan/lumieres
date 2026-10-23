import { beforeEach, describe, expect, it } from 'vitest';
import {
  AI_SETTINGS_SCHEMA_VERSION,
  DEFAULT_AI_SETTINGS,
  clearAIKey,
  createDefaultAISettings,
  getAISettings,
  getProviderProfile,
  isAIConfigured,
  makeProviderProfile,
  normalizeProviderProfile,
  reloadAISettings,
  resolveAISettings,
  saveAISettings,
  subscribeAISettings,
} from './settings';
import { PROVIDERS } from './provider';
import { createEmptyDocument } from '../graph/graphOperations';
import { serializeDocument } from '../persistence/migrations';

const STORAGE_KEY = 'lumieres:ai-settings';

function withProfile(
  providerId: keyof typeof PROVIDERS,
  patch: Parameters<typeof makeProviderProfile>[1] = {},
) {
  const settings = createDefaultAISettings();
  settings.providerId = providerId;
  settings.profiles[providerId] = makeProviderProfile(providerId, patch);
  return settings;
}

beforeEach(() => {
  window.localStorage.clear();
  saveAISettings(createDefaultAISettings());
});

describe('AI settings', () => {
  it('defaults to OpenRouter with an empty profile for every provider', () => {
    expect(getAISettings()).toEqual(DEFAULT_AI_SETTINGS);
    expect(getAISettings().schemaVersion).toBe(AI_SETTINGS_SCHEMA_VERSION);
    expect(getAISettings().providerId).toBe('openrouter');
    expect(Object.keys(getAISettings().profiles).sort()).toEqual(
      ['anthropic', 'custom', 'deepseek', 'openai', 'openrouter'].sort(),
    );
    expect(isAIConfigured()).toBe(false);
  });

  it('persists a trimmed per-provider key, endpoint, model and effort in local storage only', () => {
    const saved = saveAISettings(
      withProfile('openai', {
        apiKey: '  sk-user  ',
        baseUrl: 'https://api.openai.com/v1/',
        model: 'gpt-5.2',
        reasoningEffort: 'high',
      }),
    );

    expect(saved.providerId).toBe('openai');
    expect(getProviderProfile(saved, 'openai')).toMatchObject({
      apiKey: 'sk-user',
      // A base URL equal to the documented default is stored as ''.
      baseUrl: '',
      model: 'gpt-5.2',
      reasoningEffort: 'high',
    });
    expect(isAIConfigured()).toBe(true);

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toContain('sk-user');
    expect(raw).not.toContain('schemaVersion":2,"id"');
  });

  it('keeps each provider’s key isolated', () => {
    const first = withProfile('openai', { apiKey: 'sk-openai' });
    first.profiles.anthropic = makeProviderProfile('anthropic', { apiKey: 'sk-ant' });
    const saved = saveAISettings(first);

    expect(getProviderProfile(saved, 'openai').apiKey).toBe('sk-openai');
    expect(getProviderProfile(saved, 'anthropic').apiKey).toBe('sk-ant');
    expect(getProviderProfile(saved, 'openrouter').apiKey).toBe('');
    expect(resolveAISettings(saved).apiKey).toBe('sk-openai');
  });

  it('switching the active provider changes which key is resolved', () => {
    const settings = createDefaultAISettings();
    settings.profiles.openai = makeProviderProfile('openai', { apiKey: 'sk-openai' });
    settings.profiles.anthropic = makeProviderProfile('anthropic', { apiKey: 'sk-ant' });
    settings.providerId = 'anthropic';
    const saved = saveAISettings(settings);

    const resolved = resolveAISettings(saved);
    expect(resolved.providerId).toBe('anthropic');
    expect(resolved.protocol).toBe('anthropic-messages');
    expect(resolved.apiKey).toBe('sk-ant');
    expect(resolved.baseUrl).toBe('https://api.anthropic.com');
    expect(resolved.model).toBe(PROVIDERS.anthropic.defaultModel);
  });

  it('normalises malformed profiles instead of trusting storage', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        providerId: 'toString',
        customProtocol: 'nope',
        profiles: {
          openrouter: {
            apiKey: '  key  ',
            baseUrl: 'nope',
            model: '  ',
            reasoningEffort: 'extreme',
          },
        },
      }),
    );
    const loaded = reloadAISettings();
    expect(loaded.providerId).toBe('openrouter');
    expect(loaded.customProtocol).toBe('openai-responses');
    expect(getProviderProfile(loaded, 'openrouter')).toMatchObject({
      apiKey: 'key',
      baseUrl: '',
      model: PROVIDERS.openrouter.defaultModel,
      reasoningEffort: '',
      effortCapability: null,
    });
  });

  it('migrates legacy OpenRouter settings into the OpenRouter profile', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: 'old-or',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'openai/gpt-5',
        reasoningEffort: 'high',
      }),
    );
    const loaded = reloadAISettings();
    expect(loaded.providerId).toBe('openrouter');
    expect(getProviderProfile(loaded, 'openrouter')).toMatchObject({
      apiKey: 'old-or',
      baseUrl: '',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    });
    // No other provider receives the key.
    expect(getProviderProfile(loaded, 'anthropic').apiKey).toBe('');
  });

  it('migrates a legacy bare Claude model to the native Anthropic provider', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ apiKey: 'sk-ant-old', model: 'claude-sonnet-5-5' }),
    );
    const loaded = reloadAISettings();
    expect(loaded.providerId).toBe('anthropic');
    expect(getProviderProfile(loaded, 'anthropic')).toMatchObject({
      apiKey: 'sk-ant-old',
      baseUrl: '',
      model: 'claude-sonnet-5-5',
      reasoningEffort: '',
    });
  });

  it('keeps a legacy custom endpoint on Chat Completions', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: 'sk-custom',
        baseUrl: 'https://example.com/v1',
        model: 'my-model',
        reasoningEffort: 'medium',
      }),
    );
    const loaded = reloadAISettings();
    expect(loaded.providerId).toBe('custom');
    expect(loaded.customProtocol).toBe('openai-chat');
    expect(getProviderProfile(loaded, 'custom')).toMatchObject({
      apiKey: 'sk-custom',
      baseUrl: 'https://example.com/v1',
      model: 'my-model',
      reasoningEffort: 'medium',
    });
  });

  it('reacts to settings changes from another tab', () => {
    const external = createDefaultAISettings();
    external.providerId = 'openai';
    external.profiles.openai = makeProviderProfile('openai', {
      apiKey: 'from-other-tab',
      model: 'gpt-5.2',
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(external));

    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));

    expect(getAISettings().providerId).toBe('openai');
    expect(getProviderProfile(getAISettings(), 'openai').apiKey).toBe('from-other-tab');
  });

  it('notifies subscribers and can be reloaded from storage', () => {
    let notifications = 0;
    const unsubscribe = subscribeAISettings(() => {
      notifications += 1;
    });

    const next = createDefaultAISettings();
    next.providerId = 'deepseek';
    next.profiles.deepseek = makeProviderProfile('deepseek', {
      apiKey: 'abc',
      model: 'deepseek-flash',
      reasoningEffort: 'low',
    });
    saveAISettings(next);
    expect(notifications).toBe(1);

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 2,
        providerId: 'openai',
        customProtocol: 'openai-responses',
        profiles: {
          openai: { apiKey: 'from-another-tab', model: 'gpt-5.2' },
        },
      }),
    );
    reloadAISettings();
    expect(resolveAISettings()).toMatchObject({
      providerId: 'openai',
      apiKey: 'from-another-tab',
      model: 'gpt-5.2',
    });
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('clears only the requested provider key, keeping its model and effort', () => {
    const settings = createDefaultAISettings();
    settings.providerId = 'openai';
    settings.profiles.openai = makeProviderProfile('openai', {
      apiKey: 'secret',
      baseUrl: '',
      model: 'gpt-5.2',
      reasoningEffort: 'high',
    });
    settings.profiles.anthropic = makeProviderProfile('anthropic', { apiKey: 'other' });
    saveAISettings(settings);

    const next = clearAIKey('openai');
    expect(getProviderProfile(next, 'openai')).toMatchObject({
      apiKey: '',
      model: 'gpt-5.2',
      reasoningEffort: 'high',
    });
    expect(getProviderProfile(next, 'anthropic').apiKey).toBe('other');
    expect(isAIConfigured(next)).toBe(false);
  });

  it('survives malformed storage', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(reloadAISettings()).toEqual(DEFAULT_AI_SETTINGS);

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: 42, model: '' }));
    expect(reloadAISettings()).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('normalises a custom profile with its chosen protocol', () => {
    expect(
      normalizeProviderProfile(
        'custom',
        {
          apiKey: ' key ',
          baseUrl: 'https://proxy.example/anthropic/v1/messages',
          model: 'claude-opus-5-5',
          reasoningEffort: 'high',
        },
        'anthropic-messages',
      ),
    ).toMatchObject({
      apiKey: 'key',
      baseUrl: 'https://proxy.example/anthropic',
      model: 'claude-opus-5-5',
      reasoningEffort: 'high',
    });
  });

  it('never serialises a key into a canvas document', () => {
    saveAISettings(withProfile('openrouter', { apiKey: 'sk-must-not-leak' }));
    const json = serializeDocument(createEmptyDocument('Export'));
    expect(json).not.toContain('sk-must-not-leak');
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain(PROVIDERS.openrouter.defaultBaseUrl);
  });
});
