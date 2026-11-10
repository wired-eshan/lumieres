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
 *
 * The lookup is indexed by source node rather than answered by walking every
 * descendant. The renderer asks this question for each visible window on every
 * frame, and `getDescendantIds` rebuilds a children map from the whole document
 * (an O(N) scan) — at 5,000 nodes and ~1,000 visible windows that alone cost
 * about a second per frame. The index is memoised on the document object, which
 * is immutable: every graph operation produces a new document, so a cached
 * index is never stale and is released with the document it describes.
 */

import type { GraphDocument, NodeId, NoteNode } from './types';
import { evaluateSourceReference } from './graphOperations';

export interface SourceRange {
  /** UTF-16 offsets into the source text (note body or message content). */
  start: number;
  end: number;
}

/** Nodes whose reference is attributed to `nodeId`, built once per document. */
const referenceIndexByDocument = new WeakMap<GraphDocument, Map<NodeId, NoteNode[]>>();
const NO_REFERENCES: readonly NoteNode[] = [];

function referencesFrom(doc: GraphDocument, nodeId: NodeId): readonly NoteNode[] {
  let index = referenceIndexByDocument.get(doc);
  if (!index) {
    index = new Map();
    for (const node of Object.values(doc.nodes)) {
      const reference = node.sourceReference;
      if (!reference) continue;
      const list = index.get(reference.sourceNodeId);
      if (list) list.push(node);
      else index.set(reference.sourceNodeId, [node]);
    }
    referenceIndexByDocument.set(doc, index);
  }
  return index.get(nodeId) ?? NO_REFERENCES;
}

/**
 * Whether `nodeId` still sits under `ancestorId`. The index is keyed only by
 * `sourceNodeId`, but a child reparented elsewhere keeps its original
 * reference; its offsets index the window it came from, so they must not paint
 * on a window it no longer descends from. The walk is as deep as the tree, not
 * as large as the document.
 */
function isDescendantOf(doc: GraphDocument, nodeId: NodeId, ancestorId: NodeId): boolean {
  let parentId = doc.nodes[nodeId]?.parentId ?? null;
  while (parentId !== null) {
    if (parentId === ancestorId) return true;
    parentId = doc.nodes[parentId]?.parentId ?? null;
  }
  return false;
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
  for (const descendant of referencesFrom(doc, nodeId)) {
    const reference = descendant.sourceReference;
    if (!reference) continue;
    if (reference.sourceMessageId) continue;
    if (!isDescendantOf(doc, descendant.id, nodeId)) continue;
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
  for (const descendant of referencesFrom(doc, nodeId)) {
    const reference = descendant.sourceReference;
    if (!reference) continue;
    if (!reference.sourceMessageId) continue;
    if (!isDescendantOf(doc, descendant.id, nodeId)) continue;
    if (evaluateSourceReference(doc, descendant).status !== 'valid') continue;
    const list = ranges.get(reference.sourceMessageId) ?? [];
    list.push({ start: reference.startOffset, end: reference.endOffset });
    ranges.set(reference.sourceMessageId, list);
  }
  return ranges;
}
