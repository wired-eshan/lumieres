/**
 * Model discovery and reasoning-effort metadata.
 *
 * Providers expose very different catalogue shapes. The registry decides which
 * discovery path applies; this module only knows how to read each shape:
 *
 *  - OpenRouter publishes a uniform public catalogue with per-model
 *    `reasoning.supported_efforts`. That catalogue is unauthenticated; a key
 *    belonging to another provider is never sent to it.
 *  - OpenAI and DeepSeek expose the conventional `/models` list, which carries
 *    ids but no reliable per-model effort metadata. Their effort table lives in
 *    `ai/effort.ts` and is applied here.
 *  - Anthropic's Models API carries `capabilities.effort`, which is
 *    authoritative and parsed directly.
 *  - A custom endpoint may expose either convention; its effort metadata is
 *    labelled inferred because implementing a protocol does not prove a
 *    model's options.
 *
 * The returned list is transient UI state. Model selection, effort and keys
 * live in `ai/settings.ts`; nothing here writes to the graph document.
 */

import {
  capabilitiesFor,
  type EffortCapability,
  type ReasoningEffortSource,
} from './effort';
import { AIRequestError, describeError, isAbortError, isRetryable } from './errors';
import {
  OPENROUTER_MODELS_URL,
  getProviderDefinition,
  type ApiProtocol,
  type ProviderEffortMetadata,
  type ProviderId,
} from './provider';
import {
  DEFAULT_REASONING_EFFORTS,
  REASONING_EFFORT_LEVELS,
  inferReasoningEfforts,
  normalizeReasoningEffort,
  sortReasoningEfforts,
  type ReasoningEffort,
} from './reasoning';

export type { ReasoningEffortSource };

export interface ProviderModel {
  id: string;
  /** Human-readable name advertised by the catalogue, when present. */
  name: string | null;
  ownedBy: string | null;
  createdAt: number | null;
  /** Advertised input context length, when the catalogue provides one. */
  contextLength: number | null;
  /** Empty means the model does not advertise reasoning-effort levels. */
  reasoningEfforts: ReasoningEffort[];
  /** Where the levels came from, so the UI can be precise about it. */
  reasoningEffortSource: ReasoningEffortSource;
  /** Provider default effort, or `''` when none is advertised. */
  defaultReasoningEffort: ReasoningEffort | '';
  /** When true the provider requires reasoning; `none` is not a valid choice. */
  reasoningMandatory: boolean;
}

export interface FetchProviderModelsInput {
  providerId: ProviderId;
  protocol: ApiProtocol;
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
  /** Injection point for tests; only the public OpenRouter path uses `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface FetchOpenRouterModelsInput {
  signal?: AbortSignal;
  /** Injection point for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The model picker's starting list, available before (or without) a network
 * call. These are per-provider defaults and documented current models, never a
 * single universal model id.
 */
const SEED_MODEL_IDS: Partial<
  Record<ProviderId, Array<{ id: string; name?: string; contextLength?: number }>>
> = {
  deepseek: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  ],
  anthropic: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextLength: 1_000_000 },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextLength: 1_000_000 },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', contextLength: 1_000_000 },
    { id: 'claude-opus-5', name: 'Claude Opus 5', contextLength: 1_000_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextLength: 1_000_000 },
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', contextLength: 1_000_000 },
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', contextLength: 1_000_000 },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextLength: 1_000_000 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextLength: 1_000_000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextLength: 1_000_000 },
  ],
};

function seedModel(
  providerId: ProviderId,
  protocol: ApiProtocol,
  id: string,
  name: string | null,
  contextLength: number | null,
): ProviderModel {
  const capability = capabilitiesFor({ providerId, protocol, modelId: id });
  return {
    id,
    name,
    ownedBy: providerId === 'custom' ? null : getProviderDefinition(providerId).label,
    createdAt: null,
    contextLength,
    reasoningEfforts: capability.efforts,
    reasoningEffortSource: capability.source,
    defaultReasoningEffort: capability.defaultEffort,
    reasoningMandatory: capability.mandatory,
  };
}

