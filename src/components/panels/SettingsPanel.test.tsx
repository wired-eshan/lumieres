/**
 * The settings dialog is the only place a user picks a provider, model and
 * reasoning effort. These tests exercise the real panel against a mocked
 * OpenRouter catalogue and guard the failure modes reported in the UI: a model
 * picker that filters options, an empty effort picker, switching provider
 * profiles, and silently discarding an unsupported effort.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import {
  createDefaultAISettings,
  getAISettings,
  makeProviderProfile,
  saveAISettings,
} from '../../ai/settings';
import { PROVIDERS, PROVIDER_ORDER, type ProviderId } from '../../ai/provider';

const CATALOGUE = {
  data: [
    {
      id: 'openai/gpt-4o-mini',
      name: 'OpenAI: GPT-4o-mini',
      created: 1,
      context_length: 128_000,
      supported_parameters: ['max_tokens'],
      reasoning: null,
    },
    {
      id: 'openai/gpt-5',
      name: 'OpenAI: GPT-5',
      created: 2,
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
      created: 3,
      context_length: 1_000_000,
      supported_parameters: ['reasoning_effort', 'max_tokens'],
      reasoning: {
        mandatory: true,
        supported_efforts: ['max', 'xhigh', 'high', 'medium', 'low'],
        default_effort: 'high',
      },
    },
    {
      id: 'openai/text-embedding-3-small',
      name: 'OpenAI: Text Embedding 3 Small',
      created: 4,
      supported_parameters: ['max_tokens'],
      reasoning: null,
    },
  ],
};

const fetchMock = vi.fn();

let container: HTMLDivElement;
let root: Root;

function renderPanel(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<SettingsPanel open onClose={() => undefined} />);
  });
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function saveSettings(providerId: ProviderId, patch: Parameters<typeof makeProviderProfile>[1]) {
  const settings = createDefaultAISettings();
  settings.providerId = providerId;
  settings.profiles[providerId] = makeProviderProfile(providerId, patch);
  return saveAISettings(settings);
}

function select(selector: string): HTMLSelectElement {
  const element = container.querySelector<HTMLSelectElement>(selector);
  if (!element) throw new Error(`select not found: ${selector}`);
  return element;
}

function input(selector: string): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(selector);
  if (!element) throw new Error(`input not found: ${selector}`);
  return element;
}

async function changeSelect(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flushAsync();
}

beforeEach(() => {
  window.localStorage.clear();
  saveAISettings(
    (() => {
      const settings = createDefaultAISettings();
      settings.providerId = 'openrouter';
      settings.profiles.openrouter = makeProviderProfile('openrouter', {
        apiKey: 'sk-or-test',
        model: PROVIDERS.openrouter.defaultModel,
      });
      return settings;
    })(),
  );
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(CATALOGUE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Settings provider selection', () => {
  it('offers every registered provider', async () => {
    renderPanel();
    await flushAsync();

    const provider = select('#ai-provider-select');
    expect([...provider.options].map((option) => option.value)).toEqual([
      ...PROVIDER_ORDER,
    ]);
    expect(provider.value).toBe('openrouter');
  });

  it('switches to another provider’s saved profile without changing the active provider until Save', async () => {
    const settings = getAISettings();
    settings.profiles.anthropic = makeProviderProfile('anthropic', {
      apiKey: '',
      model: 'claude-sonnet-5-5',
    });
    saveAISettings(settings);

    renderPanel();
    await flushAsync();

    await changeSelect(select('#ai-provider-select'), 'anthropic');

    expect(input('input[aria-describedby="settings-key-help"]').value).toBe('');
    expect(select('#ai-model-select').value).toBe('claude-sonnet-5-5');
    // The picker is seeded with documented Anthropic models even without a key.
    expect([...select('#ai-model-select').options].map((option) => option.value)).toContain(
      'claude-opus-5-5',
    );
    // Switching the draft has not changed the active provider yet.
    expect(getAISettings().providerId).toBe('openrouter');
  });

  it('restores the OpenRouter key and catalogue when switching back', async () => {
    renderPanel();
    await flushAsync();
    await changeSelect(select('#ai-provider-select'), 'anthropic');
    expect(input('input[aria-describedby="settings-key-help"]').value).toBe('');

    await changeSelect(select('#ai-provider-select'), 'openrouter');

    expect(input('input[aria-describedby="settings-key-help"]').value).toBe('sk-or-test');
    expect(select('#ai-model-select').value).toBe(PROVIDERS.openrouter.defaultModel);
  });

  it('drops a previous provider’s catalogue when switching to one that cannot load', async () => {
    let resolveFetch: ((response: Response) => void) | null = null;
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    renderPanel();
    await flushAsync();

    // Switch to Anthropic (no saved key) while OpenRouter's fetch is pending.
    await changeSelect(select('#ai-provider-select'), 'anthropic');
    expect(select('#ai-model-select').value).toBe('claude-opus-5-5');

    await act(async () => {
      resolveFetch?.(
        new Response(JSON.stringify(CATALOGUE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    await flushAsync();

    const values = [...select('#ai-model-select').options].map((option) => option.value);
    expect(values).toContain('claude-opus-5-5');
    expect(values).not.toContain('openai/gpt-5');
    expect(values).not.toContain('openai/gpt-4o-mini');
  });

  it('shows a protocol choice only for a custom endpoint', async () => {
    renderPanel();
    await flushAsync();
    expect(container.querySelector('#ai-protocol-select')).toBeNull();

    await changeSelect(select('#ai-provider-select'), 'custom');

    const protocol = select('#ai-protocol-select');
    expect([...protocol.options].map((option) => option.value)).toEqual([
      'openai-responses',
      'anthropic-messages',
      'openai-chat',
    ]);
    expect(protocol.value).toBe('openai-responses');
    // No safe seed model exists for an unknown endpoint.
    expect(container.querySelector('#ai-model-select')?.tagName).toBe('INPUT');
  });
});

describe('Settings model and effort pickers', () => {
  it('shows every model from the OpenRouter catalogue in an unfiltered select', async () => {
    renderPanel();
    await flushAsync();

    const selectElement = select('#ai-model-select');
    const values = [...selectElement.options].map((option) => option.value);
    expect(values).toContain('openai/gpt-4o-mini');
    expect(values).toContain('openai/gpt-5');
    expect(values).toContain('anthropic/claude-sonnet-5.5');
    expect(values).toContain('openai/text-embedding-3-small');
    expect(values).toContain('__custom_model__');
    expect(selectElement.value).toBe('openai/gpt-4o-mini');
  });

  it('populates exactly the effort levels the catalogue advertises', async () => {
    renderPanel();
    await flushAsync();

    const model = select('#ai-model-select');
    const effort = select('select[aria-describedby="settings-effort-help"]');
    // The initial gpt-4o-mini has no reasoning-effort levels.
    expect(effort.disabled).toBe(true);

    await changeSelect(model, 'anthropic/claude-sonnet-5.5');
    expect(effort.disabled).toBe(false);
    // The loaded catalogue is authoritative per model, including xhigh/max.
    expect([...effort.options].map((option) => option.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect([...effort.options][0]?.textContent).toBe('Provider default (high)');

    await changeSelect(model, 'openai/gpt-5');
    expect([...effort.options].map((option) => option.value)).toEqual([
      '',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('uses the four-level fallback when only seed models are present', async () => {
    saveSettings('openrouter', {
      apiKey: 'sk-or-test',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    });
    fetchMock.mockRejectedValue(new TypeError('offline'));

    renderPanel();
    await flushAsync();

    const effort = select('select[aria-describedby="settings-effort-help"]');
    expect(effort.disabled).toBe(false);
    expect(effort.value).toBe('high');
    expect([...effort.options].map((option) => option.value)).toEqual([
      '',
      'minimal',
      'low',
      'medium',
      'high',
    ]);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flushAsync();

    expect(container.querySelector('.settings__status.is-error')).toBeNull();
    expect(getAISettings().profiles.openrouter.reasoningEffort).toBe('high');
  });

  it('requires a key for model loading when OpenRouter’s base URL is overridden', async () => {
    const settings = createDefaultAISettings();
    settings.providerId = 'openrouter';
    settings.profiles.openrouter = makeProviderProfile('openrouter', {
      apiKey: '',
      baseUrl: 'https://gateway.example/v1',
    });
    saveAISettings(settings);

    renderPanel();
    await flushAsync();

    expect(fetchMock).not.toHaveBeenCalled();
    const loadButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.textContent?.includes('Load models') ||
        button.textContent?.includes('Reload models'),
    );
    expect(loadButton?.disabled).toBe(true);
  });

  it('loads the public catalogue without requiring an API key', async () => {
    saveAISettings(
      (() => {
        const settings = createDefaultAISettings();
        settings.profiles.openrouter = makeProviderProfile('openrouter', { apiKey: '' });
        return settings;
      })(),
    );
    renderPanel();
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect([...select('#ai-model-select').options].map((option) => option.value)).toContain(
      'anthropic/claude-sonnet-5.5',
    );
  });

  it('keeps and explains an unsupported saved effort, and blocks Save', async () => {
    saveSettings('openrouter', {
      apiKey: 'sk-or-test',
      model: 'openai/gpt-4o-mini',
      reasoningEffort: 'high',
    });
    renderPanel();
    await flushAsync();

    const effort = select('select[aria-describedby="settings-effort-help"]');
    expect(effort.value).toBe('high');
    expect([...effort.options].map((option) => option.textContent)).toContain(
      'high — not supported by this model',
    );
    expect(container.textContent).toContain('not supported by this model');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    });
    await flushAsync();

    expect(container.querySelector('.settings__status.is-error')?.textContent).toContain(
      'not supported',
    );
    // The saved profile is unchanged; the user must make an explicit choice.
    expect(getAISettings().profiles.openrouter.reasoningEffort).toBe('high');
  });

  it('clears only the selected provider’s key', async () => {
    const settings = createDefaultAISettings();
    settings.providerId = 'openrouter';
    settings.profiles.openrouter = makeProviderProfile('openrouter', {
      apiKey: 'sk-or-test',
    });
    settings.profiles.anthropic = makeProviderProfile('anthropic', {
      apiKey: 'sk-ant-keep',
    });
    saveAISettings(settings);

    renderPanel();
    await flushAsync();

    const remove = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Remove OpenRouter key'),
    );
    expect(remove).toBeDefined();
    await act(async () => remove?.click());
    await flushAsync();

    expect(getAISettings().profiles.openrouter.apiKey).toBe('');
    expect(getAISettings().profiles.anthropic.apiKey).toBe('sk-ant-keep');
  });
});
