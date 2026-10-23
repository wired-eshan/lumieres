/**
 * User-owned AI configuration, stored per provider.
 *
 * The API key belongs to the person using the app and lives **only** in this
 * browser's `localStorage`. It is deliberately not part of the graph document:
 * saving, exporting or importing a canvas must never move a secret into a file.
 * Keys are kept in separate provider profiles, so switching from OpenRouter to
 * Anthropic cannot accidentally send OpenRouter's key to Anthropic.
 *
 * Requests go directly from this browser to the provider configured here,
 * which is why the UI warns that a browser-held key is only as safe as the
 * device. This module is a tiny external store (`useSyncExternalStore` friendly)
 * so the settings dialog, the chat panel and the runtime all observe one value.
 */

import {
  DEFAULT_CUSTOM_PROTOCOL,
  DEFAULT_PROVIDER_ID,
  PROVIDER_ORDER,
  PROVIDERS,
  getProviderDefinition,
  isApiProtocol,
  isOpenRouterBaseUrl,
  isProviderId,
  normalizeBaseUrl,
  resolveProviderConfig,
  type ApiProtocol,
  type ProviderEffortMetadata,
  type ProviderId,
  type ProviderProfile,
  type ResolvedProviderConfig,
} from './provider';
import { normalizeReasoningEffort, sortReasoningEfforts } from './reasoning';

export const AI_SETTINGS_SCHEMA_VERSION = 2;
const STORAGE_KEY = 'lumieres:ai-settings';

export interface AISettings {
  schemaVersion: typeof AI_SETTINGS_SCHEMA_VERSION;
  /** The provider new requests use. */
  providerId: ProviderId;
  /** Chosen by the user only for the custom endpoint. */
  customProtocol: ApiProtocol;
  /** Every provider keeps its own key, endpoint override, model and effort. */
  profiles: Record<ProviderId, ProviderProfile>;
}

function defaultProfile(providerId: ProviderId): ProviderProfile {
  const definition = getProviderDefinition(providerId);
  return {
    apiKey: '',
    baseUrl: '',
    model: definition.defaultModel,
    reasoningEffort: '',
    effortCapability: null,
  };
}

export function createDefaultAISettings(): AISettings {
  const profiles = {} as Record<ProviderId, ProviderProfile>;
  for (const providerId of PROVIDER_ORDER) profiles[providerId] = defaultProfile(providerId);
  return {
    schemaVersion: AI_SETTINGS_SCHEMA_VERSION,
    providerId: DEFAULT_PROVIDER_ID,
    customProtocol: DEFAULT_CUSTOM_PROTOCOL,
    profiles,
  };
}

export const DEFAULT_AI_SETTINGS: AISettings = createDefaultAISettings();

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEffortCapability(
  value: unknown,
  modelId: string,
): ProviderEffortMetadata | null {
  if (!isRecord(value)) return null;
  if (readString(value.modelId) !== modelId || modelId.length === 0) return null;
  const source = value.source;
  if (
    source !== 'metadata' &&
    source !== 'declared' &&
    source !== 'inferred' &&
    source !== 'none'
  ) {
    return null;
  }
  const efforts = sortReasoningEfforts(
    Array.isArray(value.efforts) ? value.efforts : [],
  );
  if (source !== 'none' && efforts.length === 0) return null;
  return {
    modelId,
    // A 'none' source means no model capability is known; ignore any stray
    // levels so malformed storage cannot re-enable a level.
    efforts: source === 'none' ? [] : efforts,
    source,
    defaultEffort: normalizeReasoningEffort(value.defaultEffort),
    mandatory: value.mandatory === true,
    note: readString(value.note),
  };
}

/**
 * Normalises one provider's profile. A built-in provider's empty/blank base URL
 * means "use the documented default"; a custom profile keeps an invalid value
 * empty so validation can explain what is missing rather than silently pointing
 * somewhere else.
 */
