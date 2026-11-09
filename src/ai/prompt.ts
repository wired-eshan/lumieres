/**
 * PROMPT BUILDER — the single place where a request to the LLM is constructed.
 *
 * Everything that depends on the graph — what the model is allowed to know about
 * this window, its ancestors, its source branch, and its own chat history — is
 * decided here. The transport layer (`chatService.ts` + `ai/adapters/`) knows
 * nothing about graphs; it only receives `system` + `messages` and streams the
 * reply. So if you want to change what the AI sees, you edit this file.
 *
 * ── What this file builds ────────────────────────────────────────────────
 *   1. buildNodeContext(...)         a document → context projection: the
 *                                    window's title/body, its nearest ancestors,
 *                                    and its source-reference snapshot, each
 *                                    clipped under a character budget.
 *   2. buildChatSystemPrompt(...)    the system prompt paragraph, stitched from
 *                                    that projection. This is what gives the
 *                                    model its role and its facts about the
 *                                    window, its parent/ancestors and its branch.
 *   3. selectConversationHistory(...)which of this window's past turns the model
 *                                    actually sees, newest-first under a budget.
 *
 * ── The two independent budgets ─────────────────────────────────────────
 * A long chat must not silently crowd the branch lineage out of the request (and
 * vice-versa), so two ceilings are enforced *separately*:
 *   - document/lineage context  → CONFIG.ai.context   (default 8,000 chars)
 *   - conversation history      → CONFIG.ai.history   (default 24,000 chars)
 * Node/ancestor content is clipped per-ancestor, nearest-first, never
 * concatenated in full — a 20,000-char grandparent can never flood the prompt.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────
 *   - Other windows' conversations. Only this window's chat is ever selected.
 *   - The API key. It is resolved only in `chatRuntime` / the adapters and never
 *     assembled into any prompt.
 */

import { AI_HISTORY_BUDGET } from '../config';
import { evaluateSourceReference, getAncestorIds, getNode } from '../graph/graphOperations';
import type { ChatMessage, GraphDocument, NodeId } from '../graph/types';
import {
  lineageFingerprint,
  lineageSummaryStore,
  type LineageChainItem,
  type LineageSummaryStore,
} from './lineageSummaryStore';
import {
  DEFAULT_CONTEXT_BUDGET,
  type AIContextAncestor,
  type AIContextBudget,
  type AIMessage,
  type AINodeContext,
} from './types';

/* ====================================================================== */
/* Types used across prompt construction                                   */
/* ====================================================================== */

/**
 * One normalized conversation turn, exactly as it is handed to the adapter.
 * Distinct from the graph's persisted `ChatMessage` because it has already been
 * filtered/clipped by `selectConversationHistory` and carries only `role` +
 * `content`. Imported by `chatService`, the adapters and `continuationStore`.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/* ====================================================================== */
/* Budget knobs (owned by `src/config.ts`; re-exported for convenience)     */
/* ====================================================================== */

/** Characters of conversation history sent with a request. */
export const DEFAULT_HISTORY_CHARACTERS = AI_HISTORY_BUDGET.maxCharacters;
/** Most conversation turns considered, regardless of size. */
export const MAX_HISTORY_MESSAGES = AI_HISTORY_BUDGET.maxMessages;

/* ====================================================================== */
/* 1. Conversation history selection                                        */
/* ====================================================================== */

/**
 * Chooses which persisted turns of THIS window are sent with the request.
 *
 * PURPOSE
 * -------
 * The full saved chat can grow far larger than any request should carry. This
 * keeps the most recent useful turns, stopping early once it has accumulated
 * `maxCharacters`, and never keeping more than `MAX_HISTORY_MESSAGES`.
 *
 * PARAMETERS
 * ----------
 * - `messages`: the node's persisted `chat` array (oldest first).
 * - `maxCharacters`: ceiling on combined characters of the selected turns
 *   (default from config). The newest turn is always kept even if it alone
 *   exceeds the budget; older turns are dropped once the budget is exhausted.
 *
 * RETURNS
 * -------
 * A strictly newest-first, user-turn-first list of `ChatTurn`. The Messages API
 * requires a user turn first, so leading assistant turns (e.g. a window that
 * started mid-conversation, or a truncated partial) are trimmed.
 */
