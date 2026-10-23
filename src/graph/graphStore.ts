/**
 * The document store.
 *
 * Holds the graph document, its undo history and persistence status. It knows
 * nothing about the canvas, React or storage — components and the render engine
 * both drive it through the same actions, so every mutation is validated and
 * recorded for undo in one place.
 *
 * `lastChange` is a hint for the renderer: it names the nodes an action touched
 * so the canvas can invalidate exactly those entries instead of diffing (or
 * re-indexing) the whole graph after every keystroke.
 */

import { create } from 'zustand';
import {
  appendChatMessage as appendChatMessageOp,
  createBranch,
  createEmptyDocument,
  deleteSubtree,
  getChildCount,
  getNode,
  moveNodes as moveNodesOp,
  resetCanvas as resetCanvasOp,
  resizeNode as resizeNodeOp,
  setDocumentTitle,
  setNodeCollapsed,
  setNodeKind as setNodeKindOp,
  updateNodeContent,
  updateNodeTitle,
} from './graphOperations';
import {
  EMPTY_HISTORY,
  pushPatch,
  redo,
  undo,
  type HistoryState,
  type NodeUpdate,
  type Patch,
} from './history';
import { canonicalChildPosition } from './layout';
import type {
  ChatMessage,
  GraphDocument,
  NodeId,
  NoteNode,
  OperationResult,
  Point,
  SourceReference,
  WindowKind,
  WindowSize,
} from './types';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface ChangeHint {
  /** Nodes whose visual state changed and must be re-measured. */
  ids: NodeId[];
  added: NodeId[];
  removed: NodeId[];
  /** A wholesale replacement happened; rebuild all derived caches. */
  full: boolean;
  /**
   * The document object was replaced by load/import rather than by undo/redo.
   * `full` alone cannot carry this distinction: undo and redo also rebuild the
   * whole document, but they must not abort unrelated in-flight AI requests.
   */
  replaced: boolean;
}

const NO_CHANGE: ChangeHint = {
  ids: [],
  added: [],
  removed: [],
  full: false,
  replaced: false,
};

export interface AddBranchInput {
  position?: Point;
  title?: string;
  content?: string;
  kind?: WindowKind;
  size?: WindowSize;
  sourceReference?: SourceReference | null;
}

export interface GraphStoreState {
  doc: GraphDocument;
  /** Bumped on every document change; cheap subscription key for the renderer. */
  revision: number;
  lastChange: ChangeHint;
  history: HistoryState;
  saveStatus: SaveStatus;
  lastSavedAt: number | null;
  saveError: string | null;

  addBranch: (parentId: NodeId, input?: AddBranchInput) => OperationResult<{ node: NoteNode }>;
  updateContent: (nodeId: NodeId, content: string) => OperationResult<{ node: NoteNode }>;
  updateTitle: (nodeId: NodeId, title: string) => OperationResult<{ node: NoteNode }>;
  moveNodes: (positions: Record<NodeId, Point>) => OperationResult<null>;
  resizeNode: (nodeId: NodeId, size: WindowSize) => OperationResult<{ node: NoteNode }>;
  setNodeKind: (nodeId: NodeId, kind: WindowKind) => OperationResult<{ node: NoteNode }>;
  appendChatMessage: (nodeId: NodeId, message: ChatMessage) => OperationResult<{ node: NoteNode }>;
  setCollapsed: (nodeId: NodeId, collapsed: boolean) => OperationResult<{ node: NoteNode }>;
  deleteSubtree: (nodeId: NodeId) => OperationResult<{ removedCount: number; parentId: NodeId | null }>;
  resetCanvas: () => void;
  setDocumentTitle: (title: string) => OperationResult<null>;

  undo: () => { focusNodeId: NodeId | null; label: string | null } | null;
  redo: () => { focusNodeId: NodeId | null; label: string | null } | null;

  replaceDocument: (doc: GraphDocument, options?: { resetHistory?: boolean }) => void;

  setSaveStatus: (status: SaveStatus, detail?: { at?: number; error?: string | null }) => void;
}

function hint(partial: Partial<ChangeHint>): ChangeHint {
  return { ...NO_CHANGE, ...partial };
}

