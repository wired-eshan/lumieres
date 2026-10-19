import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_SETTINGS,
  clearAIKey,
  getAISettings,
  isAIConfigured,
  normalizeBaseUrl,
  reloadAISettings,
  saveAISettings,
  subscribeAISettings,
} from './settings';
import { createEmptyDocument } from '../graph/graphOperations';
import { serializeDocument } from '../persistence/migrations';

const STORAGE_KEY = 'lumieres:ai-settings';

beforeEach(() => {
  window.localStorage.clear();
  saveAISettings({ ...DEFAULT_AI_SETTINGS });
});

describe('AI settings', () => {
  it('defaults to no key, the OpenAI endpoint and the fallback model', () => {
    expect(getAISettings()).toEqual(DEFAULT_AI_SETTINGS);
    expect(isAIConfigured()).toBe(false);
  });

  it('persists a trimmed key, endpoint, model and effort in local storage only', () => {
    const saved = saveAISettings({
      apiKey: '  sk-user  ',
      baseUrl: ' https://openrouter.ai/api/v1/ ',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    });
    expect(saved).toEqual({
      apiKey: 'sk-user',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    });
    expect(isAIConfigured()).toBe(true);

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toContain('sk-user');
    // The key never enters the graph document shape; it has its own storage key.
    expect(raw).not.toContain('schemaVersion');
  });

  it('normalises malformed values instead of trusting storage', () => {
    expect(normalizeBaseUrl('ftp://example.com/v1')).toBe(DEFAULT_AI_BASE_URL);
    expect(normalizeBaseUrl('not a url')).toBe(DEFAULT_AI_BASE_URL);
    expect(normalizeBaseUrl('')).toBe(DEFAULT_AI_BASE_URL);
    expect(normalizeBaseUrl('https://example.com/v1///')).toBe('https://example.com/v1');

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: '  key  ',
        baseUrl: 'nope',
        model: '  ',
        reasoningEffort: 'extreme',
      }),
    );
    expect(reloadAISettings()).toEqual({
      apiKey: 'key',
      baseUrl: DEFAULT_AI_BASE_URL,
      model: DEFAULT_AI_MODEL,
      reasoningEffort: '',
    });
  });

  it('migrates model ids written by the previous Anthropic build', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ apiKey: 'old', model: 'claude-sonnet-5-5', reasoningEffort: 'high' }),
    );
    expect(reloadAISettings()).toEqual({
      apiKey: 'old',
      baseUrl: DEFAULT_AI_BASE_URL,
      model: DEFAULT_AI_MODEL,
      reasoningEffort: 'high',
    });
  });

  it('notifies subscribers and can be reloaded from storage', () => {
    let notifications = 0;
    const unsubscribe = subscribeAISettings(() => {
      notifications += 1;
    });
    saveAISettings({
      apiKey: 'abc',
      baseUrl: DEFAULT_AI_BASE_URL,
      model: 'gpt-4.1-mini',
      reasoningEffort: 'low',
    });
    expect(notifications).toBe(1);

    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        apiKey: 'from-another-tab',
        baseUrl: 'https://api.example.com/v1',
        model: 'custom-model',
        reasoningEffort: 'medium',
      }),
    );
    reloadAISettings();
    expect(getAISettings()).toMatchObject({
      apiKey: 'from-another-tab',
      baseUrl: 'https://api.example.com/v1',
      model: 'custom-model',
      reasoningEffort: 'medium',
    });
    expect(notifications).toBe(2);
    unsubscribe();
  });

  it('clears the key without forgetting the provider, model or effort', () => {
    saveAISettings({
      apiKey: 'secret',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    });
    const next = clearAIKey();
    expect(next).toEqual({
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    });
    expect(isAIConfigured(next)).toBe(false);
  });

  it('survives malformed storage', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    expect(reloadAISettings()).toEqual(DEFAULT_AI_SETTINGS);

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: 42, model: '' }));
    expect(reloadAISettings()).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('never serialises the key into a canvas document', () => {
    saveAISettings({
      ...DEFAULT_AI_SETTINGS,
      apiKey: 'sk-must-not-leak',
    });
    const json = serializeDocument(createEmptyDocument('Export'));
    expect(json).not.toContain('sk-must-not-leak');
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain(DEFAULT_AI_BASE_URL);
  });
});
