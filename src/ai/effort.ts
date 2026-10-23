/**
 * Provider-aware reasoning-effort capability and mapping.
 *
 * The user's choice is never silently treated as equivalent across providers.
 * This module answers two questions in one place:
 *
 *  1. Which levels does a provider/model actually advertise? (`capabilitiesFor`)
 *  2. What value (if any) should go on the wire for a requested level?
 *     (`mapEffortForRequest`)
 *
 * OpenRouter publishes authoritative per-model `reasoning.supported_efforts`
 * metadata in its catalogue. Anthropic's Models API publishes per-model effort
 * capabilities. OpenAI and DeepSeek document their rules, which are encoded as
 * narrow, source-commented tables below. Unknown models get no effort control
 * rather than a guess based on their name.
 *
 * DeepSeek documents aliases rather than the OpenAI set (for example `medium`
 * and `xhigh` canonicalise to `high`; `minimal` to `low`). The mapping is
 * explicit here and surfaced in the settings hint, so a user is never told a
 * level was applied when it was not.
 */

import type { ApiProtocol, ProviderEffortMetadata, ProviderId } from './provider';
import { inferReasoningEfforts, type ReasoningEffort } from './reasoning';

/** Where a model's effort levels came from. */
export type ReasoningEffortSource = 'metadata' | 'declared' | 'inferred' | 'none';

export interface EffortCapability {
  efforts: ReasoningEffort[];
  source: ReasoningEffortSource;
  /** Catalogue/provider default, or `''` when none is advertised. */
  defaultEffort: ReasoningEffort | '';
  /** When true the provider requires reasoning; `none` cannot be used. */
  mandatory: boolean;
  /** Short user-facing explanation of the provenance. */
  note: string;
}

/**
 * The subset of a model record this module needs. Kept structural so
 * `models.ts` can pass its richer `ProviderModel` without a circular import.
 */
export interface EffortCatalogueEntry {
  id: string;
  reasoningEfforts: readonly ReasoningEffort[];
  reasoningEffortSource: ReasoningEffortSource;
  defaultReasoningEffort: ReasoningEffort | '';
  reasoningMandatory: boolean;
}

export interface EffortResolution {
  requested: ReasoningEffort | '';
  /** The value to place on the wire, or `null` to omit the parameter. */
  value: string | null;
  /** True when the requested level (or its documented alias) is sent. */
  applied: boolean;
  /** Set when a documented alias changed the literal value. */
  mappedFrom?: ReasoningEffort;
  capability: EffortCapability;
  /** User-facing note when the level is unsupported or aliased. */
  note?: string;
}

interface ModelEffortRule {
  /** Matched against the lower-cased model id. */
  match: RegExp;
  efforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort | '';
  mandatory?: boolean;
  note: string;
}

/**
 * OpenAI Responses docs: `reasoning.effort` accepts none/minimal/low/medium/
 * high/xhigh/max, but support is model-specific. These are deliberately
 * conservative family rules; an unmatched id gets no effort control.
 *
 * Source: OpenAI Responses API reference (`reasoning.effort`) and the
 * per-model reasoning guide. Update this table when OpenAI publishes changes.
 */
