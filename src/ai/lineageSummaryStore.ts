/**
 * Lineage-summary cache (hybrid summarization: the LLM half).
 *
 * A lineage summary is a single condensed narrative of a node's ancestor path
 * (root → relevant ancestors → current), produced by the key-gated summarizer in
 * `ai/summarizer.ts` and consumed by the prompt builder in `ai/prompt.ts`. To
 * keep the LLM cost bounded and an interactive chat send instant, summaries are
 * cached here keyed by a **content fingerprint** of the chain rather than by the
 * node id alone.
 *
 * Why a fingerprint and not a timestamp/staleness flag:
 *  - any edit bumps the edited node's `contentVersion` (see
 *    `graphOperations.ts` / `graph/types.ts`), which changes the fingerprint;
 *  - a changed fingerprint is a guaranteed cache miss, so invalidation is exact
 *    and needs no coordination between the writer and the model.
 *
 * The cache is deliberately in-memory only. A summary is derived, regenerable
 * data — it can always be rebuilt from the next documented edit — so it matches
 * the app's convention that AI-adjacent state ("streaming buffers, continuation
 * ids, now summaries") is never persisted to the document. Persisting summaries
 * is a future step, not something this stores fakes.
 */

import { CONFIG } from '../config';
import type { NodeId } from '../graph/types';

export interface LineageChainItem {
  id: NodeId;
  contentVersion: number;
}

/** Compact, stable key that changes when any ancestor's content changes. */
export function lineageFingerprint(
  rootId: NodeId,
  chain: ReadonlyArray<LineageChainItem>,
): string {
  return `${rootId}|${chain.map((entry) => `${entry.id}:${entry.contentVersion}`).join(',')}`;
}

interface CacheEntry {
  summary: string;
  createdAt: number;
}

export class LineageSummaryStore {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly max: number;

  constructor(max: number = CONFIG.ai.summarize.maxCacheEntries) {
    this.max = Math.max(1, max);
  }

  /** Fresh summary for `fingerprint`, or `undefined`. An LRU touch reorders it. */
  get(fingerprint: string): string | undefined {
    const entry = this.entries.get(fingerprint);
    if (!entry) return undefined;
    // Re-insert to refresh LRU recency.
    this.entries.delete(fingerprint);
    this.entries.set(fingerprint, entry);
    return entry.summary;
  }

  set(fingerprint: string, summary: string, createdAt = Date.now()): void {
    this.entries.set(fingerprint, { summary, createdAt });
    // Evict oldest-recently-used once the cap is exceeded.
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  has(fingerprint: string): boolean {
    return this.entries.has(fingerprint);
  }

  /** Drop any chain referencing a now-deleted node (node deletion cleanup). */
  invalidateNodes(nodeIds: ReadonlySet<NodeId>): void {
    for (const key of this.entries.keys()) {
      if ([...nodeIds].some((id) => key.includes(`|${id}:`) || key.endsWith(id))) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The app-wide cache instance, shared by the summarizer and prompt builder. */
export const lineageSummaryStore = new LineageSummaryStore();