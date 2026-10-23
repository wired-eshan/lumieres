/**
 * Core graph-document types.
 *
 * The document is a plain, serialisable, immutable-by-convention value. Every
 * mutation goes through `graphOperations.ts`, which returns a new document that
 * structurally shares everything it did not touch.
 *
 * Invariants (enforced by `graphValidation.ts`):
 *  - exactly one root node (`parentId === null`) reachable via `rootNodeId`
 *  - every non-root node has a `parentId` pointing at an existing node
 *  - the structure is a tree: no cycles, at most one parent per node
 *  - `edges` mirrors `parentId` exactly, with a deterministic edge id
 */

export type NodeId = string;
export type EdgeId = string;

/** Bumped whenever the on-disk shape changes; see `persistence/migrations.ts`. */
export const SCHEMA_VERSION = 2;

// Product limits live in `src/config.ts`; these re-exports keep the document
// types as the import path for code that treats the limits as schema rules.
export { MAX_CHILDREN_PER_NODE, MAX_NODE_CONTENT_LENGTH } from '../config';

/**
 * A window can show either a plain note or a chat with an LLM. Both modes share
 * one document record, one identity, one branch position in the tree and one
 * source reference; only the body region and its editing surface differ.
 */
export type WindowKind = 'note' | 'ai';

/** Window dimensions in world coordinates. */
export interface WindowSize {
  width: number;
  height: number;
}

/**
 * A persisted chat turn. Chat history lives in the graph document (so it is
 * saved, exported, restored and deleted with its window), while in-flight
 * request state lives in `ai/sessionStore.ts` and never touches storage per
 * token.
 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** True when the user stopped the response before it finished. */
  interrupted?: boolean;
}

export interface GraphDocument {
  schemaVersion: number;
  id: string;
  title: string;
  rootNodeId: NodeId;
  nodes: Record<NodeId, NoteNode>;
  edges: Record<EdgeId, GraphEdge>;
  createdAt: number;
  updatedAt: number;
}

export interface NoteNode {
  id: NodeId;
  parentId: NodeId | null;
  title: string;
  /** The note body. In AI mode this is preserved as editable context for the chat. */
  content: string;
  /** World coordinates of the window's top-left corner. Camera-independent. */
  position: { x: number; y: number };
  /** Persisted world-space window size. Collapsing does not destroy it. */
  size: WindowSize;
  /** Note or AI conversation. Toggling preserves both `content` and `chat`. */
  kind: WindowKind;
  /** Persisted AI conversation for this window, oldest first. */
  chat: ChatMessage[];
  sourceReference: SourceReference | null;
  collapsed: boolean;
  /**
   * Incremented on every content mutation. Cheap first-pass staleness check for
   * source references without comparing full strings.
   */
  contentVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface GraphEdge {
  id: EdgeId;
  sourceNodeId: NodeId;
  targetNodeId: NodeId;
}

/**
 * Structural record of where a branch came from. The text range is a *reference*,
 * never an auto-synchronised copy: if the source note changes we keep the
 * snapshot and report the reference as stale rather than rewriting it.
 */
export interface SourceReference {
  sourceNodeId: NodeId;
  selectedTextSnapshot: string;
  /**
   * Set when the selection was made inside an AI message rather than in the
   * window's note body. Offsets then index into that message's content, which
   * keeps staleness detection exact without copying the message.
   */
  sourceMessageId?: string;
  /** UTF-16 offset into the source text at branch time. */
  startOffset: number;
  /** Exclusive UTF-16 end offset. */
  endOffset: number;
  sourceContentVersion: number;
}

export type SourceReferenceStatus =
  | 'none'
  /** Source node is gone (should not happen in a tree, but imports can be malformed). */
  | 'missing-source'
  /** Snapshot still matches the source text at the recorded offsets. */
  | 'valid'
  /** The source text changed under the reference. Snapshot is preserved. */
  | 'stale';

export interface SourceReferenceEvaluation {
  status: SourceReferenceStatus;
  reference: SourceReference | null;
  /** Current text at the referenced range, or null when unavailable. */
  currentText: string | null;
}

/** Error codes returned by graph operations. Stable strings, safe to switch on. */
export type GraphErrorCode =
  | 'NODE_NOT_FOUND'
  | 'PARENT_NOT_FOUND'
  | 'BRANCH_LIMIT_REACHED'
  | 'CONTENT_LIMIT_EXCEEDED'
  | 'INVALID_SELECTION'
  | 'ROOT_DELETE_NOT_ALLOWED'
  | 'INVALID_POSITION'
  | 'INVALID_SIZE'
  | 'EMPTY_TITLE';

export type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: GraphErrorCode; message: string };

export function ok<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

export function err<T = never>(code: GraphErrorCode, message: string): OperationResult<T> {
  return { ok: false, code, message };
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