export function normalizeProviderProfile(
  providerId: ProviderId,
  value: unknown,
  customProtocol: ApiProtocol = DEFAULT_CUSTOM_PROTOCOL,
): ProviderProfile {
  const definition = getProviderDefinition(providerId);
  const record = isRecord(value) ? value : {};
  const protocol = providerId === 'custom' ? customProtocol : definition.protocol;
  const rawBaseUrl = readString(record.baseUrl);
  const normalizedBaseUrl = normalizeBaseUrl(rawBaseUrl, '', protocol);
  const baseUrl =
    normalizedBaseUrl.length > 0 && normalizedBaseUrl !== definition.defaultBaseUrl
      ? normalizedBaseUrl
      : '';
  const rawModel = readString(record.model);
  const model =
    rawModel.length > 0
      ? rawModel
      : providerId === 'custom'
        ? ''
        : definition.defaultModel;

  return {
    apiKey: readString(record.apiKey),
    baseUrl,
    model,
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort ?? record.effort),
    effortCapability: normalizeEffortCapability(record.effortCapability, model),
  };
}

function inferLegacyProvider(record: Record<string, unknown>): ProviderId {
  const baseUrl = readString(record.baseUrl);
  if (baseUrl.length > 0) {
    if (isOpenRouterBaseUrl(baseUrl)) return 'openrouter';
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      if (host === 'api.openai.com' || host === 'openai.com' || host.endsWith('.openai.com')) {
        return 'openai';
      }
      if (host === 'api.deepseek.com' || host.endsWith('.deepseek.com')) return 'deepseek';
      if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return 'anthropic';
      return 'custom';
    } catch {
      // An unreadable legacy base URL still carries intent; fall through to the
      // model-id check below.
    }
  }

  const model = readString(record.model);
  // The original build was Anthropic-only. A bare Claude id there is an
  // Anthropic model, whereas an OpenRouter id is namespaced (`anthropic/...`)
  // and stays with OpenRouter.
  if (/^claude[-:]/i.test(model)) return 'anthropic';
  return DEFAULT_PROVIDER_ID;
}

/**
 * Migrates the flat schema-1 settings value into per-provider profiles.
 *
 * A custom endpoint from the old build spoke Chat Completions, so it keeps
 * that protocol. Built-in endpoints map to their native protocol. The key is
 * never copied to more than the one provider it belonged to.
 */
function migrateLegacy(record: Record<string, unknown>): AISettings {
  const providerId = inferLegacyProvider(record);
  const definition = getProviderDefinition(providerId);
  const protocol: ApiProtocol =
    providerId === 'custom' ? 'openai-chat' : definition.protocol;
  const rawBaseUrl = readString(record.baseUrl);
  const rawModel = readString(record.model);

  let model = rawModel;
  if (model.length === 0) model = providerId === 'custom' ? '' : definition.defaultModel;
  // An un-namespaced Claude id is not a valid OpenRouter id.
  if (providerId === 'openrouter' && /^claude[-:]/i.test(model)) model = definition.defaultModel;

  const normalizedBaseUrl = normalizeBaseUrl(rawBaseUrl, '', protocol);
  const migratedProfile: ProviderProfile = {
    apiKey: readString(record.apiKey),
    baseUrl:
      providerId === 'custom'
        ? normalizedBaseUrl
        : normalizedBaseUrl === definition.defaultBaseUrl
          ? ''
          : normalizedBaseUrl,
    model,
    reasoningEffort: normalizeReasoningEffort(record.reasoningEffort ?? record.effort),
    effortCapability: null,
  };

  const next = createDefaultAISettings();
  next.providerId = providerId;
  next.profiles[providerId] = migratedProfile;
  if (providerId === 'custom') next.customProtocol = protocol;
  return next;
}

