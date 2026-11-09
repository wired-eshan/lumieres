/**
 * Lineage summarizer — the LLM half of hybrid ancestor-context summarization.
 *
 * When the user supplies a provider key, a deep branch can carry a *coherent*
 * condensation of its idea chain (root → relevant ancestors → current) instead
 * of only independently-extracted sentence snippets. This module owns that
 * provider call and its in-memory cache (`lineageSummaryStore.ts`).
 *
 * It is deliberately honest about AGENTS.md's "no fake AI":
 *  - with **no key configured** it makes **no call** and returns nothing — the
 *    deterministic extractive summarizer in `prompt.ts` is what the prompt uses;
 *  - when a key exists it is a real request through the same provider transport
 *    as chat (`generateChat`), never a stub.
 *
 * It is also deliberately non-blocking for the interactive flow:
 *  - `warm(nodeId, doc, query)` checks the cache, then fires the model request
 *    in the background and is never awaited by the send path;
 *  - a small dedicated concurrency gate (separate from the chat cap) bounds how
 *    many background summaries run at once;
 *  - because the cache key is a content fingerprint of the chain, editing any
 *    ancestor invalidates and the *next* request rebuilds a fresh summary.
 */

import { CONFIG } from '../config';
import { getAncestorIds, getNode } from '../graph/graphOperations';
import type { GraphDocument, NodeId } from '../graph/types';
import { createId } from '../utils/id';
import { generateChat, type GenerateChatInput } from './chatService';
import {
  lineageFingerprint,
  lineageSummaryStore,
  type LineageChainItem,
  type LineageSummaryStore,
} from './lineageSummaryStore';
import { buildNodeContext } from './prompt';
import { getAISettings, resolveAISettings, type AISettings } from './settings';

export interface LineageSummarizerDeps {
  store: LineageSummaryStore;
  getSettings: () => AISettings;
  /** Non-streaming provider completion (the same transport the chat runtime uses). */
  generate: (input: GenerateChatInput) => Promise<{ text: string }>;
  newId: (prefix: string) => string;
  now: () => number;
  /** Dedicated background-summary concurrency (separate from chat requests). */
  maxConcurrent: number;
  /** Soft target summary length. */
  targetCharacters: number;
  /** Hard cap so a chatty model cannot stuff an arbitrarily long summary. */
  maxSummaryCharacters: number;
}

/** Caps a stored summary so a verbose model cannot blow the prompt budget. */
function clampSummary(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export class LineageSummarizer {
  private readonly deps: LineageSummarizerDeps;
  private active = 0;

  constructor(deps: LineageSummarizerDeps) {
    this.deps = deps;
  }

  /**
   * Fire-and-forget warm-up. No-op when: the node has no lineage, a fresh
   * summary is already cached, no key is configured, or the gate is full. Never
   * throws to the caller and never waits for the model.
   */
  warm(nodeId: NodeId, doc: GraphDocument, query: string): void {
    const chainItems = this.chainItems(doc, nodeId);
    const rootId = chainItems.length > 0 ? chainItems[chainItems.length - 1]?.id : undefined;
    if (chainItems.length === 0 || rootId === undefined) return;
    const fingerprint = lineageFingerprint(rootId, chainItems);
    if (this.deps.store.has(fingerprint)) return;
    if (resolveAISettings(this.deps.getSettings()).apiKey.length === 0) return;
    if (this.active >= this.deps.maxConcurrent) return;

    this.active += 1;
    void this.work(nodeId, doc, query, fingerprint)
      .catch(() => undefined)
      .finally(() => {
        this.active -= 1;
      });
  }

  /** The chain of ancestors (nearest-first up to the root) with content versions. */
  private chainItems(doc: GraphDocument, nodeId: NodeId): LineageChainItem[] {
    const items: LineageChainItem[] = [];
    for (const ancestorId of getAncestorIds(doc, nodeId)) {
      const node = getNode(doc, ancestorId);
      if (node) items.push({ id: node.id, contentVersion: node.contentVersion });
    }
    return items;
  }

  private async work(
    nodeId: NodeId,
    doc: GraphDocument,
    query: string,
    fingerprint: string,
  ): Promise<void> {
    // Someone may have summarised this exact chain while we were queued.
    if (this.deps.store.has(fingerprint)) return;

    const context = buildNodeContext(doc, nodeId, {
      query,
      lineageStore: this.deps.store,
    });
    if (!context) return;

    // Assemble the idea chain from the already-budgeted, extractively-summarised
    // root + selected relevant ancestors.
    const lines: string[] = [];
    if (context.rootAncestor) {
      const root = context.rootAncestor;
      lines.push(`${root.title.trim() || '(untitled)'}${root.excerpt ? ` — ${root.excerpt}` : ''}`);
    }
    for (const ancestor of context.ancestors) {
      lines.push(
        `${ancestor.title.trim() || '(untitled)'}${ancestor.excerpt ? ` — ${ancestor.excerpt}` : ''}`,
      );
    }
    const chainText = lines.join('\n');
    if (chainText.trim().length === 0) return;

    const config = resolveAISettings(this.deps.getSettings());
    const system =
      'You are condensing the ancestor lineage of a study canvas so a later model can ' +
      'answer follow-up questions about it. Produce ONE plain-text paragraph that preserves the ' +
      `original problem/concept and the key logical steps from the root down to the current detail. ` +
      `Do not add a preamble, headings or bullet syntax. Aim for at most ${this.deps.targetCharacters} characters.`;
    const messages = [
      {
        role: 'user' as const,
        content:
          `Condense the following ancestor lineage into ONE plain-text paragraph, preserving the ` +
          `original problem/concept and the key logical steps down to the current detail. The user ` +
          `recently asked: "${query}".\n\nLineage to condense:\n${chainText}`,
      },
    ];

    try {
      const result = await this.deps.generate({ config, system, messages });
      const summary = clampSummary(result.text.trim(), this.deps.maxSummaryCharacters);
      if (summary.length > 0) {
        this.deps.store.set(fingerprint, summary, this.deps.now());
      }
    } catch {
      // Best-effort: a failed background summary is simply not cached; the
      // deterministic extractive fallback already covered this request.
    }
  }
}

/** The app-wide summarizer, kept out of the graph document. */
export const lineageSummarizer = new LineageSummarizer({
  store: lineageSummaryStore,
  getSettings: getAISettings,
  generate: generateChat,
  newId: createId,
  now: () => Date.now(),
  maxConcurrent: CONFIG.ai.summarize.maxConcurrent,
  targetCharacters: CONFIG.ai.summarize.targetCharacters,
  maxSummaryCharacters: Math.max(800, CONFIG.ai.summarize.targetCharacters * 2),
});