const OPENAI_EFFORT_RULES: readonly ModelEffortRule[] = [
  {
    match: /gpt-6-astra(?=$|[-.:_/])/,
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: '',
    note: 'Declared for GPT-6 Astra by OpenAI; none, minimal and max are not supported.',
  },
  {
    match: /gpt-6\.1-sol(?=$|[-.:_/])/,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    note: 'Declared for GPT-6.1 Sol by OpenAI; none and minimal are not supported.',
  },
  {
    match: /gpt-6-(?:sol|luna)(?=$|[-.:_/])/,
    efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    note: 'Declared for the GPT-6 Sol/Luna family by OpenAI; minimal is not supported.',
  },
  {
    // Known chat/reasoning variants; do not guess for unverified suffixes.
    match: /gpt-5\.6(?:-(?:sol|terra|luna))?(?![a-z0-9-])/i,
    efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    note: 'Declared for the GPT-5.6 family by OpenAI; minimal is not supported.',
  },
  {
    match: /gpt-5\.5-pro(?=$|[-.:_/])/,
    efforts: ['medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    note: 'Declared for GPT-5.5 Pro by OpenAI.',
  },
  {
    match: /gpt-5\.5(?=$|[-.:_/])/,
    efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    note: 'Declared for GPT-5.5 by OpenAI; minimal and max are not supported.',
  },
  {
    match: /gpt-5\.(?:2|4)(?=$|[-.:_/])/,
    efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'none',
    note: 'Declared for GPT-5.2/5.4 by OpenAI; minimal and max are not supported.',
  },
  {
    match: /gpt-5\.1(?=$|[-.:_/])/,
    efforts: ['none', 'low', 'medium', 'high'],
    defaultEffort: 'none',
    note: 'Declared for GPT-5.1 by OpenAI; xhigh, max and minimal are not supported.',
  },
  {
    match: /gpt-5-pro(?=$|[-.:_/])/,
    efforts: ['high'],
    defaultEffort: 'high',
    note: 'Declared for GPT-5 Pro by OpenAI; high is the only effort level.',
  },
  {
    match:
      /(?:^|[/:_-])gpt-5(?=$|[-.:_/])(?!.*(?:chat|audio|realtime|transcribe|tts|image|embedding))/,
    efforts: ['minimal', 'low', 'medium', 'high'],
    defaultEffort: 'medium',
    note: 'Declared for GPT-5 by OpenAI; none, xhigh and max are not supported.',
  },
  {
    match: /(?:^|[/:_-])(?:o1|o3|o4)(?=$|[-.:_/])(?!.*audio)/,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
    note: 'Declared for the o-series reasoning models by OpenAI; none is not supported.',
  },
];

/**
 * DeepSeek's Responses API documents aliases rather than OpenAI's set. The
 * canonical values are what the adapter sends; the UI explains the mapping.
 *
 * Source: DeepSeek API docs, Reasoning/Responses section. Keep aliases here so
 * a provider-doc change is one edit and is unit-testable.
 */
export const DEEPSEEK_EFFORT_ALIASES: Partial<Record<ReasoningEffort, ReasoningEffort>> = {
  minimal: 'low',
  medium: 'high',
  xhigh: 'high',
};

const DEEPSEEK_EFFORT_RULES: readonly ModelEffortRule[] = [
  {
    // Current Responses-capable DeepSeek models. `deepseek-chat` and
    // `deepseek-reasoner` were retired in 2026 and deliberately get no rule.
    match: /deepseek-(?:flash|v4-pro)/,
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    note: 'Declared by DeepSeek’s Responses documentation: none/low/high/max are canonical; minimal maps to low, and medium/xhigh map to high.',
  },
];

/**
 * Anthropic fallback when the Models API has not been loaded. Current Claude
 * models document output_config.effort levels low through max; `none` and
 * `minimal` are not part of the native API.
 *
 * Source: Anthropic Messages API `output_config.effort` and the per-model
 * effort table. The Models API (`capabilities.effort`) is authoritative and is
 * preferred when available.
 */
const ANTHROPIC_EFFORT_RULES: readonly ModelEffortRule[] = [
  {
    match: /claude-(?:fable|mythos|opus|sonnet|haiku)-5(?:[.-]\d+)?/,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: '',
    note: 'Declared for current Claude 5-family models. The Anthropic Models API is used when available.',
  },
  {
    match: /claude-(?:opus|sonnet)-4[.-](?:7|8)/,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: '',
    note: 'Declared for Claude 4.7/4.8 models. The Anthropic Models API is used when available.',
  },
  {
    match: /claude-(?:opus|sonnet)-4[.-]6/,
    // Anthropic documents max but not xhigh on the 4.6 family.
    efforts: ['low', 'medium', 'high', 'max'],
    defaultEffort: '',
    note: 'Declared for Claude 4.6 models; xhigh is not available on this family.',
  },
  {
    match: /claude-opus-4[.-]5/,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: '',
    note: 'Declared for Claude Opus 4.5; xhigh and max are not available.',
  },
];

const NO_CAPABILITY: EffortCapability = {
  efforts: [],
  source: 'none',
  defaultEffort: '',
  mandatory: false,
  note: 'This model does not advertise reasoning-effort levels.',
};

/**
 * OpenRouter's Responses reasoning guide documents four effort values, while
 * its OpenAPI request enum is wider and its model catalogue is model-specific.
 * Once the catalogue is loaded it is authoritative; without it, only the four
 * explicitly documented values are offered rather than guessing the rest.
 */
const OPENROUTER_FALLBACK_EFFORTS = new Set<ReasoningEffort>([
  'minimal',
  'low',
  'medium',
  'high',
]);

function openRouterFallbackEfforts(values: readonly ReasoningEffort[]): ReasoningEffort[] {
  return values.filter((value) => OPENROUTER_FALLBACK_EFFORTS.has(value));
}

function matchRule(
  rules: readonly ModelEffortRule[],
  modelId: string,
  source: ReasoningEffortSource,
): EffortCapability | null {
  const id = modelId.trim().toLowerCase();
  if (id.length === 0) return null;
  const rule = rules.find((candidate) => candidate.match.test(id));
  if (!rule) return null;
  return {
    efforts: [...rule.efforts],
    source,
    defaultEffort: rule.defaultEffort,
    mandatory: rule.mandatory === true,
    note: rule.note,
  };
}

function fromCatalogue(
  entry: EffortCatalogueEntry,
  note: string,
): EffortCapability {
  return {
    efforts: [...entry.reasoningEfforts],
    source: entry.reasoningEffortSource,
    defaultEffort: entry.defaultReasoningEffort,
    mandatory: entry.reasoningMandatory,
    note,
  };
}

export interface EffortCapabilityInput {
  providerId: ProviderId;
  protocol: ApiProtocol;
  modelId: string;
  /** Loaded model records, when the provider supplies capability metadata. */
  catalogue?: readonly EffortCatalogueEntry[];
  /** Capability cached with the profile for this exact model id. */
  stored?: ProviderEffortMetadata | null;
}

/**
 * Capability resolution order is deliberate:
 *  - OpenRouter: its catalogue, when loaded, is authoritative; without it the
 *    narrow family inference is labelled as such.
 *  - Anthropic: Models API metadata when loaded; otherwise the documented table.
 *  - OpenAI/DeepSeek: documented provider tables.
 *  - Custom: rules for the chosen protocol, labelled inferred because a custom
 *    endpoint's claim to implement a protocol does not prove a model's options.
 */
export function capabilitiesFor(input: EffortCapabilityInput): EffortCapability {
  const { providerId, protocol, modelId } = input;
  const catalogue = input.catalogue ?? [];

  // A capability saved for this exact model came from the catalogue or the
  // provider's documented table when the user last saved Settings. Prefer it so
  // the request matches what the UI offered.
  if (input.stored && input.stored.modelId === modelId) {
    return {
      efforts: [...input.stored.efforts],
      source: input.stored.efforts.length > 0 ? input.stored.source : 'none',
      defaultEffort: input.stored.defaultEffort,
      mandatory: input.stored.mandatory,
      note: input.stored.note,
    };
  }

  if (providerId === 'openrouter') {
    if (catalogue.length > 0) {
      const entry = catalogue.find((model) => model.id === modelId);
      if (!entry) {
        return {
          ...NO_CAPABILITY,
          note: 'The loaded OpenRouter catalogue does not advertise effort levels for this model id.',
        };
      }
      return {
        efforts: [...entry.reasoningEfforts],
        source: entry.reasoningEffortSource,
        defaultEffort: entry.defaultReasoningEffort,
        mandatory: entry.reasoningMandatory,
        note:
          'Advertised by OpenRouter’s catalogue for this model. Its Responses reasoning guide documents minimal/low/medium/high; the catalogue is more specific and is used when present.',
      };
    }
    const inferred = openRouterFallbackEfforts(inferReasoningEfforts(modelId));
    if (inferred.length === 0) {
      return {
        ...NO_CAPABILITY,
        note: 'Load OpenRouter’s catalogue to see whether this model offers effort through the Responses API.',
      };
    }
    return {
      efforts: inferred,
      source: 'inferred',
      defaultEffort: '',
      mandatory: false,
      note: 'Inferred from the model family and limited to the four levels OpenRouter’s Responses reasoning guide documents. Load the catalogue to confirm the advertised levels.',
    };
  }

  if (providerId === 'anthropic' || (providerId === 'custom' && protocol === 'anthropic-messages')) {
    if (catalogue.length > 0) {
      const entry = catalogue.find((model) => model.id === modelId);
      if (entry && entry.reasoningEffortSource === 'metadata') {
        if (entry.reasoningEfforts.length > 0) {
          return fromCatalogue(
            entry,
            'Advertised by the Anthropic Models API for this model.',
          );
        }
        return {
          ...NO_CAPABILITY,
          note: 'The Anthropic Models API explicitly advertises no reasoning-effort levels for this model.',
        };
      }
    }
    const matched = matchRule(
      ANTHROPIC_EFFORT_RULES,
      modelId,
      providerId === 'anthropic' ? 'declared' : 'inferred',
    );
    if (!matched) {
      return {
        ...NO_CAPABILITY,
        note:
          providerId === 'anthropic'
            ? 'This Claude model id is not in the documented effort table. Choose Provider default or load models.'
            : 'The custom endpoint’s model is not a known Claude id. Effort cannot be verified, so requests omit it.',
      };
    }
    return providerId === 'anthropic'
      ? matched
      : {
          ...matched,
          note: `${matched.note} This is inferred from the model id; a custom endpoint’s protocol choice does not prove its model capabilities.`,
        };
  }

  if (providerId === 'openai') {
    return (
      matchRule(OPENAI_EFFORT_RULES, modelId, 'declared') ?? {
        ...NO_CAPABILITY,
        note: 'OpenAI does not document reasoning-effort levels for this model id, so requests omit the parameter.',
      }
    );
  }

  if (providerId === 'deepseek') {
    return (
      matchRule(DEEPSEEK_EFFORT_RULES, modelId, 'declared') ?? {
        ...NO_CAPABILITY,
        note: 'DeepSeek does not document reasoning-effort levels for this model id, so requests omit the parameter.',
      }
    );
  }

  // Custom endpoint: explicit metadata from its own model catalogue is useful,
  // but a family match is labelled inferred because the protocol choice alone
  // does not prove the model's capabilities.
  if (catalogue.length > 0) {
    const entry = catalogue.find((model) => model.id === modelId);
    if (entry && entry.reasoningEffortSource === 'metadata') {
      if (entry.reasoningEfforts.length > 0) {
        return fromCatalogue(
          entry,
          'Advertised by the custom endpoint’s model catalogue.',
        );
      }
      return {
        ...NO_CAPABILITY,
        note: 'The custom endpoint explicitly advertises no reasoning-effort levels for this model.',
      };
    }
  }
  const matched = matchRule(OPENAI_EFFORT_RULES, modelId, 'inferred');
  return matched
    ? {
        ...matched,
        note: `${matched.note} This is inferred from the model id; a custom endpoint’s protocol choice does not prove its model capabilities.`,
      }
    : {
        ...NO_CAPABILITY,
        note: 'The custom endpoint’s model is not a known OpenAI-family id. Effort cannot be verified, so requests omit it.',
      };
}

export interface MapEffortInput extends EffortCapabilityInput {
  requested: ReasoningEffort | '';
}

/**
 * Maps the user's selected level to the provider's documented value.
 *
 * Unsupported levels return `value: null` with a note; they are never replaced
 * with a different level behind the user's back. Documented aliases (DeepSeek)
 * are the only transformation, and they are reported via `mappedFrom`.
 */
export function mapEffortForRequest(input: MapEffortInput): EffortResolution {
  const capability = capabilitiesFor(input);
  const requested = input.requested;
  if (requested === '') {
    return { requested, value: null, applied: false, capability };
  }
  if (!capability.efforts.includes(requested)) {
    return {
      requested,
      value: null,
      applied: false,
      capability,
      note:
        capability.efforts.length === 0
          ? `“${requested}” was not sent: ${capability.note}`
          : `“${requested}” is not supported by this model. Supported levels: ${capability.efforts.join(', ')}. Requests use the provider default instead.`,
    };
  }

  const alias =
    input.providerId === 'deepseek' ? DEEPSEEK_EFFORT_ALIASES[requested] : undefined;
  const value = alias ?? requested;
  return {
    requested,
    value,
    applied: true,
    ...(alias && alias !== requested ? { mappedFrom: requested } : {}),
    capability,
    ...(alias && alias !== requested
      ? { note: `DeepSeek sends “${requested}” as “${alias}”.` }
      : {}),
  };
}

/** Levels the effort selector should offer, in canonical order. */
export function effortsFor(input: EffortCapabilityInput): ReasoningEffort[] {
  return capabilitiesFor(input).efforts;
}
