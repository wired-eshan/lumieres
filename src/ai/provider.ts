/**
 * Provider registry and configuration resolution.
 *
 * This module is the single source of truth for *which* API a conversation
 * talks to: provider ids, display metadata, default endpoints, protocols and
 * capability flags. UI components and the chat runtime read providers from
 * here; no component should branch on a provider id to decide how a request is
 * shaped. The adapters in `ai/adapters/` own the protocol details.
 *
 * Endpoint defaults are documented values, not immutable values. A profile may
 * override the base URL (for a proxy, gateway or self-hosted service), and the
 * normaliser below strips a pasted endpoint path so the SDK appends the right
 * one exactly once. It never appends `/v1` on its own: some providers do not
 * use that convention, and guessing would silently send requests to the wrong
 * path.
 */

import { REASONING_EFFORT_LEVELS, type ReasoningEffort } from './reasoning';

export type ProviderId = 'openai' | 'openrouter' | 'deepseek' | 'anthropic' | 'custom';

/**
 * Wire protocols the app can speak.
 *
 * `openai-responses` is the preferred OpenAI-compatible protocol. `openai-chat`
 * exists only for custom endpoints that have not implemented the Responses
 * API; built-in providers never use it, so the app never falls back from
 * Responses to Chat Completions for them. `anthropic-messages` is Anthropic's
 * native API and is not an OpenAI-compatible endpoint.
 */
export type ApiProtocol = 'openai-responses' | 'anthropic-messages' | 'openai-chat';

export const CUSTOM_PROTOCOLS: readonly ApiProtocol[] = [
  'openai-responses',
  'anthropic-messages',
  'openai-chat',
];

export const API_PROTOCOL_LABELS: Record<ApiProtocol, string> = {
  'openai-responses': 'OpenAI Responses API',
  'anthropic-messages': 'Anthropic Messages API',
  'openai-chat': 'OpenAI Chat Completions (legacy)',
};

export interface ProviderCapabilities {
  /** The provider implements the OpenAI Responses API. */
  responsesApi: boolean;
  /** Incremental response streaming is supported. */
  streaming: boolean;
  /**
   * Levels the provider's API can represent. This is the outer bound; the
   * per-model table in `ai/effort.ts` narrows it before a request is sent or
   * the effort control is offered.
   */
  reasoningEfforts: readonly ReasoningEffort[];
  /**
   * Whether the provider supports `previous_response_id`. Capability is not
   * permission: the runtime only uses continuation when the history is a
   * strict append-only extension and the provider+model still match.
   */
  supportsPreviousResponseId: boolean;
  /** How this provider's model picker is populated. */
  modelCatalogue: 'openrouter-catalogue' | 'provider-models' | 'anthropic-models' | 'none';
  /** A user-supplied base URL is meaningful for this provider. */
  customBaseUrl: boolean;
  /**
   * Some Responses-compatible proxies require replaying assistant turns as
   * output items (`type: "message"`, `id`, `status`, `output_text` content)
   * rather than plain `{ role, content }` messages. OpenRouter documents this;
   * OpenAI and DeepSeek accept the plain normalized form.
   */
  requiresAssistantMessageMetadata: boolean;
}

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  /** Built-in providers have a fixed protocol. Custom chooses one. */
  protocol: ApiProtocol;
  defaultBaseUrl: string;
  /** Per-provider fallback; deliberately not one global default. */
  defaultModel: string;
  keyPlaceholder: string;
  keyHint: string;
  /** Where a user can create a key, when the provider documents a page. */
  apiKeyUrl: string | null;
  baseUrlHint: string;
  /** The user must choose the protocol (custom endpoints). */
  selectableProtocol: boolean;
  /** A base URL is required rather than defaulted from the registry. */
  requiresBaseUrl: boolean;
  /** A model id is required rather than defaulted from the registry. */
  requiresModel: boolean;
  /** Model discovery works without an API key (OpenRouter's public catalogue). */
  publicCatalogue: boolean;
  capabilities: ProviderCapabilities;
}

/**
 * Effort metadata cached with a profile.
 *
 * The model picker may learn from an authoritative catalogue that a model
 * supports only some levels. Persisting that fact next to the selected model
 * keeps the transport's mapping consistent with the UI after a reload, instead
 * of silently falling back to a weaker family inference. `modelId` makes the
 * cache self-invalidating when the user types a different model id.
 */
export interface ProviderEffortMetadata {
  modelId: string;
  efforts: ReasoningEffort[];
  source: 'metadata' | 'declared' | 'inferred' | 'none';
  defaultEffort: ReasoningEffort | '';
  mandatory: boolean;
  note: string;
}