export function selectConversationHistory(
  messages: readonly ChatMessage[],
  maxCharacters: number = DEFAULT_HISTORY_CHARACTERS,
): ChatTurn[] {
  const usable = messages.filter((message) => message.content.trim().length > 0);
  const selected: ChatMessage[] = [];
  let used = 0;

  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const message = usable[index];
    if (!message) continue;
    if (selected.length >= MAX_HISTORY_MESSAGES) break;
    const cost = message.content.length;
    // Always keep at least the newest turn; otherwise stop before the budget.
    if (selected.length > 0 && used + cost > maxCharacters) break;
    selected.push(message);
    used += cost;
  }

  selected.reverse();
  // The Messages API expects a user turn first. Trim leading assistant turns
  // that were only kept because the window happened to start mid-conversation.
  while (selected.length > 0 && selected[0]?.role !== 'user') selected.shift();
  return selected.map((message) => ({ role: message.role, content: message.content }));
}

/* ====================================================================== */
/* 2. Document → context projection                                         */
/* ====================================================================== */

/** Options that tune how `buildNodeContext` clips the graph into context. */
export interface BuildContextOptions {
  budget?: Partial<AIContextBudget>;
  /**
   * The user's latest message (the question they are asking). When present it
   * selectively prioritises the most relevant ancestors and detects clarify
   * requests. Optional — omitting it keeps the previous nearest-first behaviour.
   */
  query?: string;
  /** Conversation history for this node, when sessions are wired up. */
  history?: AIMessage[];
  /** Free-form context the user attached to this node. */
  userContext?: string[];
  /** Character budget for the node's own content (the rest is ancestors). */
  maxOwnCharacters?: number;
  /**
   * Lineage-summary cache to consult for a cached abstractive "root → current"
   * condensation. Defaults to the app-wide `lineageSummaryStore`. Injection is
   * provided so tests can supply a clean store per case.
   */
  lineageStore?: LineageSummaryStore;
}

/**
 * Projects a node (plus its lineage) into the object the system prompt is built
 * from. This is the go-between for future autocomplete/Q&A surfaces too.
 *
 * PURPOSE
 * -------
 * Turn the graph into a shaped, budgeted bundle of what the model may read about
 * THIS window, WITHOUT concatenating every ancestor's full note. It is a pure
 * document → data projection: it performs no request and never touches the
 * runtime, so it is fully unit-testable on its own.
 *
 * PARAMETERS
 * ----------
 * - `doc` / `nodeId`: the graph document and the window to build context for.
 * - `budget`: optional overrides on top of `DEFAULT_CONTEXT_BUDGET`. The shared
 *   ceiling (`maxCharacters`, default 8,000) caps everything; the node's own
 *   body (optionally through `maxOwnCharacters`, default 60% of the ceiling)
 *   is charged first, and ancestors take what remains.
 * - `query`: the user's latest message. When present it (a) detects clarify
 *   requests, (b) scores ancestors for relevance, and (c) prioritises the most
 *   relevant ones. Without it the legacy nearest-first behaviour is preserved.
 * - `history` / `userContext`: optional prebuilt conversation turns and free-form
 *   user text to include (kept as data here; not yet wired to a settings UI).
 *
 * ANCESTOR SELECTION (the part that made deep branches lose context)
 * -------
 * Previously the nearest `maxAncestors` (default 4) were sliced off regardless
 * of budget, so a node more than ~4 hops from the root silently dropped the
 * original problem. Now:
 *   1. The **root / original concept is always preserved** as `rootAncestor`,
 *      independently of `maxAncestors`.
 *   2. The **nearest 1–2 ancestors** (parent, grandparent) are always kept.
 *   3. The remaining lineage slots are filled by the ancestors **most relevant
 *      to the current query** (deterministic lexical scoring), nearest-first
 *      ties broken by proximity.
 *   4. A **clarify** query biases the budget so the root and relevant lineage
 *      get more of the remaining characters.
 * The character budget and `minAncestorCharacters` stop rule still bound
 * everything, so a long branch cannot exceed the ceiling.
 *
 * RETURNS
 * -------
 * An `AINodeContext` containing `title`, `content` (the node's clipped body),
 * `sourceReference` (frozen branch snapshot + evaluated `stale` flag),
 * `rootAncestor` (the preserved original concept, or `null` for a root node),
 * `ancestors` (selected clipped excerpts, nearest-first), `intent`, `history`,
 * `userContext` and the effective `budget`. Returns `null` when the node does
 * not exist.
 */
