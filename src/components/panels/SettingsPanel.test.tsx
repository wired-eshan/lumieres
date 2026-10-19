/**
 * The settings dialog is the only place a user picks a provider model and its
 * reasoning effort. These tests exercise the real panel against a mocked
 * `/models` call to guard the two failure modes reported in the UI: a model
 * picker that filters its options, and an empty effort picker.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from './SettingsPanel';
import { DEFAULT_AI_BASE_URL, saveAISettings } from '../../ai/settings';

const openaiMock = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    models = { list: openaiMock.list };
  },
}));

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
}

beforeEach(() => {
  window.localStorage.clear();
  saveAISettings({
    apiKey: 'sk-test',
    baseUrl: DEFAULT_AI_BASE_URL,
    model: 'gpt-4o-mini',
    reasoningEffort: '',
  });
  openaiMock.list.mockResolvedValue({
    data: [
      { id: 'gpt-4o-mini', owned_by: 'openai', created: 1 },
      { id: 'gpt-5', owned_by: 'openai', created: 2 },
      { id: 'text-embedding-3-small', owned_by: 'openai', created: 3 },
    ],
    hasNextPage: () => false,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  openaiMock.list.mockReset();
});

describe('Settings model and effort pickers', () => {
  it('shows every fetched model in an unfiltered select', async () => {
    renderPanel();
    await flushAsync();

    const select = container.querySelector<HTMLSelectElement>('#ai-model-select');
    expect(select).not.toBeNull();
    const values = [...(select?.options ?? [])].map((option) => option.value);
    expect(values).toContain('gpt-4o-mini');
    expect(values).toContain('gpt-5');
    expect(values).toContain('text-embedding-3-small');
    expect(values).toContain('__custom_model__');
  });

  it('populates effort levels as soon as a reasoning model is selected', async () => {
    renderPanel();
    await flushAsync();

    const model = container.querySelector<HTMLSelectElement>('#ai-model-select');
    const effort = container.querySelector<HTMLSelectElement>(
      'select[aria-describedby="settings-effort-help"]',
    );
    expect(model).not.toBeNull();
    expect(effort).not.toBeNull();
    // The initial gpt-4o-mini has no reasoning-effort levels.
    expect(effort?.disabled).toBe(true);

    await act(async () => {
      if (!model) return;
      model.value = 'gpt-5';
      model.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(effort?.disabled).toBe(false);
    expect([...(effort?.options ?? [])].map((option) => option.value)).toEqual([
      '',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });
});