/** Per-provider values stored in browser-local settings. */
export interface ProviderProfile {
  apiKey: string;
  /**
   * `''` means the registry default. Custom profiles must set this explicitly.
   * The value is always normalised before storage.
   */
  baseUrl: string;
  /** `''` means the provider default for built-ins; required for custom. */
  model: string;
  /** `''` means the provider default effort (omit the parameter). */
  reasoningEffort: ReasoningEffort | '';
  /** Last known effort capability for `model`, or null when unknown. */
  effortCapability: ProviderEffortMetadata | null;
}

/** A resolved, ready-to-send provider configuration. */
export interface ResolvedProviderConfig {
  providerId: ProviderId;
  definition: ProviderDefinition;
  capabilities: ProviderCapabilities;
  protocol: ApiProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: ReasoningEffort | '';
  effortCapability: ProviderEffortMetadata | null;
  /**
   * Whether this *resolved endpoint* may use provider-managed continuation.
   * Capability alone is not enough: an OpenAI base-URL override may be a proxy
   * that rejects `store`/`previous_response_id`, so continuation is enabled
   * only for the documented OpenAI endpoint.
   */
  continuationEnabled: boolean;
}

export type ProviderConfigIssueCode =
  | 'unsupported_protocol'
  | 'missing_api_key'
  | 'missing_model'
  | 'missing_base_url'
  | 'invalid_base_url';

export interface ProviderConfigIssue {
  code: ProviderConfigIssueCode;
  message: string;
}

const ALL_EFFORTS = REASONING_EFFORT_LEVELS;
const ANTHROPIC_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Documented provider defaults.
 *
 * Sources are kept next to each value so a stale model id or endpoint is easy
 * to update without touching UI or transport code. The response-path comment is
 * what the OpenAI/Anthropic SDKs append to `baseUrl`; a base URL that already
 * ends with that path is normalised to avoid duplicating it.
 */
export const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-responses',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    keyPlaceholder: 'sk-…',
    keyHint: 'Create a project API key in the OpenAI dashboard.',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    baseUrlHint:
      'Usually https://api.openai.com/v1. The SDK appends /responses to this base.',
    selectableProtocol: false,
    requiresBaseUrl: false,
    requiresModel: false,
    publicCatalogue: false,
    capabilities: {
      responsesApi: true,
      streaming: true,
      reasoningEfforts: ALL_EFFORTS,
      supportsPreviousResponseId: true,
      modelCatalogue: 'provider-models',
      customBaseUrl: true,
      requiresAssistantMessageMetadata: false,
    },
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-responses',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    keyPlaceholder: 'sk-or-v1-…',
    keyHint: 'Create a key in OpenRouter. Its public model catalogue needs no key.',
    apiKeyUrl: 'https://openrouter.ai/keys',
    baseUrlHint:
      'Usually https://openrouter.ai/api/v1. The SDK appends /responses to this base.',
    selectableProtocol: false,
    requiresBaseUrl: false,
    requiresModel: false,
    publicCatalogue: true,
    capabilities: {
      responsesApi: true,
      streaming: true,
      // OpenRouter's OpenAPI enum is the full set; the prose reasoning guide
      // documents four. Per-model catalogue metadata is authoritative, and the
      // effort layer uses the four documented values only as a no-catalogue
      // fallback.
      reasoningEfforts: ALL_EFFORTS,
      supportsPreviousResponseId: false,
      modelCatalogue: 'openrouter-catalogue',
      customBaseUrl: true,
      requiresAssistantMessageMetadata: true,
    },
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-responses',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-flash',
    keyPlaceholder: 'sk-…',
    keyHint: 'Create a key in the DeepSeek platform.',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    baseUrlHint:
      'Usually https://api.deepseek.com (no /v1). The SDK appends /responses to this base.',
    selectableProtocol: false,
    requiresBaseUrl: false,
    requiresModel: false,
    publicCatalogue: false,
    capabilities: {
      responsesApi: true,
      streaming: true,
      reasoningEfforts: ALL_EFFORTS,
      supportsPreviousResponseId: false,
      modelCatalogue: 'provider-models',
      customBaseUrl: true,
      requiresAssistantMessageMetadata: false,
    },
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-opus-5-5',
    keyPlaceholder: 'sk-ant-…',
    keyHint: 'Create a key in the Anthropic Console.',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    baseUrlHint:
      'Usually https://api.anthropic.com. The SDK appends /v1/messages to this base.',
    selectableProtocol: false,
    requiresBaseUrl: false,
    requiresModel: false,
    publicCatalogue: false,
    capabilities: {
      responsesApi: false,
      streaming: true,
      reasoningEfforts: ANTHROPIC_EFFORTS,
      supportsPreviousResponseId: false,
      modelCatalogue: 'anthropic-models',
      customBaseUrl: true,
      requiresAssistantMessageMetadata: false,
    },
  },
  custom: {
    id: 'custom',
    label: 'Custom endpoint',
    protocol: 'openai-responses',
    defaultBaseUrl: '',
    defaultModel: '',
    keyPlaceholder: 'Your API key',
    keyHint: 'The key is sent only to the custom base URL you configure.',
    apiKeyUrl: null,
    baseUrlHint:
      'Required. Enter the base URL the SDK should use; do not include /responses, /v1/messages or /chat/completions.',
    selectableProtocol: true,
    requiresBaseUrl: true,
    requiresModel: true,
    publicCatalogue: false,
    capabilities: {
      responsesApi: true,
      streaming: true,
      reasoningEfforts: ALL_EFFORTS,
      supportsPreviousResponseId: false,
      modelCatalogue: 'provider-models',
      customBaseUrl: true,
      requiresAssistantMessageMetadata: false,
    },
  },
};

