/**
 * Model discovery through the provider's `GET /models` endpoint.
 *
 * OpenAI-compatible services (OpenAI, OpenRouter, Groq, local servers, …) all
 * expose `/models`, but they return different amounts of metadata. The standard
 * OpenAI response contains only `id`, `created` and `owned_by`; services such as
 * OpenRouter additionally advertise `supported_parameters`. This module keeps
 * both cases useful:
 *
 *  - ids always populate the model picker;
 *  - effort levels come from explicit capability metadata when present;
 *  - otherwise a small, conservative inference covers known reasoning families.
 *
 * Nothing here writes to the graph document. Settings own the selected id and
 * effort; the returned list is transient UI state.
 */

import { AIRequestError, describeError, isAbortError, isRetryable } from './errors';
import {
  DEFAULT_REASONING_EFFORTS,
  inferReasoningEfforts,
  sortReasoningEfforts,
  type ReasoningEffort,
} from './reasoning';

export type ReasoningEffortSource = 'metadata' | 'inferred' | 'none';

export interface ProviderModel {
  id: string;
  ownedBy: string | null;
  createdAt: number | null;
  /** Empty means the model does not advertise reasoning-effort levels. */
  reasoningEfforts: ReasoningEffort[];
  /** Where the levels came from, so the UI can be precise about it. */
  reasoningEffortSource: ReasoningEffortSource;
}

export interface FetchProviderModelsInput {
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
}

/**
 * Loads the provider's model catalogue. The SDK is imported lazily so a canvas
 * with no AI activity does not download it.
 */
export async function fetchProviderModels(
  input: FetchProviderModelsInput,
): Promise<ProviderModel[]> {
  if (input.apiKey.trim().length === 0) {
    throw new AIRequestError('Add an API key before loading models.');
  }

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
    maxRetries: 1,
  });

  try {
    let page = await client.models.list(input.signal ? { signal: input.signal } : undefined);
    const records: unknown[] = [...page.data];
    // OpenAI's list endpoint does not paginate today, but the SDK supports it
    // and compatible servers may. Bound the loop so a broken server cannot spin.
    let guard = 0;
    while (page.hasNextPage() && guard < 20) {
      page = await page.getNextPage();
      records.push(...page.data);
      guard += 1;
    }
    return parseProviderModels(records);
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      throw new AIRequestError('Model loading stopped.', false);
    }
    throw new AIRequestError(describeError(error), isRetryable(error));
  }
}

/** Pure parser, exported for tests and for tolerant handling of provider quirks. */
export function parseProviderModels(records: readonly unknown[]): ProviderModel[] {
  const byId = new Map<string, ProviderModel>();
  for (const record of records) {
    const model = parseProviderModel(record);
    if (model && !byId.has(model.id)) byId.set(model.id, model);
  }
  // Chat models first, then alphabetical. Provider catalogues also list
  // embeddings, speech and image models; putting those below keeps the model
  // picker useful without hiding anything.
  return [...byId.values()].sort((a, b) => {
    const chatRank = Number(isLikelyChatModel(b.id)) - Number(isLikelyChatModel(a.id));
    return chatRank !== 0 ? chatRank : a.id.localeCompare(b.id);
  });
}

export function parseProviderModel(record: unknown): ProviderModel | null {
  if (!isRecord(record)) return null;

  const id =
    readString(record, 'id') ?? readString(record, 'name') ?? readString(record, 'model');
  if (!id) return null;

  const ownedBy = readString(record, 'owned_by') ?? readString(record, 'ownedBy');
  const created = typeof record.created === 'number' ? record.created : null;

  const efforts = readReasoningEfforts(record, id);
  return {
    id,
    ownedBy,
    createdAt: created,
    reasoningEfforts: efforts.efforts,
    reasoningEffortSource: efforts.source,
  };
}

export function findProviderModel(
  models: readonly ProviderModel[],
  id: string,
): ProviderModel | undefined {
  return models.find((model) => model.id === id);
}

/**
 * Picks the model to preselect after discovery. Keeps the saved/id string when
 * the provider lists it, otherwise chooses the first chat-like model rather
 * than whichever alphabetically-first embedding or speech model the catalogue
 * happened to return.
 */
export function pickModelId(models: readonly ProviderModel[], preferred: string): string {
  if (preferred && models.some((model) => model.id === preferred)) return preferred;
  return models.find((model) => isLikelyChatModel(model.id))?.id ?? models[0]?.id ?? preferred;
}

/** Broad filter for model picker ordering, not a capability guarantee. */
export function isLikelyChatModel(id: string): boolean {
  return !/(^|[-_/])(embed(dings?)?|whisper|tts|dall-e|moderation|transcribe|audio|realtime|image|sora|video|rerank|deep-research|babbage|davinci|curie|ada)([-_/.:]|$)/i.test(
    id,
  );
}

/** Effort levels to offer for a typed model id when discovery has not run. */
export function effortsForModel(
  models: readonly ProviderModel[],
  modelId: string,
): ReasoningEffort[] {
  return findProviderModel(models, modelId)?.reasoningEfforts ?? inferReasoningEfforts(modelId);
}

/* ------------------------------------------------------------------ */
/* Tolerant metadata parsing                                           */
/* ------------------------------------------------------------------ */

function readReasoningEfforts(
  record: Record<string, unknown>,
  id: string,
): { efforts: ReasoningEffort[]; source: ReasoningEffortSource } {
  const found: unknown[] = [];

  // Explicit level lists can live at the top level or under `capabilities`.
  for (const source of [record, isRecord(record.capabilities) ? record.capabilities : null]) {
    if (!source) continue;
    for (const key of [
      'reasoning_efforts',
      'reasoning_effort_levels',
      'supported_reasoning_efforts',
      'supported_efforts',
      'reasoning_effort',
      'reasoningEffort',
      'efforts',
    ]) {
      collectEfforts(source[key], found);
    }

    // OpenRouter-style capability advert: the parameter exists, so the common
    // low/medium/high choices are valid.
    const parameters = source.supported_parameters;
    if (
      Array.isArray(parameters) &&
      parameters.some((parameter) => parameter === 'reasoning_effort')
    ) {
      found.push(...DEFAULT_REASONING_EFFORTS);
    }

    // Some catalogues nest the supported levels under a `reasoning` object or
    // expose a default in `default_parameters`.
    if (isRecord(source.reasoning)) {
      for (const key of ['supported_efforts', 'efforts', 'effort_levels', 'reasoning_efforts']) {
        collectEfforts(source.reasoning[key], found);
      }
    }
    if (
      isRecord(source.default_parameters) &&
      source.default_parameters.reasoning_effort !== undefined
    ) {
      found.push(...DEFAULT_REASONING_EFFORTS);
    }
  }

  // The OpenAI /models response has no capability fields. Fall back to a narrow
  // family inference so known models still offer a useful control. A bare
  // `capabilities.reasoning: true` is not enough: it says the model thinks, not
  // that it accepts a reasoning_effort parameter, so it is intentionally not
  // used here.
  const fromMetadata = sortReasoningEfforts(found);
  const inferred = inferReasoningEfforts(id);
  const efforts = sortReasoningEfforts([...fromMetadata, ...inferred]);
  const source: ReasoningEffortSource =
    fromMetadata.length > 0 ? 'metadata' : inferred.length > 0 ? 'inferred' : 'none';
  return { efforts, source };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
