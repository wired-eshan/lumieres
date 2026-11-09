/**
 * Collects the source ranges a window's branches were created from.
 *
 * Both the canvas renderer (note bodies) and the AI chat panel (reply text)
 * need the same answer: which phrases in *this* window seeded a descendant
 * branch, and where do they sit in the live text? Keeping the query in one
 * pure module is what stops the two renderers from drifting — a mismatch here
 * paints a highlight over the wrong words.
 *
 * Only `valid` references are returned. A stale reference keeps its snapshot in
 * the child's source chip; painting a range whose text no longer matches would
 * misrepresent where the branch actually came from.
 */

import type { GraphDocument, NodeId } from './types';
import { evaluateSourceReference, getDescendantIds, getNode } from './graphOperations';

export interface SourceRange {
  /** UTF-16 offsets into the source text (note body or message content). */
  start: number;
  end: number;
}

/**
 * Note-body ranges in `nodeId` that descendant branches came from.
 *
 * A window can seed several branches, and a branch may itself have descendants —
 * but only the *immediate* relationship (`sourceNodeId`) decides which body the
 * offsets index. References recorded against an AI message are excluded here;
 * they belong to that message's renderer.
 */
export function collectBodySourceRanges(doc: GraphDocument, nodeId: NodeId): SourceRange[] {
  const ranges: SourceRange[] = [];
  for (const descendantId of getDescendantIds(doc, nodeId)) {
    const descendant = getNode(doc, descendantId);
    const reference = descendant?.sourceReference;
    if (!reference) continue;
    // The reference must point at *this* window: a reparented child keeps its
    // old reference, and painting its offsets here would be meaningless.
    if (reference.sourceNodeId !== nodeId) continue;
    if (reference.sourceMessageId) continue;
    if (evaluateSourceReference(doc, descendant).status !== 'valid') continue;
    ranges.push({ start: reference.startOffset, end: reference.endOffset });
  }
  return ranges;
}

/**
 * Reply ranges in `nodeId`, keyed by message id, that descendant branches came
 * from. Each message can be the source of several branches (and nested phrases
 * can overlap), so the values are lists the renderer merges when painting.
 */
export function collectMessageSourceRanges(
  doc: GraphDocument,
  nodeId: NodeId,
): Map<string, SourceRange[]> {
  const ranges = new Map<string, SourceRange[]>();
  for (const descendantId of getDescendantIds(doc, nodeId)) {
    const descendant = getNode(doc, descendantId);
    const reference = descendant?.sourceReference;
    if (!reference) continue;
    if (reference.sourceNodeId !== nodeId) continue;
    if (!reference.sourceMessageId) continue;
    if (evaluateSourceReference(doc, descendant).status !== 'valid') continue;
    const list = ranges.get(reference.sourceMessageId) ?? [];
    list.push({ start: reference.startOffset, end: reference.endOffset });
    ranges.set(reference.sourceMessageId, list);
  }
  return ranges;
}
