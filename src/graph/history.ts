/**
 * Undo/redo as inverse patches.
 *
 * Storing patches rather than whole-document snapshots keeps history cheap even
 * on a 5,000-node canvas: adding a branch records one node, deleting a subtree
 * records only that subtree, and typing records the two ends of the edit.
 *
 * Consecutive text edits on the same node coalesce into a single entry so one
 * undo reverses a typing burst rather than a single keystroke.
 */

import { MAX_HISTORY_ENTRIES } from '../config';
import { insertNodes, removeNodes } from './graphOperations';
import type { GraphDocument, GraphEdge, NodeId, NoteNode } from './types';

export type NodeFieldPatch = Partial<
  Pick<
    NoteNode,
    | 'title'
    | 'content'
    | 'position'
    | 'size'
    | 'kind'
    | 'collapsed'
    | 'contentVersion'
    | 'updatedAt'
    | 'parentId'
    | 'sourceReference'
  >
>;

export interface NodeUpdate {
  nodeId: NodeId;
  before: NodeFieldPatch;
  after: NodeFieldPatch;
}

export type Patch =
  | { kind: 'insert'; nodes: NoteNode[]; edges: GraphEdge[]; label: string }
  | { kind: 'remove'; nodes: NoteNode[]; edges: GraphEdge[]; label: string }
  | { kind: 'update'; nodeId: NodeId; before: NodeFieldPatch; after: NodeFieldPatch; label: string }
  /** Several nodes changed in one user action (multi-select drag, import repair). */
  | { kind: 'updateMany'; updates: NodeUpdate[]; label: string }
  | { kind: 'structure'; before: GraphDocument; after: GraphDocument; label: string };

export interface HistoryEntry {
  patch: Patch;
  at: number;
}

export interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const EMPTY_HISTORY: HistoryState = { past: [], future: [] };

/** Text edits within this window on the same node merge into one undo step. */
const COALESCE_MS = 700;

export function invertPatch(patch: Patch): Patch {
  switch (patch.kind) {
    case 'insert':
      return { kind: 'remove', nodes: patch.nodes, edges: patch.edges, label: patch.label };
    case 'remove':
      return { kind: 'insert', nodes: patch.nodes, edges: patch.edges, label: patch.label };
    case 'update':
      return {
        kind: 'update',
        nodeId: patch.nodeId,
        before: patch.after,
        after: patch.before,
        label: patch.label,
      };
    case 'updateMany':
      return {
        kind: 'updateMany',
        updates: patch.updates.map((update) => ({
          nodeId: update.nodeId,
          before: update.after,
          after: update.before,
        })),
        label: patch.label,
      };
    case 'structure':
      return { kind: 'structure', before: patch.after, after: patch.before, label: patch.label };
  }
}

export function applyPatch(doc: GraphDocument, patch: Patch, now = Date.now()): GraphDocument {
  switch (patch.kind) {
    case 'insert':
      return insertNodes(doc, patch.nodes, patch.edges, now);
    case 'remove':
      return removeNodes(doc, patch.nodes.map((node) => node.id), now);
    case 'structure':
      return patch.after;
    case 'update': {
      const node = doc.nodes[patch.nodeId];
      if (!node) return doc;
      const next: NoteNode = { ...node, ...patch.after };
      return { ...doc, nodes: { ...doc.nodes, [patch.nodeId]: next }, updatedAt: now };
    }
    case 'updateMany': {
      const nodes = { ...doc.nodes };
      let changed = false;
      for (const update of patch.updates) {
        const node = nodes[update.nodeId];
        if (!node) continue;
        nodes[update.nodeId] = { ...node, ...update.after };
        changed = true;
      }
      return changed ? { ...doc, nodes, updatedAt: now } : doc;
    }
  }
}

export function canUndo(history: HistoryState): boolean {
  return history.past.length > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.future.length > 0;
}

/**
 * Pushes a patch, coalescing compatible text edits and dropping the oldest
 * entries past `MAX_HISTORY_ENTRIES`.
 */
export function pushPatch(
  history: HistoryState,
  patch: Patch,
  now = Date.now(),
): HistoryState {
  const past = history.past.slice();
  const last = past[past.length - 1];

  if (last && shouldCoalesce(last, patch, now)) {
    past[past.length - 1] = {
      at: now,
      patch: { ...patch, before: (last.patch as Extract<Patch, { kind: 'update' }>).before } as Patch,
    };
  } else {
    past.push({ patch, at: now });
  }

  while (past.length > MAX_HISTORY_ENTRIES) past.shift();
  return { past, future: [] };
}

function shouldCoalesce(last: HistoryEntry, next: Patch, now: number): boolean {
  if (now - last.at > COALESCE_MS) return false;
  if (last.patch.kind !== 'update' || next.kind !== 'update') return false;
  if (last.patch.nodeId !== next.nodeId) return false;
  const lastKeys = Object.keys(last.patch.after);
  const nextKeys = Object.keys(next.after);
  if (lastKeys.length !== nextKeys.length) return false;
  return nextKeys.every((key) => lastKeys.includes(key));
}

export interface UndoResult {
  doc: GraphDocument;
  history: HistoryState;
  /** Node that should regain focus after the operation, when known. */
  focusNodeId: NodeId | null;
  label: string | null;
}

export function undo(doc: GraphDocument, history: HistoryState, now = Date.now()): UndoResult {
  const entry = history.past[history.past.length - 1];
  if (!entry) return { doc, history, focusNodeId: null, label: null };
  const inverse = invertPatch(entry.patch);
  return {
    doc: applyPatch(doc, inverse, now),
    history: { past: history.past.slice(0, -1), future: [entry, ...history.future] },
    // Focus is resolved against the patch that was actually applied: undoing a
    // branch creation focuses the parent, not the window that just vanished.
    focusNodeId: focusTargetFor(inverse),
    label: entry.patch.label,
  };
}

export function redo(doc: GraphDocument, history: HistoryState, now = Date.now()): UndoResult {
  const entry = history.future[0];
  if (!entry) return { doc, history, focusNodeId: null, label: null };
  return {
    doc: applyPatch(doc, entry.patch, now),
    history: { past: [...history.past, entry], future: history.future.slice(1) },
    focusNodeId: focusTargetFor(entry.patch),
    label: entry.patch.label,
  };
}

function focusTargetFor(patch: Patch): NodeId | null {
  switch (patch.kind) {
    case 'update':
      return patch.nodeId;
    case 'updateMany':
      return patch.updates[0]?.nodeId ?? null;
    case 'insert':
      return patch.nodes[0]?.id ?? null;
    case 'remove':
      return patch.nodes[0]?.parentId ?? null;
    case 'structure':
      return patch.after.rootNodeId;
  }
}