export function buildNodeContext(
  doc: GraphDocument,
  nodeId: NodeId,
  options: BuildContextOptions = {},
): AINodeContext | null {
  const node = getNode(doc, nodeId);
  if (!node) return null;

  const budget: AIContextBudget = { ...DEFAULT_CONTEXT_BUDGET, ...options.budget };
  const query = options.query?.trim() ?? '';
  const intent = query.length > 0 ? analyzeIntent(query) : 'normal';

  // Titles are part of the context too, so they are charged against the budget
  // rather than being added on top of it.
  const maxOwn = options.maxOwnCharacters ?? Math.floor(budget.maxCharacters * 0.6);
  const titleCost = node.title.length;
  const own = clip(node.content, Math.max(0, maxOwn - titleCost));
  let remaining = Math.max(0, budget.maxCharacters - own.length - titleCost);

  // Ancestors, nearest-first up to the root.
  const chainIds = getAncestorIds(doc, nodeId);
  const relevance = scoreAncestors(chainIds, doc, query);

  // Resolve a cached abstractive lineage summary (root → relevant ancestors →
  // current). When present it becomes the carrying context; when the chain has
  // no fresh summary yet but one is possible, `lineageSummaryNeeded` tells the
  // fire-and-forget warmer to build one for the next request. The interactive
  // send is never blocked on the model — this only reads the in-memory cache.
  const chainItems: LineageChainItem[] = [];
  for (const ancestorId of chainIds) {
    const ancestorNode = getNode(doc, ancestorId);
    if (ancestorNode) chainItems.push({ id: ancestorNode.id, contentVersion: ancestorNode.contentVersion });
  }
  const store = options.lineageStore ?? lineageSummaryStore;
  const rootId = chainItems.length > 0 ? chainItems[chainItems.length - 1]?.id : undefined;
  let lineageSummary: string | undefined;
  let lineageSummaryNeeded = false;
  if (chainItems.length > 0 && rootId !== undefined) {
    const fingerprint = lineageFingerprint(rootId, chainItems);
    const cached = store.get(fingerprint);
    if (cached !== undefined) {
      lineageSummary = cached;
    } else {
      lineageSummaryNeeded = true;
    }
  }
  // When a fresh lineage summary exists, let it carry the content and keep the
  // raw root/ancestor excerpts out of the budget (titles remain for orientation).
  const useSummary = lineageSummary !== undefined;

  // Always keep the root / original concept, even for deep nodes.
  let rootAncestor: AIContextAncestor | null = null;
  if (chainIds.length > 0) {
    if (rootId !== undefined) {
      const root = getNode(doc, rootId);
      if (root) {
        const rootShare = intent === 'clarify'
          ? Math.max(budget.minAncestorCharacters * 2, Math.floor(remaining * 0.4))
          : Math.max(budget.minAncestorCharacters, Math.floor(remaining * 0.3));
        const rootTitleCost = root.title.length;
        const rootExcerpt = useSummary
          ? ''
          : summarizeExtractive(root.content, {
              query,
              max: Math.max(0, rootShare - rootTitleCost),
            });
        if (rootExcerpt.length > 0 || root.title.trim().length > 0) {
          rootAncestor = {
            nodeId: root.id,
            title: root.title,
            excerpt: rootExcerpt,
            distance: chainIds.length,
          };
          remaining -= rootExcerpt.length + rootTitleCost;
        }
      }
    }
  }

  // Choose which non-root ancestors to include, nearest-first, prioritising the
  // most relevant for the current query. The root is already reserved above.
  const candidates = selectAncestors(chainIds, { budget, relevance, query });
  const ancestors: AIContextAncestor[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (remaining < budget.minAncestorCharacters) break;
    const candidate = candidates[index];
    if (candidate === undefined) continue;
    const ancestor = getNode(doc, candidate);
    if (!ancestor) continue;
    const distance = chainIds.indexOf(candidate) + 1;
    const slotsLeft = candidates.length - index;
    // Relevant ancestors get more of the remaining budget; others a fair share.
    const boost = query.length > 0 && (relevance?.get(ancestor.id) ?? 0) > 0 ? 1.5 : 1;
    const share = Math.max(
      budget.minAncestorCharacters,
      Math.floor((remaining / slotsLeft) * boost),
    );
    const ancestorTitleCost = ancestor.title.length;
    // Relevant ancestors are condensed (extractive) so the query-relevant gist
    // wins; the rest stay a clipped raw prefix. With a lineage summary present,
    // every excerpt is dropped to leave room for the summary.
    const relevant = query.length > 0 && (relevance?.get(ancestor.id) ?? 0) > 0;
    const excerpt = useSummary
      ? ''
      : relevant
        ? summarizeExtractive(ancestor.content, {
            query,
            max: Math.max(0, share - ancestorTitleCost),
          })
        : clip(ancestor.content, Math.max(0, share - ancestorTitleCost));
    if (excerpt.length === 0 && ancestor.title.trim().length === 0) continue;
    ancestors.push({ nodeId: ancestor.id, title: ancestor.title, excerpt, distance });
    remaining -= excerpt.length + ancestorTitleCost;
    if (remaining <= 0) break;
  }

  const evaluation = evaluateSourceReference(doc, node);

  return {
    nodeId,
    title: node.title,
    content: own,
    sourceReference: evaluation.reference
      ? {
          sourceNodeId: evaluation.reference.sourceNodeId,
          selectedTextSnapshot: evaluation.reference.selectedTextSnapshot,
          startOffset: evaluation.reference.startOffset,
          endOffset: evaluation.reference.endOffset,
          stale: evaluation.status === 'stale',
        }
      : null,
    ancestors,
    rootAncestor,
    ancestorRelevance: relevance,
    intent,
    userContext: options.userContext ?? [],
    history: options.history ?? [],
    budget,
    lineageSummary,
    lineageSummaryNeeded,
  };
}

