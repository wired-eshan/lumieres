/**
 * The AI service boundary — a seam, not an implementation.
 *
 * Nothing in the app calls these methods today and no provider, key or network
 * code exists. The interface is defined so that adding AI later is a matter of
 * implementing it and registering it, with no change to the graph, editor or
 * canvas layers.
 *
 * Contract requirements captured here (see `sessionStore.ts` for the state half):
 *  - requests are addressed by (nodeId, requestId)
 *  - several nodes may run requests concurrently; no global queue
 *  - a node cancels only its own request
 *  - a late response for a superseded request must be dropped, not applied
 *  - concurrency limits, retries and backpressure belong to the implementation
 */

import type { AIStreamEvent, AIRequestId, AskInput, AskResult, AutocompleteInput } from './types';
import type { NodeId } from '../graph/types';

export interface AIService {
  /** Streaming autocomplete for a single node. */
  autocomplete(input: AutocompleteInput): AsyncIterable<string>;
  /** One-shot question answering for a single node. */
  ask(input: AskInput): Promise<AskResult>;
  /** Cancels only the given node's request; other nodes are unaffected. */
  cancel(nodeId: NodeId, requestId: AIRequestId): void;
  /** Optional lower-level stream, if a provider prefers a single code path. */
  stream?(input: AutocompleteInput | AskInput): AsyncIterable<AIStreamEvent>;
  /** Releases per-node resources (sockets, buffers) when a window closes. */
  disposeSession?(nodeId: NodeId): void;
}

export interface AIServiceConfig {
  /** Maximum requests in flight across the whole app. */
  maxConcurrentRequests: number;
  /** Maximum requests a single node may have in flight. */
  maxConcurrentPerNode: number;
  /** Provider identifier; resolved by the implementation, not by the UI. */
  provider: string;
  model: string;
}

export const DEFAULT_AI_CONFIG: AIServiceConfig = {
  maxConcurrentRequests: 4,
  maxConcurrentPerNode: 1,
  provider: 'unconfigured',
  model: 'unconfigured',
};

/**
 * Holder for the (future) service instance. The UI reads it through
 * `useAIService()` and simply finds `null` today, which is why every AI
 * affordance is absent rather than fake.
 */
let registered: AIService | null = null;

export function registerAIService(service: AIService | null): void {
  registered = service;
}

export function getAIService(): AIService | null {
  return registered;
}

export function isAIEnabled(): boolean {
  return registered !== null;
}