/**
 * OpenRouter's public model catalogue. It is unauthenticated; a key belonging
 * to any provider is never sent here. Derived from the registry's documented
 * base URL so the endpoint cannot drift from the chat transport.
 */
export const OPENROUTER_MODELS_URL = `${PROVIDERS.openrouter.defaultBaseUrl}/models`;

/** Display order in the settings dialog. OpenRouter remains the default. */
export const PROVIDER_ORDER: readonly ProviderId[] = [
  'openai',
  'openrouter',
  'deepseek',
  'anthropic',
  'custom',
];

export const DEFAULT_PROVIDER_ID: ProviderId = 'openrouter';
export const DEFAULT_CUSTOM_PROTOCOL: ApiProtocol = 'openai-responses';

export function isProviderId(value: unknown): value is ProviderId {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(PROVIDERS, value)
  );
}

export function isApiProtocol(value: unknown): value is ApiProtocol {
  return (
    value === 'openai-responses' ||
    value === 'anthropic-messages' ||
    value === 'openai-chat'
  );
}

export function getProviderDefinition(id: ProviderId): ProviderDefinition {
  return PROVIDERS[id];
}

/** True for OpenRouter's hosted API and its subdomains. Used by legacy migration. */
export function isOpenRouterBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}

export function protocolForProvider(id: ProviderId, customProtocol: ApiProtocol): ApiProtocol {
  return id === 'custom' ? customProtocol : PROVIDERS[id].protocol;
}

/**
 * The path each SDK appends to its configured base URL. Used for display,
 * validation and de-duplicating a pasted full endpoint.
 */
export function endpointPathForProtocol(protocol: ApiProtocol): string {
  switch (protocol) {
    case 'openai-responses':
      return '/responses';
    case 'anthropic-messages':
      return '/v1/messages';
    case 'openai-chat':
      return '/chat/completions';
  }
}

/** Absolute http(s) URL check; deliberately rejects credentials, query and hash. */
export function isValidBaseUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.username.length > 0 || url.password.length > 0) return false;
    // A base URL is an origin plus a path; query strings and fragments are not
    // part of the endpoint the SDK appends to.
    if (url.search.length > 0 || url.hash.length > 0) return false;
    return true;
  } catch {
    return false;
  }
}

function stripTrailingSlashes(pathname: string): string {
  return pathname.replace(/\/+$/, '');
}

/**
 * Removes a pasted endpoint suffix so the SDK does not append it twice.
 *
 * All known endpoint shapes are stripped, not only the selected protocol's:
 * a user switching protocols or pasting the wrong full endpoint should not end
 * up with `/chat/completions/responses`. The version segment is then handled
 * per protocol — Anthropic's SDK adds `/v1/messages`, so a trailing `/v1` is
 * removed there; the OpenAI-shaped SDKs add only the final path segment, so
 * `/v1` is kept for them.
 *
 * `https://host/v1/responses` -> `https://host/v1`
 * `https://host/v1/messages`  -> `https://host` (the Anthropic SDK adds /v1)
 * `https://host/v1/chat/completions` -> `https://host/v1`
 */