/** Pure, tolerant normaliser used by storage reads and public saves. */
export function normalizeAISettings(value: unknown): AISettings {
  if (!isRecord(value)) return createDefaultAISettings();

  // New shape: always rebuild every profile so malformed or partial storage
  // cannot leave a provider without a profile.
  if (isRecord(value.profiles)) {
    const next = createDefaultAISettings();
    next.providerId = isProviderId(value.providerId)
      ? value.providerId
      : DEFAULT_PROVIDER_ID;
    next.customProtocol = isApiProtocol(value.customProtocol)
      ? value.customProtocol
      : DEFAULT_CUSTOM_PROTOCOL;
    for (const providerId of PROVIDER_ORDER) {
      next.profiles[providerId] = normalizeProviderProfile(
        providerId,
        value.profiles[providerId],
        next.customProtocol,
      );
    }
    return next;
  }

  // Old shape: { apiKey, baseUrl, model, reasoningEffort }.
  if (
    'apiKey' in value ||
    'baseUrl' in value ||
    'model' in value ||
    'reasoningEffort' in value ||
    'effort' in value
  ) {
    return migrateLegacy(value);
  }

  return createDefaultAISettings();
}

function read(): AISettings {
  const storage = safeStorage();
  if (!storage) return createDefaultAISettings();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultAISettings();
    return normalizeAISettings(JSON.parse(raw));
  } catch {
    return createDefaultAISettings();
  }
}

let current = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

// Keep multiple app tabs in agreement, especially when one tab removes a key.
// An open Settings draft still wins on its next Save (last write wins), but the
// runtime stops using a key another tab has cleared as soon as this fires.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      current = read();
      emit();
    }
  });
}

function persist(settings: AISettings): AISettings {
  current = settings;
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

export function getAISettings(): AISettings {
  return current;
}

export function getProviderProfile(
  settings: AISettings,
  providerId: ProviderId,
): ProviderProfile {
  return settings.profiles[providerId] ?? defaultProfile(providerId);
}

export function getActiveProviderProfile(settings: AISettings = current): ProviderProfile {
  return getProviderProfile(settings, settings.providerId);
}

/** Resolves the active profile into the config the transport needs. */
export function resolveAISettings(settings: AISettings = current): ResolvedProviderConfig {
  return resolveProviderConfig({
    providerId: settings.providerId,
    profile: getActiveProviderProfile(settings),
    customProtocol: settings.customProtocol,
  });
}

/** True when the *active provider* has a key. Other providers' keys do not count. */
export function isAIConfigured(settings: AISettings = current): boolean {
  return getActiveProviderProfile(settings).apiKey.trim().length > 0;
}

/** Persists and broadcasts a complete settings value. */
export function saveAISettings(next: AISettings): AISettings {
  return persist(normalizeAISettings(next));
}

/** Updates one provider's profile without changing the active provider. */
export function saveProviderProfile(
  providerId: ProviderId,
  profile: ProviderProfile,
  customProtocol: ApiProtocol = current.customProtocol,
): AISettings {
  const next = normalizeAISettings(current);
  next.customProtocol = customProtocol;
  next.profiles[providerId] = normalizeProviderProfile(
    providerId,
    profile,
    customProtocol,
  );
  return persist(next);
}

export function setActiveProvider(providerId: ProviderId): AISettings {
  const next = normalizeAISettings(current);
  next.providerId = providerId;
  return persist(next);
}

/** Clears only the given provider's key (defaults to the active provider). */
export function clearAIKey(providerId: ProviderId = current.providerId): AISettings {
  const next = normalizeAISettings(current);
  next.profiles[providerId] = {
    ...next.profiles[providerId],
    apiKey: '',
  };
  return persist(next);
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

/** Convenience for tests and defaults; kept free of storage side effects. */
export function makeProviderProfile(
  providerId: ProviderId,
  patch: Partial<ProviderProfile> = {},
): ProviderProfile {
  return { ...defaultProfile(providerId), ...patch };
}

/** Provider-neutral aliases retained for callers that just need the fallback. */
export { PROVIDERS, PROVIDER_ORDER, type ProviderId, type ProviderProfile };
