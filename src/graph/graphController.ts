/**
 * The single write path into the document.
 *
 * UI components and the canvas engine both talk to the graph through this
 * controller rather than to the store directly, which gives one place to hang
 * cross-cutting concerns (flushing uncommitted editor drafts before an undo,
 * flushing pending autosaves before the page closes).
 *
 * It deliberately holds no React state and no rendering knowledge, so it can be
 * driven from a pointer handler, a keyboard shortcut or a test with equal ease.
 */

import { useGraphStore, type ChangeHint, type GraphStoreState, type SaveStatus } from './graphStore';
import type {
  ChatMessage,
  GraphDocument,
  NodeId,
  OperationResult,
  Point,
  NoteNode,
  SourceReference,
  WindowKind,
  WindowSize,
} from './types';

export interface BranchRequest {
  position?: Point;
  title?: string;
  content?: string;
  kind?: WindowKind;
  size?: WindowSize;
  sourceReference?: SourceReference | null;
}

export interface GraphController {
  getDocument(): GraphDocument;
  getState(): GraphStoreState;
  subscribe(listener: (doc: GraphDocument, change: ChangeHint, revision: number) => void): () => void;
  subscribeSaveStatus(listener: (status: SaveStatus, error: string | null) => void): () => void;

  addBranch(parentId: NodeId, request?: BranchRequest): OperationResult<{ node: NoteNode }>;
  updateContent(nodeId: NodeId, content: string): OperationResult<{ node: NoteNode }>;
  updateTitle(nodeId: NodeId, title: string): OperationResult<{ node: NoteNode }>;
  moveNodes(positions: Record<NodeId, Point>): OperationResult<null>;
  resizeNode(nodeId: NodeId, size: WindowSize): OperationResult<{ node: NoteNode }>;
  setNodeKind(nodeId: NodeId, kind: WindowKind): OperationResult<{ node: NoteNode }>;
  appendChatMessage(nodeId: NodeId, message: ChatMessage): OperationResult<{ node: NoteNode }>;
  setCollapsed(nodeId: NodeId, collapsed: boolean): OperationResult<{ node: NoteNode }>;
  deleteSubtree(nodeId: NodeId): OperationResult<{ removedCount: number; parentId: NodeId | null }>;
  resetCanvas(): void;
  setDocumentTitle(title: string): OperationResult<null>;
  undo(): { focusNodeId: NodeId | null; label: string | null } | null;
  redo(): { focusNodeId: NodeId | null; label: string | null } | null;
  replaceDocument(doc: GraphDocument, options?: { resetHistory?: boolean }): void;

  /** Registers the canvas's draft-flushing callback (see `flushPendingDrafts`). */
  setDraftFlusher(flusher: (() => void) | null): void;
  /** Commits any text still sitting in an open editor into the document. */
  flushPendingDrafts(): void;
  /** Resolves once pending writes have been handed to storage. */
  flushPendingWrites(): Promise<void>;
  setWriteFlusher(flusher: (() => Promise<void>) | null): void;
  setSaveStatus(status: SaveStatus, detail?: { at?: number; error?: string | null }): void;
}

export function createGraphController(): GraphController {
  let draftFlusher: (() => void) | null = null;
  let writeFlusher: (() => Promise<void>) | null = null;

  return {
    getDocument: () => useGraphStore.getState().doc,
    getState: () => useGraphStore.getState(),

    subscribe: (listener) => {
      let lastRevision = useGraphStore.getState().revision;
      return useGraphStore.subscribe((state) => {
        if (state.revision === lastRevision) return;
        lastRevision = state.revision;
        listener(state.doc, state.lastChange, state.revision);
      });
    },

    subscribeSaveStatus: (listener) => {
      let last = useGraphStore.getState().saveStatus;
      let lastError = useGraphStore.getState().saveError;
      return useGraphStore.subscribe((state) => {
        if (state.saveStatus === last && state.saveError === lastError) return;
        last = state.saveStatus;
        lastError = state.saveError;
        listener(state.saveStatus, state.saveError);
      });
    },

    addBranch: (parentId, request = {}) => useGraphStore.getState().addBranch(parentId, request),
    updateContent: (nodeId, content) => {
      draftFlusher?.();
      return useGraphStore.getState().updateContent(nodeId, content);
    },
    updateTitle: (nodeId, title) => useGraphStore.getState().updateTitle(nodeId, title),
    moveNodes: (positions) => useGraphStore.getState().moveNodes(positions),
    resizeNode: (nodeId, size) => useGraphStore.getState().resizeNode(nodeId, size),
    setNodeKind: (nodeId, kind) => useGraphStore.getState().setNodeKind(nodeId, kind),
    appendChatMessage: (nodeId, message) => useGraphStore.getState().appendChatMessage(nodeId, message),
    setCollapsed: (nodeId, collapsed) => useGraphStore.getState().setCollapsed(nodeId, collapsed),
    deleteSubtree: (nodeId) => useGraphStore.getState().deleteSubtree(nodeId),
    resetCanvas: () => useGraphStore.getState().resetCanvas(),
    setDocumentTitle: (title) => useGraphStore.getState().setDocumentTitle(title),

    undo: () => {
      draftFlusher?.();
      return useGraphStore.getState().undo();
    },
    redo: () => {
      draftFlusher?.();
      return useGraphStore.getState().redo();
    },
    replaceDocument: (doc, options) => useGraphStore.getState().replaceDocument(doc, options),

    setDraftFlusher: (flusher) => {
      draftFlusher = flusher;
    },
    flushPendingDrafts: () => {
      draftFlusher?.();
    },
    setWriteFlusher: (flusher) => {
      writeFlusher = flusher;
    },
    flushPendingWrites: async () => {
      draftFlusher?.();
      if (writeFlusher) await writeFlusher();
    },
    setSaveStatus: (status, detail) => useGraphStore.getState().setSaveStatus(status, detail),
  };
}

/** Process-wide controller. One document per tab, so a singleton is honest here. */
export const graphController = createGraphController();