/**
 * A rough character-based estimate of how much of the prompt the assembled
 * context occupies (used by tooling/tests). A real implementation would use the
 * model's tokenizer; this is a plain `length`-based approximation.
 */
export function estimateContextCharacters(context: AINodeContext): number {
  let total = context.content.length + context.title.length;
  for (const ancestor of context.ancestors) total += ancestor.excerpt.length + ancestor.title.length;
  if (context.rootAncestor) total += context.rootAncestor.excerpt.length + context.rootAncestor.title.length;
  for (const message of context.history) total += message.content.length;
  for (const entry of context.userContext) total += entry.length;
  if (context.sourceReference) total += context.sourceReference.selectedTextSnapshot.length;
  return total;
}

function clip(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/* ====================================================================== */
/* 3b. Deterministic extractive summarizer (the always-on default)          */
/* ====================================================================== */

/** Splits text into sentence/line units for extractive selection. */
function splitUnits(text: string): string[] {
  return text
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/)
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0);
}

/** Counts how many distinct query tokens appear in a unit (deterministic). */
function overlapCount(queryTokens: Set<string>, text: string): number {
  const textTokens = tokenize(text);
  let hits = 0;
  for (const token of queryTokens) if (textTokens.has(token)) hits += 1;
  return hits;
}

/**
 * No-LLM condenser used whenever no cached abstractive lineage summary exists.
 * Scores each sentence/line of `content` by (a) lexical overlap with the query
 * and (b) a mild near-top position bias, then emits the top-K unique units in
 * original order, clipped to `max`. Deterministic and dependency-free, so the
 * offline/tooling path stays instant and never requires a provider key.
 *
 * Degrades to a clipped prefix when the text has no sentence/line breaks, so a
 * single long run (e.g. code) still produces a bounded excerpt.
 */
function summarizeExtractive(
  content: string,
  options: { query: string; max: number },
): string {
  const { query, max } = options;
  if (max <= 0) return '';
  if (content.length <= max) return content;

  const units = splitUnits(content);
  if (units.length <= 1) return clip(content, max);

  const queryTokens = query ? tokenize(query) : null;
  const scored = units.map((text, index) => ({
    text,
    index,
    score: (queryTokens ? overlapCount(queryTokens, text) : 0) + 1 + (units.length - index),
  }));
  scored.sort((a, b) => b.score - a.score);

  const kept: Array<{ text: string; index: number }> = [];
  let used = 0;
  for (const unit of scored) {
    if (used + unit.text.length > max) continue;
    // Skip a near-copy already selected so the summary stays tight.
    const covered = kept.some(
      (chosen) =>
        chosen.text.includes(unit.text.slice(0, 40)) ||
        unit.text.includes(chosen.text.slice(0, 40)),
    );
    if (covered) continue;
    kept.push(unit);
    used += unit.text.length;
    if (used >= max) break;
  }
  if (kept.length === 0) return clip(content, max);

  kept.sort((a, b) => a.index - b.index);
  return clip(kept.map((unit) => unit.text).join(' '), max);
}