export const useGraphStore = create<GraphStoreState>((set, get) => {
  /** Applies a document change together with its undo patch. */
  const commit = (doc: GraphDocument, patch: Patch | null, change: ChangeHint, now = Date.now()) => {
    set((state) => ({
      doc,
      revision: state.revision + 1,
      lastChange: change,
      history: patch ? pushPatch(state.history, patch, now) : state.history,
      saveStatus: state.saveStatus === 'saving' ? 'saving' : 'dirty',
    }));
  };

  return {
    doc: createEmptyDocument(),
    revision: 0,
    lastChange: hint({ full: true }),
    history: EMPTY_HISTORY,
    saveStatus: 'idle',
    lastSavedAt: null,
    saveError: null,

    addBranch: (parentId, input = {}) => {
      const state = get();
      const parent = getNode(state.doc, parentId);
      if (!parent) {
        return { ok: false, code: 'PARENT_NOT_FOUND', message: 'That note no longer exists.' };
      }
      const position = input.position ?? canonicalChildPosition(parent, getChildCount(state.doc, parentId));

      const result = createBranch(state.doc, {
        parentId,
        position,
        title: input.title ?? '',
        content: input.content ?? '',
        kind: input.kind ?? 'note',
        ...(input.size !== undefined ? { size: input.size } : {}),
        sourceReference: input.sourceReference ?? null,
      });
      if (!result.ok) return result;

      commit(
        result.value.doc,
        {
          kind: 'insert',
          nodes: [result.value.node],
          edges: [result.value.edge],
          label: 'Create branch',
        },
        hint({ ids: [parentId], added: [result.value.node.id] }),
      );
      return { ok: true, value: { node: result.value.node } };
    },

    updateContent: (nodeId, content) => {
      const state = get();
      const before = getNode(state.doc, nodeId);
      if (!before) return { ok: false, code: 'NODE_NOT_FOUND', message: 'That note no longer exists.' };

      const result = updateNodeContent(state.doc, nodeId, content);
      if (!result.ok) return result;
      if (result.value.doc === state.doc) return { ok: true, value: { node: result.value.node } };

      const patch: Patch = {
        kind: 'update',
        nodeId,
        before: {
          content: before.content,
          contentVersion: before.contentVersion,
          updatedAt: before.updatedAt,
        },
        after: {
          content: result.value.node.content,
          contentVersion: result.value.node.contentVersion,
          updatedAt: result.value.node.updatedAt,
        },
        label: 'Edit note',
      };
      commit(result.value.doc, patch, hint({ ids: [nodeId] }));
      return { ok: true, value: { node: result.value.node } };
    },

    updateTitle: (nodeId, title) => {
      const state = get();
      const before = getNode(state.doc, nodeId);
      if (!before) return { ok: false, code: 'NODE_NOT_FOUND', message: 'That note no longer exists.' };

      const result = updateNodeTitle(state.doc, nodeId, title);
      if (!result.ok) return result;
      if (result.value.doc === state.doc) return { ok: true, value: { node: result.value.node } };

      const patch: Patch = {
        kind: 'update',
        nodeId,
        before: { title: before.title, updatedAt: before.updatedAt },
        after: { title: result.value.node.title, updatedAt: result.value.node.updatedAt },
        label: 'Rename note',
      };
      commit(result.value.doc, patch, hint({ ids: [nodeId] }));
      return { ok: true, value: { node: result.value.node } };
    },

    moveNodes: (positions) => {
      const state = get();
      const ids = Object.keys(positions);
      if (ids.length === 0) return { ok: true, value: null };

      const updates: NodeUpdate[] = [];
      for (const id of ids) {
        const before = getNode(state.doc, id);
        const after = positions[id];
        if (!before || !after) continue;
        if (before.position.x === after.x && before.position.y === after.y) continue;
        updates.push({
          nodeId: id,
          before: { position: { ...before.position }, updatedAt: before.updatedAt },
          after: { position: { x: after.x, y: after.y }, updatedAt: Date.now() },
        });
      }
      if (updates.length === 0) return { ok: true, value: null };

      const result = moveNodesOp(state.doc, positions);
      if (!result.ok) return result;

      commit(
        result.value,
        {
          kind: 'updateMany',
          updates,
          label: updates.length > 1 ? `Move ${updates.length} notes` : 'Move note',
        },
        hint({ ids: updates.map((update) => update.nodeId) }),
      );
      return { ok: true, value: null };
    },

    setCollapsed: (nodeId, collapsed) => {
      const state = get();
      const before = getNode(state.doc, nodeId);
      if (!before) return { ok: false, code: 'NODE_NOT_FOUND', message: 'That note no longer exists.' };

      const result = setNodeCollapsed(state.doc, nodeId, collapsed);
      if (!result.ok) return result;
      if (result.value.doc === state.doc) return { ok: true, value: { node: result.value.node } };

      const patch: Patch = {
        kind: 'update',
        nodeId,
        before: { collapsed: before.collapsed, updatedAt: before.updatedAt },
        after: { collapsed: result.value.node.collapsed, updatedAt: result.value.node.updatedAt },
        label: collapsed ? 'Collapse note' : 'Expand note',
      };
      commit(result.value.doc, patch, hint({ ids: [nodeId] }));
      return { ok: true, value: { node: result.value.node } };
    },

    resizeNode: (nodeId, size) => {
      const state = get();
      const before = getNode(state.doc, nodeId);
      if (!before) return { ok: false, code: 'NODE_NOT_FOUND', message: 'That window no longer exists.' };

      const result = resizeNodeOp(state.doc, nodeId, size);
      if (!result.ok) return result;
      if (result.value.doc === state.doc) return { ok: true, value: { node: result.value.node } };

      const patch: Patch = {
        kind: 'update',
        nodeId,
        before: { size: { ...before.size }, updatedAt: before.updatedAt },
        after: { size: { ...result.value.node.size }, updatedAt: result.value.node.updatedAt },
        label: 'Resize window',
      };
      commit(result.value.doc, patch, hint({ ids: [nodeId] }));
      return { ok: true, value: { node: result.value.node } };
    },

    setNodeKind: (nodeId, kind) => {
      const state = get();
      const before = getNode(state.doc, nodeId);
      if (!before) return { ok: false, code: 'NODE_NOT_FOUND', message: 'That window no longer exists.' };

      const result = setNodeKindOp(state.doc, nodeId, kind);
      if (!result.ok) return result;
      if (result.value.doc === state.doc) return { ok: true, value: { node: result.value.node } };

      const patch: Patch = {
        kind: 'update',
        nodeId,
        before: { kind: before.kind, size: { ...before.size }, updatedAt: before.updatedAt },
        after: {
          kind: result.value.node.kind,
          size: { ...result.value.node.size },
          updatedAt: result.value.node.updatedAt,
        },
        label: kind === 'ai' ? 'Switch to AI chat' : 'Switch to note',
      };
      commit(result.value.doc, patch, hint({ ids: [nodeId] }));
      return { ok: true, value: { node: result.value.node } };
    },

    appendChatMessage: (nodeId, message) => {
      const state = get();
      const result = appendChatMessageOp(state.doc, nodeId, message);
      if (!result.ok) return result;

      // Chat turns are not pushed onto the undo stack (see `appendChatMessage`).
      commit(result.value.doc, null, hint({ ids: [nodeId] }));
      return { ok: true, value: { node: result.value.node } };
    },

    deleteSubtree: (nodeId) => {
      const state = get();
      const result = deleteSubtree(state.doc, nodeId);
      if (!result.ok) return result;

      commit(
        result.value.doc,
        {
          kind: 'remove',
          nodes: result.value.removedNodes,
          edges: result.value.removedEdges,
          label:
            result.value.removedNodes.length > 1
              ? `Delete ${result.value.removedNodes.length} windows`
              : 'Delete note',
        },
        hint({
          removed: result.value.removedNodes.map((node) => node.id),
          ids: result.value.parentId ? [result.value.parentId] : [],
        }),
      );
      return {
        ok: true,
        value: { removedCount: result.value.removedNodes.length, parentId: result.value.parentId },
      };
    },

    resetCanvas: () => {
      const state = get();
      const result = resetCanvasOp(state.doc);
      commit(
        result.doc,
        {
          kind: 'structure',
          before: state.doc,
          after: result.doc,
          label: 'Reset canvas',
        },
        hint({ full: true, removed: result.removedNodes.map((node) => node.id) }),
      );
    },

    setDocumentTitle: (title) => {
      const state = get();
      const result = setDocumentTitle(state.doc, title);
      if (!result.ok) return result;
      if (result.value === state.doc) return { ok: true, value: null };
      commit(
        result.value,
        {
          kind: 'structure',
          before: state.doc,
          after: result.value,
          label: 'Rename canvas',
        },
        hint({}),
      );
      return { ok: true, value: null };
    },

    undo: () => {
      const state = get();
      const result = undo(state.doc, state.history);
      if (result.doc === state.doc) return null;
      set({
        doc: result.doc,
        revision: state.revision + 1,
        lastChange: hint({ full: true }),
        history: result.history,
        saveStatus: 'dirty',
      });
      return { focusNodeId: result.focusNodeId, label: result.label };
    },

    redo: () => {
      const state = get();
      const result = redo(state.doc, state.history);
      if (result.doc === state.doc) return null;
      set({
        doc: result.doc,
        revision: state.revision + 1,
        lastChange: hint({ full: true }),
        history: result.history,
        saveStatus: 'dirty',
      });
      return { focusNodeId: result.focusNodeId, label: result.label };
    },

    replaceDocument: (doc, options = {}) => {
      set((state) => ({
        doc,
        revision: state.revision + 1,
        lastChange: hint({ full: true, replaced: true }),
        history: options.resetHistory === false ? state.history : EMPTY_HISTORY,
      }));
    },

    setSaveStatus: (status, detail = {}) => {
      set((state) => ({
        saveStatus: status,
        lastSavedAt: detail.at !== undefined ? detail.at : state.lastSavedAt,
        saveError: detail.error !== undefined ? detail.error : status === 'error' ? state.saveError : null,
      }));
    },
  };
});

/** Selector helpers keep component subscriptions narrow. */
export const selectDocument = (state: GraphStoreState): GraphDocument => state.doc;
export const selectSaveStatus = (state: GraphStoreState): SaveStatus => state.saveStatus;