function stripEndpointSuffix(pathname: string, protocol: ApiProtocol): string {
  let path = stripTrailingSlashes(pathname);

  // Strip only the final endpoint segment here; the version segment is
  // protocol-specific and handled below. This keeps `/v1` for OpenAI-shaped
  // APIs even when the user pasted something like `/v1/messages`.
  path = path.replace(
    /\/(?:chat\/completions|responses|messages)$/i,
    '',
  );
  path = stripTrailingSlashes(path);

  if (protocol === 'anthropic-messages') {
    path = path.replace(/\/v1$/i, '');
    path = stripTrailingSlashes(path);
  }
  return path;
}

/**
 * Normalises a user-entered base URL without inventing path segments.
 *
 * Returns `fallback` when the value is empty or invalid. Built-in providers pass
 * their documented default; the custom provider passes `''` so an invalid URL
 * stays visibly invalid instead of silently becoming some other endpoint.
 */
export function normalizeBaseUrl(
  value: string | null | undefined,
  fallback: string,
  protocol: ApiProtocol,
): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fallback;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
  if (url.username.length > 0 || url.password.length > 0) return fallback;

  const path = stripEndpointSuffix(url.pathname, protocol);
  const origin = `${url.protocol}//${url.host}`;
  return path.length > 0 ? `${origin}${path}` : origin;
}

/** The URL a request will actually hit, for display in Settings. */
export function endpointUrlForConfig(config: {
  baseUrl: string;
  protocol: ApiProtocol;
}): string {
  if (config.baseUrl.length === 0) return '';
  return `${config.baseUrl.replace(/\/+$/, '')}${endpointPathForProtocol(config.protocol)}`;
}

export function resolveBaseUrl(
  definition: ProviderDefinition,
  rawBaseUrl: string,
  protocol: ApiProtocol,
): string {
  // Built-ins fall back to their documented default; custom keeps an invalid or
  // empty value so validation can explain what is missing.
  return normalizeBaseUrl(rawBaseUrl, definition.defaultBaseUrl, protocol);
}

export interface ResolveProviderConfigInput {
  providerId: ProviderId;
  profile: ProviderProfile;
  customProtocol: ApiProtocol;
}

export function resolveProviderConfig(
  input: ResolveProviderConfigInput,
): ResolvedProviderConfig {
  const definition = getProviderDefinition(input.providerId);
  const protocol = protocolForProvider(input.providerId, input.customProtocol);
  const baseUrl = resolveBaseUrl(definition, input.profile.baseUrl, protocol);
  return {
    providerId: input.providerId,
    definition,
    capabilities: definition.capabilities,
    protocol,
    apiKey: input.profile.apiKey.trim(),
    baseUrl,
    model: input.profile.model.trim() || definition.defaultModel,
    reasoningEffort: input.profile.reasoningEffort,
    effortCapability: input.profile.effortCapability,
    continuationEnabled:
      definition.capabilities.supportsPreviousResponseId &&
      (input.providerId !== 'openai' || baseUrl === definition.defaultBaseUrl),
  };
}

/**
 * Returns configuration problems a person can act on. A missing API key is
 * reported separately by the runtime as `NO_KEY`, but including it here keeps
 * the rules in one place.
 */
export function validateProviderConfig(
  config: ResolvedProviderConfig,
): ProviderConfigIssue[] {
  const issues: ProviderConfigIssue[] = [];
  const definition = config.definition;

  if (config.providerId !== 'custom' && config.protocol !== definition.protocol) {
    issues.push({
      code: 'unsupported_protocol',
      message: `${definition.label} uses ${API_PROTOCOL_LABELS[definition.protocol]} and cannot be routed through ${API_PROTOCOL_LABELS[config.protocol]}.`,
    });
  }
  if (config.providerId === 'custom' && !CUSTOM_PROTOCOLS.includes(config.protocol)) {
    issues.push({
      code: 'unsupported_protocol',
      message: 'Choose the API protocol the custom endpoint implements.',
    });
  }
  if (config.apiKey.length === 0) {
    issues.push({
      code: 'missing_api_key',
      message: `Add an API key for ${definition.label} in Settings.`,
    });
  }
  if (config.model.length === 0) {
    issues.push({
      code: 'missing_model',
      message: 'Choose or enter a model id in Settings.',
    });
  }
  if (config.baseUrl.length === 0) {
    issues.push({
      code: 'missing_base_url',
      message: 'Enter the custom provider’s base URL in Settings.',
    });
  } else if (!isValidBaseUrl(config.baseUrl)) {
    issues.push({
      code: 'invalid_base_url',
      message: 'Enter a valid http(s) base URL in Settings.',
    });
  }
  return issues;
}
