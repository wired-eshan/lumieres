/**
 * Centralised, pure graph operations.
 *
 * Every mutation of a `GraphDocument` in the application goes through one of
 * these functions. They never mutate their input, always validate against the
 * domain rules (child limit, character limit, tree integrity) and return an
 * `OperationResult` so callers cannot forget to handle failure.
 */

import { MAX_CHILDREN_PER_NODE, MAX_NODE_CONTENT_LENGTH } from '../config';
import { createDocumentId, createEdgeId, createNodeId } from '../utils/id';
import { clampNodeSize, defaultNodeSize, nodeSize } from './metrics';
import {
  SCHEMA_VERSION,
  err,
  ok,
  type ChatMessage,
  type GraphDocument,
  type GraphEdge,
  type NodeId,
  type NoteNode,
  type OperationResult,
  type Point,
  type Rect,
  type SourceReference,
  type SourceReferenceEvaluation,
  type WindowKind,
  type WindowSize,
} from './types';

const ROOT_POSITION: Point = { x: 0, y: 0 };

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

export function createNoteNode(input: {
  id?: NodeId;
  parentId: NodeId | null;
  title?: string;
  content?: string;
  position: Point;
  kind?: WindowKind;
  size?: WindowSize;
  chat?: ChatMessage[];
  sourceReference?: SourceReference | null;
  now?: number;
}): NoteNode {
  const now = input.now ?? Date.now();
  const kind = input.kind ?? 'note';
  return {
    id: input.id ?? createNodeId(),
    parentId: input.parentId,
    title: input.title ?? '',
    content: input.content ?? '',
    position: { x: input.position.x, y: input.position.y },
    size: clampNodeSize(input.size ?? defaultNodeSize(kind)),
    kind,
    chat: input.chat ? input.chat.slice() : [],
    sourceReference: input.sourceReference ?? null,
    collapsed: false,
    contentVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/** A fresh canvas: exactly one root window, per the product definition. */
export function createEmptyDocument(title = 'Untitled canvas', now = Date.now()): GraphDocument {
  const root = createNoteNode({
    parentId: null,
    title: 'Root note',
    position: ROOT_POSITION,
    now,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    id: createDocumentId(),
    title,
    rootNodeId: root.id,
    nodes: { [root.id]: root },
    edges: {},
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function getNode(doc: GraphDocument, id: NodeId): NoteNode | undefined {
  return Object.prototype.hasOwnProperty.call(doc.nodes, id) ? doc.nodes[id] : undefined;
}

/** Children in a stable visual order (top-to-bottom, then creation order). */
export function getChildren(doc: GraphDocument, id: NodeId): NoteNode[] {
  const out: NoteNode[] = [];
  for (const node of Object.values(doc.nodes)) {
    if (node.parentId === id) out.push(node);
  }
  out.sort((a, b) => a.position.y - b.position.y || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * Direct-child counts per document, built once. The renderer asks for this on
 * every visible window on every frame; scanning `doc.nodes` each time made a
 * full-text frame O(visible × N) — roughly a second at 1,000 windows in a
 * 5,000-node graph. Documents are immutable (each operation returns a new one),
 * so an index keyed by document identity can never be stale.
 */
const childCountsByDocument = new WeakMap<GraphDocument, Map<NodeId, number>>();

export function getChildCount(doc: GraphDocument, id: NodeId): number {
  let counts = childCountsByDocument.get(doc);
  if (!counts) {
    counts = new Map();
    for (const node of Object.values(doc.nodes)) {
      if (node.parentId === null) continue;
      counts.set(node.parentId, (counts.get(node.parentId) ?? 0) + 1);
    }
    childCountsByDocument.set(doc, counts);
  }
  return counts.get(id) ?? 0;
}

/** Depth-first descendant ids, excluding `id` itself. */
export function getDescendantIds(doc: GraphDocument, id: NodeId): NodeId[] {
  const childrenOf = new Map<NodeId, NodeId[]>();
  for (const node of Object.values(doc.nodes)) {
    if (node.parentId === null) continue;
    const list = childrenOf.get(node.parentId);
    if (list) list.push(node.id);
    else childrenOf.set(node.parentId, [node.id]);
  }
  const out: NodeId[] = [];
  const stack: NodeId[] = [id];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const children = childrenOf.get(current);
    if (!children) continue;
    for (const child of children) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/** Ancestors from nearest parent up to the root. */
export function getAncestorIds(doc: GraphDocument, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<NodeId>([id]);
  let current = getNode(doc, id)?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = getNode(doc, current)?.parentId ?? null;
  }
  return out;
}

/**
 * Distance from the root; the root is 0. Memoised through `cache` so callers
 * that need depths for many nodes (the renderer, hit testing) pay for each node
 * once rather than walking every ancestor chain repeatedly.
 *
 * Cycle-safe: a malformed document cannot make this loop forever.
 */
export function getDepth(
  doc: GraphDocument,
  id: NodeId,
  cache?: Map<NodeId, number>,
): number {
  const cached = cache?.get(id);
  if (cached !== undefined) return cached;

  let depth = 0;
  const seen = new Set<NodeId>([id]);
  let current = getNode(doc, id)?.parentId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    depth += 1;
    current = getNode(doc, current)?.parentId ?? null;
  }
  cache?.set(id, depth);
  return depth;
}

/**
 * Paint order — and therefore hit-test priority, since the topmost window is
 * the last one painted.
 *
 * Depth leads: a branch always draws above the note it came from. Creation time
 * breaks ties between siblings, and the id breaks the remaining ties. Relying on
 * `createdAt` alone was wrong: two windows created in the same millisecond had
 * no defined order, which made overlapping hit tests depend on id ordering.
 */
export function compareRenderOrder(
  doc: GraphDocument,
  a: NoteNode,
  b: NoteNode,
  depthCache?: Map<NodeId, number>,
): number {
  const depthA = getDepth(doc, a.id, depthCache);
  const depthB = getDepth(doc, b.id, depthCache);
  if (depthA !== depthB) return depthA - depthB;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function getNodeRect(node: NoteNode): Rect {
  const size = nodeSize(node.collapsed, node.size);
  return { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
}

export function getSubtreeCharCount(doc: GraphDocument, id: NodeId): number {
  const node = getNode(doc, id);
  let total = node ? node.content.length + node.title.length + chatCharacters(node) : 0;
  for (const descendantId of getDescendantIds(doc, id)) {
    const descendant = getNode(doc, descendantId);
    if (descendant) {
      total += descendant.content.length + descendant.title.length + chatCharacters(descendant);
    }
  }
  return total;
}

/** Chat text is part of what a deletion removes, so previews count it too. */
function chatCharacters(node: NoteNode): number {
  let total = 0;
  for (const message of node.chat) total += message.content.length;
  return total;
}

export function isOverContentLimit(content: string): boolean {
  return content.length > MAX_NODE_CONTENT_LENGTH;
}

/* ------------------------------------------------------------------ */
/* Source references                                                   */
/* ------------------------------------------------------------------ */

/**
 * Two-stage staleness check: the version counter catches "something changed"
 * cheaply, the slice comparison distinguishes "changed but the referenced range
 * still reads exactly the same" from a genuine divergence.
 */
export function evaluateSourceReference(
  doc: GraphDocument,
  node: NoteNode,
): SourceReferenceEvaluation {
  const reference = node.sourceReference;
  if (!reference) return { status: 'none', reference: null, currentText: null };

  const source = getNode(doc, reference.sourceNodeId);
  if (!source) return { status: 'missing-source', reference, currentText: null };

  // A branch can come from a note body or from one AI message. The reference
  // names which, so offsets always index the same text they were captured from.
  if (reference.sourceMessageId) {
    const message = source.chat.find((candidate) => candidate.id === reference.sourceMessageId);
    if (!message) return { status: 'stale', reference, currentText: null };
    const currentText = message.content.slice(reference.startOffset, reference.endOffset);
    return currentText === reference.selectedTextSnapshot
      ? { status: 'valid', reference, currentText }
      : { status: 'stale', reference, currentText };
  }

  const currentText = source.content.slice(reference.startOffset, reference.endOffset);
  if (currentText === reference.selectedTextSnapshot) {
    return { status: 'valid', reference, currentText };
  }
  return { status: 'stale', reference, currentText };
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

function touch(doc: GraphDocument, nodes: Record<NodeId, NoteNode>, now: number): GraphDocument {
  return { ...doc, nodes, updatedAt: now };
}

function withNode(doc: GraphDocument, node: NoteNode, now: number): GraphDocument {
  return touch(doc, { ...doc.nodes, [node.id]: node }, now);
}

export function setDocumentTitle(
  doc: GraphDocument,
  title: string,
  now = Date.now(),
): OperationResult<GraphDocument> {
  const trimmed = title.trim();
  if (trimmed.length === 0) return err('EMPTY_TITLE', 'A canvas needs a title.');
  return ok({ ...doc, title: trimmed, updatedAt: now });
}

export interface CreateBranchInput {
  parentId: NodeId;
  /** Position in world coordinates; defaults are resolved by the caller (layout module). */
  position: Point;
  title?: string;
  content?: string;
  kind?: WindowKind;
  size?: WindowSize;
  sourceReference?: SourceReference | null;
  id?: NodeId;
  now?: number;
}

export interface CreateBranchValue {
  doc: GraphDocument;
  node: NoteNode;
  edge: GraphEdge;
}

/**
 * Creates a child window plus the edge that connects it to its parent.
 * Enforces the per-node child limit in domain logic, not in the UI.
 */
export function createBranch(
  doc: GraphDocument,
  input: CreateBranchInput,
): OperationResult<CreateBranchValue> {
  const parent = getNode(doc, input.parentId);
  if (!parent) return err('PARENT_NOT_FOUND', 'The source window no longer exists on this canvas.');
  if (!Number.isFinite(input.position.x) || !Number.isFinite(input.position.y)) {
    return err('INVALID_POSITION', 'Branch position must be finite world coordinates.');
  }

  const childCount = getChildCount(doc, input.parentId);
  if (childCount >= MAX_CHILDREN_PER_NODE) {
    return err(
      'BRANCH_LIMIT_REACHED',
      `This window already has ${MAX_CHILDREN_PER_NODE} branches, the maximum per window.`,
    );
  }

  const now = input.now ?? Date.now();
  const node = createNoteNode({
    ...(input.id !== undefined ? { id: input.id } : {}),
    parentId: input.parentId,
    title: input.title ?? '',
    content: input.content ?? '',
    position: input.position,
    kind: input.kind ?? 'note',
    ...(input.size !== undefined ? { size: input.size } : {}),
    sourceReference: input.sourceReference ?? null,
    now,
  });
  const edge: GraphEdge = {
    id: createEdgeId(input.parentId, node.id),
    sourceNodeId: input.parentId,
    targetNodeId: node.id,
  };

  return ok({
    doc: {
      ...doc,
      nodes: { ...doc.nodes, [node.id]: node },
      edges: { ...doc.edges, [edge.id]: edge },
      updatedAt: now,
    },
    node,
    edge,
  });
}

export function updateNodeContent(
  doc: GraphDocument,
  id: NodeId,
  content: string,
  now = Date.now(),
): OperationResult<{ doc: GraphDocument; node: NoteNode }> {
  const node = getNode(doc, id);
  if (!node) return err('NODE_NOT_FOUND', 'That note no longer exists.');
  if (content.length > MAX_NODE_CONTENT_LENGTH) {
    return err(
      'CONTENT_LIMIT_EXCEEDED',
      `A note can hold at most ${MAX_NODE_CONTENT_LENGTH.toLocaleString('en-US')} characters.`,
    );
  }
  if (content === node.content) return ok({ doc, node });

  const next: NoteNode = {
    ...node,
    content,
    contentVersion: node.contentVersion + 1,
    updatedAt: now,
  };
  return ok({ doc: withNode(doc, next, now), node: next });
}

export function updateNodeTitle(
  doc: GraphDocument,
  id: NodeId,
  title: string,
  now = Date.now(),
): OperationResult<{ doc: GraphDocument; node: NoteNode }> {
  const node = getNode(doc, id);
  if (!node) return err('NODE_NOT_FOUND', 'That note no longer exists.');
  if (title === node.title) return ok({ doc, node });
  const next: NoteNode = { ...node, title, updatedAt: now };
  return ok({ doc: withNode(doc, next, now), node: next });
}

export function moveNode(
  doc: GraphDocument,
  id: NodeId,
  position: Point,
  now = Date.now(),
): OperationResult<{ doc: GraphDocument; node: NoteNode }> {
  const node = getNode(doc, id);
  if (!node) return err('NODE_NOT_FOUND', 'That note no longer exists.');
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return err('INVALID_POSITION', 'Position must be finite world coordinates.');
  }
  if (node.position.x === position.x && node.position.y === position.y) {
    return ok({ doc, node });
  }
  const next: NoteNode = { ...node, position: { x: position.x, y: position.y }, updatedAt: now };
  return ok({ doc: withNode(doc, next, now), node: next });
}

/** Moves several nodes in one document update (multi-select drag). */
export function moveNodes(
  doc: GraphDocument,
  positions: Record<NodeId, Point>,
  now = Date.now(),
): OperationResult<GraphDocument> {
  const ids = Object.keys(positions);
  if (ids.length === 0) return ok(doc);
  const nodes = { ...doc.nodes };
  let changed = false;
  for (const id of ids) {
    const node = nodes[id];
    const position = positions[id];
    if (!node || !position) continue;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
      return err('INVALID_POSITION', 'Position must be finite world coordinates.');
    }
    if (node.position.x === position.x && node.position.y === position.y) continue;
    nodes[id] = { ...node, position: { x: position.x, y: position.y }, updatedAt: now };
    changed = true;
  }
  if (!changed) return ok(doc);
  return ok(touch(doc, nodes, now));
}

export function setNodeCollapsed(
  doc: GraphDocument,
  id: NodeId,
  collapsed: boolean,
  now = Date.now(),
): OperationResult<{ doc: GraphDocument; node: NoteNode }> {
  const node = getNode(doc, id);
  if (!node) return err('NODE_NOT_FOUND', 'That note no longer exists.');
  if (node.collapsed === collapsed) return ok({ doc, node });
  const next: NoteNode = { ...node, collapsed, updatedAt: now };
  return ok({ doc: withNode(doc, next, now), node: next });
}

/**
 * Switches a window between note and AI conversation.
 *
 * Content is never discarded: the note body remains the AI window's editable
 * context (visible if the user switches back), and the conversation remains if
 * they toggle back to a note. A window still at the default note size grows to
 * the default chat size so the conversation is usable immediately; a size the
 * user chose is left alone.
 */
export function setNodeKind(
  doc: GraphDocument,
  id: NodeId,
  kind: WindowKind,
  now = Date.now(),
): OperationResult<{ doc: GraphDocument; node: NoteNode }> {
  const node = getNode(doc, id);
  if (!node) return err('NODE_NOT_FOUND', 'That window no longer exists.');
  if (node.kind === kind) return ok({ doc, node });

  const noteDefault = defaultNodeSize('note');
  const atNoteDefault = node.size.width === noteDefault.width && node.size.height === noteDefault.height;
  const size = kind === 'ai' && atNoteDefault ? defaultNodeSize('ai') : node.size;
  const next: NoteNode = { ...node, kind, size, updatedAt: now };
  return ok({ doc: withNode(doc, next, now), node: next });
}

export function resizeNode(
  doc: GraphDocument,
  id: NodeId,
  size: WindowSize,
  now = Date.now(),
): OperationResult<{ doc: GraphDocument; node: NoteNode }> {
  const node = getNode(doc, id);
  if (!node) return err('NODE_NOT_FOUND', 'That window no longer exists.');
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
    return err('INVALID_SIZE', 'Window size must be finite world units.');
  }
  const clamped = clampNodeSize(size);
  if (node.size.width === clamped.width && node.size.height === clamped.height) {
    return ok({ doc, node });
  }
  const next: NoteNode = { ...node, size: clamped, updatedAt: now };
  return ok({ doc: withNode(doc, next, now), node: next });
}

/**
 * Appends one chat turn. Chat history is part of the document (and therefore
 * saved, exported and deleted with the window) but is deliberately outside the
 * undo stack: a conversation is not a text edit, and replaying one exchange
 * through undo would be surprising.
 */
export function appendChatMessage(
  doc: GraphDocument,
  id: NodeId,
  message: ChatMessage,
  now = Date.now(),
): OperationResult<{ doc: GraphDocument; node: NoteNode }> {
  const node = getNode(doc, id);
  if (!node) return err('NODE_NOT_FOUND', 'That window no longer exists.');
  if (message.content.length === 0) {
    return err('INVALID_SELECTION', 'A chat message cannot be empty.');
  }
  if (message.role === 'user' && message.content.length > MAX_NODE_CONTENT_LENGTH) {
    return err(
      'CONTENT_LIMIT_EXCEEDED',
      `A user chat message can hold at most ${MAX_NODE_CONTENT_LENGTH.toLocaleString('en-US')} characters.`,
    );
  }
  if (node.chat.some((existing) => existing.id === message.id)) {
    return err('INVALID_SELECTION', 'That chat message already exists.');
  }
  const next: NoteNode = { ...node, chat: [...node.chat, message], updatedAt: now };
  return ok({ doc: withNode(doc, next, now), node: next });
}

/**
 * Re-attaches a node to a new parent. Present so the tree can be edited without
 * hand-writing document shapes, even though the current UI only creates branches.
 */
export function reparentNode(
  doc: GraphDocument,
  id: NodeId,
  newParentId: NodeId,
  now = Date.now(),
): OperationResult<GraphDocument> {
  const node = getNode(doc, id);
  const parent = getNode(doc, newParentId);
  if (!node) return err('NODE_NOT_FOUND', 'That note no longer exists.');
  if (!parent) return err('PARENT_NOT_FOUND', 'The target note no longer exists.');
  if (id === newParentId) return err('INVALID_SELECTION', 'A note cannot be its own parent.');
  if (getAncestorIds(doc, newParentId).includes(id)) {
    return err('INVALID_SELECTION', 'That move would create a cycle.');
  }
  if (getChildCount(doc, newParentId) >= MAX_CHILDREN_PER_NODE) {
    return err('BRANCH_LIMIT_REACHED', 'The target note is at its branch limit.');
  }
  const oldEdgeId = node.parentId ? createEdgeId(node.parentId, id) : null;
  const edges = { ...doc.edges };
  if (oldEdgeId) delete edges[oldEdgeId];
  const edge: GraphEdge = {
    id: createEdgeId(newParentId, id),
    sourceNodeId: newParentId,
    targetNodeId: id,
  };
  edges[edge.id] = edge;
  const nodes = { ...doc.nodes, [id]: { ...node, parentId: newParentId, updatedAt: now } };
  return ok({ ...doc, nodes, edges, updatedAt: now });
}

export interface DeletionPreview {
  nodeId: NodeId;
  /** Every node that will be removed, including the target itself. */
  nodeIds: NodeId[];
  /** Non-root nodes in the subtree (what the user thinks of as "notes"). */
  descendantCount: number;
  characterCount: number;
  parentId: NodeId | null;
  isRoot: boolean;
}

/**
 * Describes exactly what a delete would remove, so the UI can ask for
 * confirmation with real numbers instead of a generic warning.
 */
export function previewDeletion(doc: GraphDocument, id: NodeId): DeletionPreview | null {
  const node = getNode(doc, id);
  if (!node) return null;
  const descendants = getDescendantIds(doc, id);
  return {
    nodeId: id,
    nodeIds: [id, ...descendants],
    descendantCount: descendants.length,
    characterCount: getSubtreeCharCount(doc, id),
    parentId: node.parentId,
    isRoot: id === doc.rootNodeId,
  };
}

export interface DeleteSubtreeValue {
  doc: GraphDocument;
  removedNodes: NoteNode[];
  removedEdges: GraphEdge[];
  parentId: NodeId | null;
}

/**
 * Deletes a node and its entire descendant subtree. The root cannot be removed
 * this way — the canvas must always keep exactly one root (use `resetCanvas`).
 */
export function deleteSubtree(
  doc: GraphDocument,
  id: NodeId,
  now = Date.now(),
): OperationResult<DeleteSubtreeValue> {
  const node = getNode(doc, id);
  if (!node) return err('NODE_NOT_FOUND', 'That note no longer exists.');
  if (id === doc.rootNodeId) {
    return err('ROOT_DELETE_NOT_ALLOWED', 'The root window cannot be deleted. Reset the canvas instead.');
  }

  const removedIds = new Set<NodeId>([id, ...getDescendantIds(doc, id)]);
  const nodes: Record<NodeId, NoteNode> = {};
  const removedNodes: NoteNode[] = [];
  for (const [nodeId, value] of Object.entries(doc.nodes)) {
    if (removedIds.has(nodeId)) removedNodes.push(value);
    else nodes[nodeId] = value;
  }

  const edges: Record<string, GraphEdge> = {};
  const removedEdges: GraphEdge[] = [];
  for (const [edgeId, edge] of Object.entries(doc.edges)) {
    if (removedIds.has(edge.sourceNodeId) || removedIds.has(edge.targetNodeId)) {
      removedEdges.push(edge);
    } else {
      edges[edgeId] = edge;
    }
  }

  return ok({ doc: { ...doc, nodes, edges, updatedAt: now }, removedNodes, removedEdges, parentId: node.parentId });
}

export interface ResetCanvasValue {
  doc: GraphDocument;
  removedNodes: NoteNode[];
  removedEdges: GraphEdge[];
  root: NoteNode;
}

/** Removes every window and installs a fresh root, keeping the document identity. */
export function resetCanvas(doc: GraphDocument, now = Date.now()): ResetCanvasValue {
  const root = createNoteNode({
    parentId: null,
    title: 'Root note',
    position: ROOT_POSITION,
    now,
  });
  return {
    doc: {
      ...doc,
      rootNodeId: root.id,
      nodes: { [root.id]: root },
      edges: {},
      updatedAt: now,
    },
    removedNodes: Object.values(doc.nodes),
    removedEdges: Object.values(doc.edges),
    root,
  };
}

/* ------------------------------------------------------------------ */
/* Patch application (used by undo/redo)                               */
/* ------------------------------------------------------------------ */

export function insertNodes(
  doc: GraphDocument,
  nodes: NoteNode[],
  edges: GraphEdge[],
  now = Date.now(),
): GraphDocument {
  const nextNodes = { ...doc.nodes };
  for (const node of nodes) nextNodes[node.id] = node;
  const nextEdges = { ...doc.edges };
  for (const edge of edges) nextEdges[edge.id] = edge;
  return { ...doc, nodes: nextNodes, edges: nextEdges, updatedAt: now };
}

export function removeNodes(
  doc: GraphDocument,
  nodeIds: Iterable<NodeId>,
  now = Date.now(),
): GraphDocument {
  const kill = new Set(nodeIds);
  const nodes: Record<NodeId, NoteNode> = {};
  for (const [id, node] of Object.entries(doc.nodes)) {
    if (!kill.has(id)) nodes[id] = node;
  }
  const edges: Record<string, GraphEdge> = {};
  for (const [id, edge] of Object.entries(doc.edges)) {
    if (!kill.has(edge.sourceNodeId) && !kill.has(edge.targetNodeId)) edges[id] = edge;
  }
  return { ...doc, nodes, edges, updatedAt: now };
}

export const LIMITS = {
  maxChildrenPerNode: MAX_CHILDREN_PER_NODE,
  maxNodeContentLength: MAX_NODE_CONTENT_LENGTH,
} as const;