/* ====================================================================== */
/* 4. Query-aware ancestor selection (helpful internals)                    */
/* ====================================================================== */

/** Words/phrases that mark a request as wanting a clearer explanation. */
const CLARIFY_PATTERN = /\b(explain|clarif|again|confus|why|what is|what does|walk me through|simpler|simplif|re-?explain|dumb(ed)? down|make (it|this) (clear|simpler|easier)|understand better|not? (getting|grasping))\b/i;

/**
 * Deterministic, dependency-free intent classifier. `true` when the query reads
 * like a request for a clearer explanation — exactly the deep-branch "explain
 * this more clearly" case we want to re-ground in the original concept.
 */
function analyzeIntent(query: string): 'clarify' | 'normal' {
  return CLARIFY_PATTERN.test(query) ? 'clarify' : 'normal';
}

/** Lowercases and splits text into word tokens for lexical relevance scoring. */
function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

/**
 * Scores each ancestor's relevance against the query by term overlap
 * (intersection of query tokens with the ancestor's title + content, weighted
 * so title hits count double). Deterministic and cheap; deliberately no
 * embeddings or LLM. Returns `null` when there is no query.
 */
function scoreAncestors(
  chainIds: NodeId[],
  doc: GraphDocument,
  query: string,
): Map<NodeId, number> | null {
  if (query.length === 0) return null;
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return null;

  const scores = new Map<NodeId, number>();
  for (const ancestorId of chainIds) {
    const ancestor = getNode(doc, ancestorId);
    if (!ancestor) continue;
    const titleTokens = tokenize(ancestor.title);
    const bodyTokens = tokenize(ancestor.content);
    let score = 0;
    for (const token of queryTokens) {
      if (titleTokens.has(token)) score += 2;
      if (bodyTokens.has(token)) score += 1;
    }
    if (score > 0) scores.set(ancestorId, score);
  }
  return scores;
}

interface SelectAncestorsOptions {
  budget: AIContextBudget;
  /** Relevance scores keyed by node id; may be null (no query). */
  relevance: Map<NodeId, number> | null;
  /** The user's trimmed query, or '' when absent. */
  query: string;
}

/**
 * Picks which non-root ancestors to include, nearest-first.
 * Always keeps the nearest 1–2 (the immediate working chain); the remaining
 * slots up to `maxAncestors` are filled by the most *relevant* ancestors for the
 * current query, falling back to proximity when there is no query. The root is
 * handled separately by `buildNodeContext` and never appears here.
 */
function selectAncestors(
  chainIds: NodeId[],
  options: SelectAncestorsOptions,
): NodeId[] {
  if (chainIds.length <= 1) return [];
  // Drop the root (last element); it is preserved separately as the anchor.
  const nonRoot = chainIds.slice(0, -1);

  // Nearest 1–2 working ancestors always stay.
  const nearest = nonRoot.slice(0, 2);
  const rest = nonRoot.slice(2);

  // Prefer the most relevant rest ancestors (stable by proximity as tie-break).
  const orderedRest = [...rest].sort((a, b) => {
    const scoreA = options.relevance?.get(a) ?? 0;
    const scoreB = options.relevance?.get(b) ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return nonRoot.indexOf(a) - nonRoot.indexOf(b);
  });

  const maxRest = Math.max(0, options.budget.maxAncestors - nearest.length);
  return [...nearest, ...orderedRest.slice(0, maxRest)];
}

/* ====================================================================== */
/* 3. System prompt construction                                            */
/* ====================================================================== */

