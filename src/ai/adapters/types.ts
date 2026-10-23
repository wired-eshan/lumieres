/**
 * Protocol adapter boundary.
 *
 * Every provider-specific request/response shape stops here. The runtime and
 * UI speak only in normalized turns and a normalized result, so adding a
 * provider means adding an adapter and a registry entry — not touching the
 * graph, editor, canvas or chat components.
 */

import type { ChatTurn } from '../chatContext';
import type { EffortResolution } from '../effort';
import type { ApiProtocol, ResolvedProviderConfig } from '../provider';

export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AdapterRequestBase {
  config: ResolvedProviderConfig;
  /** Already mapped through `ai/effort.ts`; `value: null` means omit. */
  effort: EffortResolution;
  system: string;
  messages: ChatTurn[];
  /**
   * Provider-managed continuation. Only set when the provider supports it and
   * the runtime verified the history is an append-only extension for the same
   * provider and model. Adapters must never be given an id from another
   * provider.
   */
  previousResponseId?: string;
  signal?: AbortSignal;
}

export interface AdapterStreamRequest extends AdapterRequestBase {
  signal: AbortSignal;
  /** `snapshot` is the full text received so far. */
  onText: (delta: string, snapshot: string) => void;
}

export interface AdapterResult {
  text: string;
  /** Provider stop reason / finish reason, for diagnostics and partial handling. */
  stopReason: string | null;
  /**
   * A continuation identifier owned by this provider, or null. The runtime
   * stores it only in memory and invalidates it when provider or model changes.
   */
  responseId: string | null;
  usage?: NormalizedUsage;
}

export interface LLMAdapter {
  readonly protocol: ApiProtocol;
  stream(request: AdapterStreamRequest): Promise<AdapterResult>;
  /** Non-streaming path, available for future one-shot surfaces. */
  generate(request: AdapterRequestBase): Promise<AdapterResult>;
}
