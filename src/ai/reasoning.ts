/**
 * Reasoning-effort levels understood by OpenAI-compatible chat APIs.
 *
 * OpenRouter's public catalogue is the authoritative source for which levels a
 * model accepts (`reasoning.supported_efforts`); `models.ts` parses it. For
 * custom endpoints whose own `/models` response has no capability fields,
 * `inferReasoningEfforts` provides a conservative fallback based on well-known
 * families. The inference never claims support for an unknown model; the effort
 * control stays disabled unless the catalogue or a known family says it is
 * available.
 */

export const REASONING_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number];

const LEVEL_SET = new Set<string>(REASONING_EFFORT_LEVELS);

/** Levels used when a provider says `reasoning_effort` is supported but does not enumerate values. */
export const DEFAULT_REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && LEVEL_SET.has(value);
}

/** Returns a valid effort or `''`, which means "use the provider default". */
export function normalizeReasoningEffort(value: unknown): ReasoningEffort | '' {
  return isReasoningEffort(value) ? value : '';
}

/** Unique levels in canonical order, so provider metadata cannot scramble the UI. */
export function sortReasoningEfforts(values: Iterable<unknown>): ReasoningEffort[] {
  const present = new Set<ReasoningEffort>();
  for (const value of values) {
    if (isReasoningEffort(value)) present.add(value);
  }
  return REASONING_EFFORT_LEVELS.filter((level) => present.has(level));
}

/**
 * Best-effort capability inference for providers whose `/models` response does
 * not include capability metadata. Deliberately narrow: only families whose
 * chat completion APIs accept `reasoning_effort` are listed.
 */
export function inferReasoningEfforts(modelId: string): ReasoningEffort[] {
  const id = modelId.trim().toLowerCase();
  if (id.length === 0) return [];

  // gpt-5 family (including gpt-5-codex, excluding chat/audio/media variants).
  if (id.includes('gpt-5') && !/(chat|audio|realtime|transcribe|tts|image|embedding)/.test(id)) {
    return ['minimal', 'low', 'medium', 'high'];
  }

  // o1 / o3 / o4 reasoning families, as standalone id segments.
  if (/(^|[/:_-])(o1|o3|o4)(?=$|[-.:_/])/.test(id)) {
    return ['low', 'medium', 'high'];
  }

  return [];
}

/** True when the model is likely a reasoning model, which needs `max_completion_tokens`. */
export function isReasoningModel(modelId: string): boolean {
  return inferReasoningEfforts(modelId).length > 0;
}
