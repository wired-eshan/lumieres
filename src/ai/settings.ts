/**
 * User-owned AI configuration.
 *
 * The API key belongs to the person using the app and is stored **only** in
 * this browser's `localStorage`. It is deliberately not part of the graph
 * document: saving, exporting or importing a canvas must never move a secret
 * into a file. Requests go directly from this browser to the OpenAI-compatible
 * provider configured here, which is why the UI warns that the key is
 * client-side and only as safe as the device.
 *
 * The store is a tiny external store (`useSyncExternalStore` friendly) so the
 * settings panel, toolbar indicator and chat panels all observe one value.
 */

import { normalizeReasoningEffort, type ReasoningEffort } from './reasoning';

export interface AISettings {
  apiKey: string;
  /** OpenAI-compatible base URL, including the version segment (usually `/v1`). */
  baseUrl: string;
  model: string;
  /** `''` means the provider default; only sent when the model supports it. */
  reasoningEffort: ReasoningEffort | '';
}

export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1';
/**
 * Fallback when `/models` has not been loaded. The model picker replaces this
 * with a real id from the provider as soon as discovery succeeds.
 */
export const DEFAULT_AI_MODEL = 'gpt-4o-mini';

const STORAGE_KEY = 'lumieres:ai-settings';

export const DEFAULT_AI_SETTINGS: AISettings = {
  apiKey: '',
  baseUrl: DEFAULT_AI_BASE_URL,
  model: DEFAULT_AI_MODEL,
  reasoningEffort: '',
};

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const candidate = window.localStorage;
    if (!candidate || typeof candidate.getItem !== 'function') return null;
    return candidate;
  } catch {
    return null;
  }
}

/** Trims whitespace and trailing slashes; only absolute http(s) URLs are accepted. */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_AI_BASE_URL;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return DEFAULT_AI_BASE_URL;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_AI_BASE_URL;
    return trimmed;
  } catch {
    return DEFAULT_AI_BASE_URL;
  }
}

export function isValidBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeModel(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_AI_MODEL;
  const trimmed = value.trim();
  if (trimmed.length === 0) return DEFAULT_AI_MODEL;
  // Settings written by the previous Anthropic-only build cannot be used with
  // the OpenAI transport. Move those to the fallback rather than silently
  // sending an unavailable model id on the next request.
  if (/^claude[-:]/i.test(trimmed)) return DEFAULT_AI_MODEL;
  return trimmed;
}

function normalize(value: unknown): AISettings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_AI_SETTINGS };
  const record = value as Record<string, unknown>;
  return {
    apiKey: typeof record.apiKey === 'string' ? record.apiKey.trim() : '',
    baseUrl: normalizeBaseUrl(record.baseUrl),
    model: normalizeModel(record.model),
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort ?? record.effort),
  };
}

function read(): AISettings {
  const storage = safeStorage();
  if (!storage) return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    return normalize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

let current = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getAISettings(): AISettings {
  return current;
}

export function isAIConfigured(settings: AISettings = current): boolean {
  return settings.apiKey.length > 0;
}

/** Persists and broadcasts a complete settings value. */
export function saveAISettings(next: AISettings): AISettings {
  current = normalize(next);
  const storage = safeStorage();
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(current));
    } catch {
      // Private mode / quota: the setting still works for this page session.
    }
  }
  emit();
  return current;
}

export function clearAIKey(): AISettings {
  return saveAISettings({ ...current, apiKey: '' });
}

export function subscribeAISettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook: re-reads storage and broadcasts, as if another tab had written. */
export function reloadAISettings(): AISettings {
  current = read();
  emit();
  return current;
}