/**
 * A useful model list before discovery completes. OpenRouter's seed is its
 * configured default; OpenAI's is its documented default. Custom endpoints have
 * no safe seed, so their model field stays free text until discovery.
 */
export function seedProviderModels(
  providerId: ProviderId,
  protocol: ApiProtocol,
): ProviderModel[] {
  const definition = getProviderDefinition(providerId);
  const seeds = SEED_MODEL_IDS[providerId] ?? [];
  const models = seeds.map((seed) =>
    seedModel(providerId, protocol, seed.id, seed.name ?? null, seed.contextLength ?? null),
  );
  if (providerId !== 'custom' && definition.defaultModel.length > 0) {
    if (!models.some((model) => model.id === definition.defaultModel)) {
      models.unshift(
        seedModel(providerId, protocol, definition.defaultModel, definition.defaultModel, null),
      );
    }
  }
  return sortProviderModels(models);
}

/**
 * Loads the model list for the configured provider.
 *
 * OpenRouter's public catalogue needs no key. All other providers require the
 * selected provider's key; it is sent only to that provider's endpoint.
 */
export async function fetchProviderModels(
  input: FetchProviderModelsInput,
): Promise<ProviderModel[]> {
  // The public catalogue exists only at OpenRouter's documented endpoint. If
  // the user has pointed the OpenRouter profile at a gateway/proxy, list that
  // endpoint's own models with its key instead of bypassing the configured URL.
  if (
    input.providerId === 'openrouter' &&
    input.baseUrl === getProviderDefinition('openrouter').defaultBaseUrl
  ) {
    return fetchOpenRouterModels({
      signal: input.signal,
      fetchImpl: input.fetchImpl,
    });
  }

  if (input.apiKey.trim().length === 0) {
    throw new AIRequestError(
      `Add a ${getProviderDefinition(input.providerId).label} API key before loading its models.`,
    );
  }

  if (
    input.providerId === 'anthropic' ||
    (input.providerId === 'custom' && input.protocol === 'anthropic-messages')
  ) {
    return fetchAnthropicModels(input);
  }
  return fetchOpenAICompatibleModels(input);
}

/**
 * Fetches OpenRouter's public model catalogue. No API key is required or sent.
 */
export async function fetchOpenRouterModels(
  input: FetchOpenRouterModelsInput = {},
): Promise<ProviderModel[]> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new AIRequestError('Model discovery is unavailable in this environment.');
  }

  let response: Response;
  try {
    response = await fetchImpl(OPENROUTER_MODELS_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      throw new AIRequestError('Model loading stopped.', false);
    }
    throw new AIRequestError(
      'Could not reach OpenRouter’s model catalogue. Check the network connection and try again.',
      true,
    );
  }

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    const message =
      response.status === 429
        ? 'OpenRouter rate-limited the model catalogue. Wait a moment and try again.'
        : `OpenRouter’s model catalogue returned HTTP ${response.status}. Try again shortly.`;
    throw new AIRequestError(message, retryable);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      throw new AIRequestError('Model loading stopped.', false);
    }
    throw new AIRequestError('OpenRouter returned a model catalogue that could not be read.', true);
  }

  const records =
    isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : null;
  if (!records) {
    throw new AIRequestError('OpenRouter returned an unexpected model catalogue.', true);
  }
  return parseOpenRouterModels(records);
}

