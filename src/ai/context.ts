/**
 * Context assembly for future AI requests.
 *
 * The requirement that shapes this module: *do not concatenate every ancestor's
 * full 20,000-character note into a request*. Context is assembled
 * nearest-ancestor-first under an explicit character budget, with each ancestor
 * contributing only as much as the remaining budget allows.
 *
 * Nothing here performs a request; it is pure document → context projection, so
 * it is fully testable today.
 */

import { evaluateSourceReference, getAncestorIds, getNode } from '../graph/graphOperations';
import type { GraphDocument, NodeId } from '../graph/types';
import {
  DEFAULT_CONTEXT_BUDGET,
  type AIContextAncestor,
  type AIContextBudget,
  type AIMessage,
  type AINodeContext,
} from './types';

export interface BuildContextOptions {
  budget?: Partial<AIContextBudget>;
  /** Conversation history for this node, when sessions are wired up. */
  history?: AIMessage[];
  /** Free-form context the user attached to this node. */
  userContext?: string[];
  /** Character budget for the node's own content (the rest is ancestors). */
  maxOwnCharacters?: number;
}

export function buildNodeContext(
  doc: GraphDocument,
  nodeId: NodeId,
  options: BuildContextOptions = {},
): AINodeContext | null {
  const node = getNode(doc, nodeId);
  if (!node) return null;

  const budget: AIContextBudget = { ...DEFAULT_CONTEXT_BUDGET, ...options.budget };

  // Titles are part of the context too, so they are charged against the budget
  // rather than being added on top of it.
  const maxOwn = options.maxOwnCharacters ?? Math.floor(budget.maxCharacters * 0.6);
  const titleCost = node.title.length;
  const own = clip(node.content, Math.max(0, maxOwn - titleCost));
  let remaining = Math.max(0, budget.maxCharacters - own.length - titleCost);

  const ancestors: AIContextAncestor[] = [];
  const ancestorIds = getAncestorIds(doc, nodeId).slice(0, budget.maxAncestors);
  for (let distance = 0; distance < ancestorIds.length; distance += 1) {
    const ancestorId = ancestorIds[distance];
    if (ancestorId === undefined) continue;
    const ancestor = getNode(doc, ancestorId);
    if (!ancestor) continue;
    // Nearest ancestors come first and get at least a useful minimum each. The
    // fair share keeps one long ancestor from consuming the whole budget, and
    // the minimum stops assembly from padding the context with slivers: once
    // the remainder cannot fund a useful excerpt, we stop.
    if (remaining < budget.minAncestorCharacters) break;
    const slotsLeft = ancestorIds.length - distance;
    const share = Math.max(budget.minAncestorCharacters, Math.floor(remaining / slotsLeft));
    const ancestorTitleCost = ancestor.title.length;
    const excerpt = clip(ancestor.content, Math.max(0, share - ancestorTitleCost));
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
    userContext: options.userContext ?? [],
    history: options.history ?? [],
    budget,
  };
}

function clip(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Rough character-based estimate; a real implementation would use the model's tokenizer. */
export function estimateContextCharacters(context: AINodeContext): number {
  let total = context.content.length + context.title.length;
  for (const ancestor of context.ancestors) total += ancestor.excerpt.length + ancestor.title.length;
  for (const message of context.history) total += message.content.length;
  for (const entry of context.userContext) total += entry.length;
  if (context.sourceReference) total += context.sourceReference.selectedTextSnapshot.length;
  return total;
}