/**
 * Builds the system prompt paragraph for one AI window's request.
 *
 * PURPOSE
 * -------
 * This is the text that tells the model (a) its role as the collaborator inside
 * one Lumières window, and (b) the concrete facts it may rely on: the window's
 * title, the note body the user keeps in this window, the selected-text snapshot
 * if this window was branched from a selection, and the nearest ancestors'
 * excerpts. It deliberately does NOT include other windows' conversations or the
 * whole subtree.
 *
 * PARAMETERS
 * ----------
 * - `doc`: the current graph document (read live, so ancestors' content reflects
 *   their latest saved state at send time).
 * - `nodeId`: the window this chat belongs to. Its `title`, `content`,
 *   `sourceReference`, root and ancestor lineage come from `buildNodeContext(doc, nodeId)`.
 * - `query`: optional — the user's latest message, forwarded to `buildNodeContext`
 *   so relevant ancestors are prioritised and clarify requests get their own
 *   grounding instruction.
 *
 * WHAT GETS STITCHED (in order):
 *   1. A role/identity paragraph for the windowed collaborator.
 *   2. The window's title (or "(untitled)").
 *   3. The window's own note body, when non-empty, as editable context.
 *   4. The branch source-reference snapshot, when present, with an inline stale
 *      warning if the source node's content has changed since branching.
 *   5. The **root / original concept**, when present, as a highlighted anchor
 *      (`Original problem / source concept`), so deep branches never lose it.
 *   6. A nearest-first lineage of ancestors as short `- Parent/Ancestor — excerpt`
 *      lines, when any survived the budget.
 *   7. On a **clarify** request, an instruction telling the model to re-ground its
 *      answer in the original concept rather than assume prior knowledge.
 *   8. A closing note that the conversation history belongs to this window only.
 *
 * RETURNS
 * -------
 * A single string. When the node is missing it falls back to a minimal harmless
 * assistant instruction.
 */
export function buildChatSystemPrompt(
  doc: GraphDocument,
  nodeId: NodeId,
  options: { query?: string } = {},
): string {
  const node = doc.nodes[nodeId];
  if (!node) return 'You are a helpful assistant.';

  const context = buildNodeContext(doc, nodeId, { query: options.query });
  const sections: string[] = [
    'You are the AI collaborator inside one window of Lumières, a graph-structured thinking canvas. Every window is a node in a tree; the user can select any of your replies and branch it into a new window.',
    'Answer the conversation in this window only. Be direct and useful. Reply in plain text with short paragraphs; Markdown is shown literally in this window, so avoid decorative syntax and avoid tables.',
  ];

  sections.push(`Window title: ${node.title.trim() || '(untitled)'}`);

  if (context && context.content.trim().length > 0) {
    sections.push(
      `The user keeps this note in the same window as context for the conversation:\n"""\n${context.content}\n"""`,
    );
  }

  if (context?.sourceReference) {
    const stale = context.sourceReference.stale ? ' (the source has changed since this branch was made)' : '';
    sections.push(
      `This branch was created from selected text${stale}:\n"""\n${context.sourceReference.selectedTextSnapshot}\n"""`,
    );
  }

  if (context?.lineageSummary) {
    // A fresh abstractive condensation carries the chain content; titles are
    // listed for orientation so the model can still place each window.
    sections.push(`Lineage summary (root → current):\n"""\n${context.lineageSummary}\n"""`);
    const titles: string[] = [];
    if (context.rootAncestor) titles.push(context.rootAncestor.title || '(untitled)');
    for (let index = context.ancestors.length - 1; index >= 0; index -= 1) {
      const ancestor = context.ancestors[index];
      if (ancestor) titles.push(ancestor.title || '(untitled)');
    }
    sections.push(`Lineage, oldest → nearest: ${titles.join(' → ')}`);
  } else {
    if (context?.rootAncestor) {
      const root = context.rootAncestor;
      sections.push(
        `Original problem / source concept of this branch:\n- ${root.title || '(untitled)'}${root.excerpt ? ` — ${root.excerpt}` : ''}`,
      );
    }

    if (context && context.ancestors.length > 0) {
      const lineage = context.ancestors
        .map(
          (ancestor) =>
            `- ${ancestor.distance === 1 ? 'Parent' : `Ancestor (${ancestor.distance} up)`}: ${ancestor.title || '(untitled)'}${ancestor.excerpt ? ` — ${ancestor.excerpt}` : ''}`,
        )
        .join('\n');
      sections.push(`Nearby lineage, nearest first (excerpts only):\n${lineage}`);
    }
  }

  if (context?.intent === 'clarify') {
    sections.push(
      'The user is asking for a clearer explanation. Ground your answer in the original problem / source concept above and re-explain the relevant chain of ideas, rather than assuming prior knowledge.',
    );
  }

  sections.push('The conversation history below belongs to this window alone. Do not assume access to any other window\'s chat.');
  return sections.join('\n\n');
}