/** Parses OpenRouter's catalogue shape into the UI model records. */
export function parseOpenRouterModels(records: readonly unknown[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const record of records) {
    const model = parseOpenRouterModel(record);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return sortProviderModels([...byId.values()]);
}

export function parseOpenRouterModel(record: unknown): ProviderModel | null {
  if (!isRecord(record)) return null;
  const id = readString(record, 'id');
  if (!id) return null;

  const reasoning = isRecord(record.reasoning) ? record.reasoning : null;
  const mandatory = reasoning?.mandatory === true;
  const efforts = readOpenRouterEfforts(reasoning);
  const defaultEffort = normalizeReasoningEffort(reasoning?.default_effort);
  const topProvider = isRecord(record.top_provider) ? record.top_provider : null;
  const contextLength =
    readPositiveNumber(record.context_length) ?? readPositiveNumber(topProvider?.context_length);

  return {
    id,
    name: readString(record, 'name'),
    ownedBy: readString(record, 'owned_by') ?? readString(record, 'ownedBy') ?? providerPrefix(id),
    createdAt: typeof record.created === 'number' ? record.created : null,
    contextLength,
    reasoningEfforts: mandatory ? efforts.filter((effort) => effort !== 'none') : efforts,
    reasoningEffortSource: efforts.length > 0 ? 'metadata' : 'none',
    defaultReasoningEffort: mandatory && defaultEffort === 'none' ? '' : defaultEffort,
    reasoningMandatory: mandatory,
  };
}

/**
 * OpenRouter semantics: `supported_efforts` present and `null` means every
 * gateway level is accepted; omitted means the model has no effort selector.
 * Do not infer from the id here — the catalogue is authoritative.
 */
function readOpenRouterEfforts(reasoning: Record<string, unknown> | null): ReasoningEffort[] {
  if (!reasoning || !('supported_efforts' in reasoning)) return [];
  const supported = reasoning.supported_efforts;
  if (supported === null) return [...REASONING_EFFORT_LEVELS];

  const found: unknown[] = [];
  collectEfforts(supported, found);
  return sortReasoningEfforts(found);
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible discovery                                         */
/* ------------------------------------------------------------------ */

/** Reads a provider's conventional `GET /models` list. */
async function fetchOpenAICompatibleModels(
  input: FetchProviderModelsInput,
): Promise<ProviderModel[]> {
  let OpenAI: typeof import('openai').default;
  try {
    ({ default: OpenAI } = await import('openai'));
  } catch {
    throw new AIRequestError(
      'The AI transport could not be loaded. Check the connection and try again.',
      true,
    );
  }

  const client = new OpenAI({
    apiKey: input.apiKey,
    baseURL: input.baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });

  try {
    let page = await client.models.list(
      input.signal ? { signal: input.signal } : undefined,
    );
    const records: unknown[] = [...page.data];
    // OpenAI's list endpoint does not paginate today, but the SDK supports it
    // and compatible servers may. Bound the loop so a broken server cannot spin.
    let guard = 0;
    while (page.hasNextPage() && guard < 20) {
      page = await page.getNextPage();
      records.push(...page.data);
      guard += 1;
    }
    return applyProviderEffortMetadata(
      parseProviderModels(records),
      input.providerId,
      input.protocol,
    );
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      throw new AIRequestError('Model loading stopped.', false);
    }
    throw new AIRequestError(
      describeError(error, {
        secrets: [input.apiKey],
        providerLabel: getProviderDefinition(input.providerId).label,
      }),
      isRetryable(error),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic Models API                                                */
/* ------------------------------------------------------------------ */

async function fetchAnthropicModels(
  input: FetchProviderModelsInput,
): Promise<ProviderModel[]> {
  let Anthropic: typeof import('@anthropic-ai/sdk').default;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new AIRequestError(
      'The Anthropic transport could not be loaded. Check the connection and try again.',
      true,
    );
  }

  const client = new Anthropic({
    apiKey: input.apiKey,
    baseURL: input.baseUrl,
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
  });

  try {
    const records: ProviderModel[] = [];
    for await (const info of client.models.list(undefined, input.signal ? { signal: input.signal } : undefined)) {
      const model = parseAnthropicModel(info);
      if (model) records.push(model);
    }
    return applyProviderEffortMetadata(records, input.providerId, input.protocol);
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      throw new AIRequestError('Model loading stopped.', false);
    }
    throw new AIRequestError(
      describeError(error, {
        secrets: [input.apiKey],
        providerLabel: getProviderDefinition(input.providerId).label,
      }),
      isRetryable(error),
    );
  }
}

export function parseAnthropicModel(info: unknown): ProviderModel | null {
  if (!isRecord(info)) return null;
  const id = readString(info, 'id');
  if (!id) return null;
  if (info.lifecycle === 'retired') return null;

  const capabilities = isRecord(info.capabilities) ? info.capabilities : null;
  const effort = capabilities && isRecord(capabilities.effort) ? capabilities.effort : null;
  const supported = effort?.supported === true;
  const efforts = supported
    ? (['low', 'medium', 'high', 'xhigh', 'max'] as const).filter((level) =>
        capabilitySupported(effort?.[level]),
      )
    : [];
  const created = typeof info.created_at === 'string' ? Date.parse(info.created_at) : Number.NaN;

  return {
    id,
    name: readString(info, 'display_name'),
    ownedBy: typeof info.line === 'string' ? info.line : 'Anthropic',
    createdAt: Number.isFinite(created) ? created : null,
    contextLength: readPositiveNumber(info.max_input_tokens),
    reasoningEfforts: sortReasoningEfforts(efforts),
    // An effort object is an explicit provider answer even when it says
    // supported:false. No effort object means "no capability data", which may
    // fall back to the documented table.
    reasoningEffortSource: effort ? 'metadata' : 'none',
    defaultReasoningEffort: '',
    reasoningMandatory: false,
  };
}

function capabilitySupported(value: unknown): boolean {
  if (value === true) return true;
  return isRecord(value) && value.supported === true;
}

/* ------------------------------------------------------------------ */
/* Provider-aware effort metadata                                      */
/* ------------------------------------------------------------------ */

/**
 * Replaces a model's guessed effort levels with the provider's declared table
 * (or preserves Anthropic's authoritative Models API metadata). The `source`
 * makes the UI honest about how certain the capability is.
 */
export function applyProviderEffortMetadata(
  models: readonly ProviderModel[],
  providerId: ProviderId,
  protocol: ApiProtocol,
): ProviderModel[] {
  return models.map((model) => {
    // A provider-supplied capability (Anthropic's Models API, or a compatible
    // custom endpoint) is more specific than our family tables — including an
    // explicit "supported: false", which arrives as metadata with no levels.
    if (model.reasoningEffortSource === 'metadata') {
      return model;
    }
    const capability = capabilitiesFor({
      providerId,
      protocol,
      modelId: model.id,
    });
    return {
      ...model,
      reasoningEfforts: capability.efforts,
      reasoningEffortSource: capability.source,
      defaultReasoningEffort: capability.defaultEffort,
      reasoningMandatory: capability.mandatory,
    };
  });
}

/** Effort capability for the model picker's hint text. */
export function effortCapabilityForModel(
  models: readonly ProviderModel[],
  providerId: ProviderId,
  protocol: ApiProtocol,
  modelId: string,
  stored?: ProviderEffortMetadata | null,
): EffortCapability {
  return capabilitiesFor({
    providerId,
    protocol,
    modelId,
    catalogue: models,
    stored,
  });
}

/* ------------------------------------------------------------------ */
/* Conventional OpenAI-compatible `/models` parsing                     */
/* ------------------------------------------------------------------ */

export function parseProviderModels(records: readonly unknown[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const record of records) {
    const model = parseProviderModel(record);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  return sortProviderModels([...byId.values()]);
}

export function parseProviderModel(record: unknown): ProviderModel | null {
  if (!isRecord(record)) return null;

  const id =
    readString(record, 'id') ?? readString(record, 'name') ?? readString(record, 'model');
  if (!id) return null;

  const ownedBy = readString(record, 'owned_by') ?? readString(record, 'ownedBy');
  const created = typeof record.created === 'number' ? record.created : null;
  const contextLength =
    readPositiveNumber(record.context_length) ?? readPositiveNumber(record.contextLength);
  const defaultEffort = isRecord(record.default_parameters)
    ? normalizeReasoningEffort(record.default_parameters.reasoning_effort)
    : '';

  const efforts = readReasoningEfforts(record, id);
  return {
    id,
    name: readString(record, 'name'),
    ownedBy,
    createdAt: created,
    contextLength,
    reasoningEfforts: efforts.efforts,
    reasoningEffortSource: efforts.source,
    defaultReasoningEffort: defaultEffort,
    reasoningMandatory: false,
  };
}

/**
 * Adds OpenRouter's authoritative effort metadata to another catalogue. Kept
 * as an exported, tested utility for callers that deliberately compare a
 * gateway's model list with OpenRouter; the built-in provider paths use their
 * own declared tables instead.
 */
export function enrichWithOpenRouterMetadata(
  models: readonly ProviderModel[],
  catalogue: readonly ProviderModel[],
): ProviderModel[] {
  if (catalogue.length === 0) return [...models];

  const exact = new Map(catalogue.map((model) => [model.id, model]));
  const bySuffix = new Map<string, ProviderModel[]>();
  for (const model of catalogue) {
    const suffix = modelSuffix(model.id);
    const list = bySuffix.get(suffix);
    if (list) list.push(model);
    else bySuffix.set(suffix, [model]);
  }

  return models.map((model) => {
    const candidates = bySuffix.get(modelSuffix(model.id));
    const match =
      exact.get(model.id) ?? (candidates && candidates.length === 1 ? candidates[0] : undefined);
    if (!match) return model;
    return {
      ...model,
      name: model.name ?? match.name,
      contextLength: match.contextLength ?? model.contextLength,
      reasoningEfforts: match.reasoningEfforts,
      reasoningEffortSource: match.reasoningEffortSource,
      defaultReasoningEffort: match.defaultReasoningEffort,
      reasoningMandatory: match.reasoningMandatory,
    };
  });
}

export function findProviderModel(
  models: readonly ProviderModel[],
  id: string,
): ProviderModel | undefined {
  return models.find((model) => model.id === id);
}

/**
 * Picks the model to preselect after discovery. Keeps the saved id when the
 * provider lists it; otherwise falls back to the provider's documented default
 * and then to the first chat-like entry rather than whichever embedding or
 * speech model the catalogue happened to return first.
 */
export function pickModelId(
  models: readonly ProviderModel[],
  preferred: string,
  fallback = '',
): string {
  if (preferred && models.some((model) => model.id === preferred)) return preferred;
  if (fallback && models.some((model) => model.id === fallback)) return fallback;
  return models.find((model) => isLikelyChatModel(model.id))?.id ?? models[0]?.id ?? preferred;
}

/** Broad filter for model picker ordering, not a capability guarantee. */
export function isLikelyChatModel(id: string): boolean {
  return !/(^|[-_/])(embed(dings?)?|whisper|tts|dall-e|moderation|transcribe|audio|realtime|image|sora|video|rerank|deep-research|babbage|davinci|curie|ada)([-_/.:]|$)/i.test(
    id,
  );
}

/**
 * Effort levels to offer for a model id from a loaded OpenRouter-style
 * catalogue. Once a catalogue is loaded it is authoritative: a model that is
 * absent gets no effort control rather than a family guess.
 *
 * Kept for catalogue-focused callers; provider-aware UI code should use
 * `effortCapabilityForModel`.
 */
export function effortsForModel(
  models: readonly ProviderModel[],
  modelId: string,
): ReasoningEffort[] {
  if (models.length > 0) return findProviderModel(models, modelId)?.reasoningEfforts ?? [];
  return inferReasoningEfforts(modelId);
}

/* ------------------------------------------------------------------ */
/* Tolerant parsing helpers                                            */
/* ------------------------------------------------------------------ */

function readReasoningEfforts(
  record: Record<string, unknown>,
  id: string,
): { efforts: ReasoningEffort[]; source: ReasoningEffortSource } {
  const explicit: unknown[] = [];
  let parameterAdvert = false;

  // Explicit level lists can live at the top level or under `capabilities`.
  for (const source of [record, isRecord(record.capabilities) ? record.capabilities : null]) {
    if (!source) continue;
    for (const key of [
      'reasoning_efforts',
      'reasoning_effort_levels',
      'supported_reasoning_efforts',
      'supported_efforts',
      'efforts',
    ]) {
      collectEfforts(source[key], explicit);
    }

    // `reasoning_effort` is either a list/object of levels or a single default
    // hint. Only the former is an explicit allow-list; a string/boolean is an
    // advert that the parameter exists, not a statement about every level.
    const direct = source.reasoning_effort ?? source.reasoningEffort;
    if (Array.isArray(direct) || isRecord(direct)) {
      collectEfforts(direct, explicit);
    } else if (direct !== undefined) {
      parameterAdvert = true;
    }

    // Some catalogues nest the supported levels under a `reasoning` object.
    if (isRecord(source.reasoning)) {
      for (const key of ['supported_efforts', 'efforts', 'effort_levels', 'reasoning_efforts']) {
        collectEfforts(source.reasoning[key], explicit);
      }
    }

    const parameters = source.supported_parameters;
    if (
      Array.isArray(parameters) &&
      parameters.some((parameter) => parameter === 'reasoning_effort')
    ) {
      parameterAdvert = true;
    }
    if (
      isRecord(source.default_parameters) &&
      source.default_parameters.reasoning_effort !== undefined
    ) {
      parameterAdvert = true;
    }
  }

  // An explicit allow-list is authoritative and must not be widened with a
  // family guess. A bare parameter advert only supports the conservative
  // default set, labelled inferred. With neither, use the narrow family
  // inference for known ids.
  const explicitEfforts = sortReasoningEfforts(explicit);
  if (explicitEfforts.length > 0) {
    return { efforts: explicitEfforts, source: 'metadata' };
  }
  if (parameterAdvert) {
    return { efforts: [...DEFAULT_REASONING_EFFORTS], source: 'inferred' };
  }
  const inferred = inferReasoningEfforts(id);
  return {
    efforts: inferred,
    source: inferred.length > 0 ? 'inferred' : 'none',
  };
}

function collectEfforts(value: unknown, out: unknown[]): void {
  if (typeof value === 'string') {
    for (const part of value.split(/[,|\s]+/)) out.push(part.trim().toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEfforts(item, out);
    return;
  }
  if (isRecord(value)) {
    // `{ low: {}, medium: {}, high: {} }` or `{ levels: [...] }`.
    for (const key of ['levels', 'values', 'supported', 'options', 'allowed']) {
      if (key in value) collectEfforts(value[key], out);
    }
    for (const key of Object.keys(value)) out.push(key);
    return;
  }
  if (value === true) {
    out.push(...DEFAULT_REASONING_EFFORTS);
  }
}

function sortProviderModels(models: ProviderModel[]): ProviderModel[] {
  // Chat models first, then alphabetical. Provider catalogues also list
  // embeddings, speech and image models; putting those below keeps the picker
  // useful without hiding anything.
  return [...models].sort((a, b) => {
    const chatRank = Number(isLikelyChatModel(b.id)) - Number(isLikelyChatModel(a.id));
    return chatRank !== 0 ? chatRank : a.id.localeCompare(b.id);
  });
}

function modelSuffix(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

function providerPrefix(id: string): string | null {
  const slash = id.indexOf('/');
  return slash > 0 ? id.slice(0, slash) : null;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
