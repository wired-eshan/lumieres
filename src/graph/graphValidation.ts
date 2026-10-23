/**
 * Document validation and normalisation.
 *
 * Used by the persistence layer on load/import, and by the test suite as an
 * integrity assertion after arbitrary operation sequences.
 */

import {
  MAX_CHILDREN_PER_NODE,
  MAX_NODE_CONTENT_LENGTH,
  MAX_NODE_HEIGHT,
  MAX_NODE_WIDTH,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
} from '../config';
import { createEdgeId } from '../utils/id';
import { clampNodeSize, defaultNodeSize } from './metrics';
import { SCHEMA_VERSION } from './types';
import type { ChatMessage, GraphDocument, NodeId, NoteNode } from './types';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code:
    | 'MISSING_ROOT'
    | 'ORPHAN_NODE'
    | 'CYCLE'
    | 'PARENT_MISSING'
    | 'EDGE_MISMATCH'
    | 'CHILD_LIMIT_EXCEEDED'
    | 'CONTENT_LIMIT_EXCEEDED'
    | 'INVALID_POSITION'
    | 'INVALID_SIZE'
    | 'DUPLICATE_ROOT';
  message: string;
  nodeId?: NodeId;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  maxChildren: number;
  overLimitNodeIds: NodeId[];
  totalCharacters: number;
}

export function validateGraph(doc: GraphDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = Object.values(doc.nodes);

  const root = doc.nodes[doc.rootNodeId];
  if (!root) {
    issues.push({
      severity: 'error',
      code: 'MISSING_ROOT',
      message: `Root node ${doc.rootNodeId} is missing from the document.`,
    });
  } else if (root.parentId !== null) {
    issues.push({
      severity: 'error',
      code: 'DUPLICATE_ROOT',
      message: 'The root node has a parent, so the graph is not a single-rooted tree.',
      nodeId: root.id,
    });
  }

  const childCounts = new Map<NodeId, number>();

  for (const node of nodes) {
    if (node.parentId !== null && !doc.nodes[node.parentId]) {
      issues.push({
        severity: 'error',
        code: 'PARENT_MISSING',
        message: `Node "${label(node)}" references a parent that does not exist.`,
        nodeId: node.id,
      });
    }
    childCounts.set(node.parentId ?? '__root__', (childCounts.get(node.parentId ?? '__root__') ?? 0) + 1);

    if (node.content.length > MAX_NODE_CONTENT_LENGTH) {
      issues.push({
        severity: 'warning',
        code: 'CONTENT_LIMIT_EXCEEDED',
        message: `"${label(node)}" holds ${node.content.length.toLocaleString('en-US')} characters, above the ${MAX_NODE_CONTENT_LENGTH.toLocaleString('en-US')} limit. It is kept intact and cannot grow further until trimmed.`,
        nodeId: node.id,
      });
    }
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      issues.push({
        severity: 'error',
        code: 'INVALID_POSITION',
        message: `Node "${label(node)}" has a non-finite position.`,
        nodeId: node.id,
      });
    }
    const size = node.size;
    if (
      !size ||
      !Number.isFinite(size.width) ||
      !Number.isFinite(size.height) ||
      size.width < MIN_NODE_WIDTH ||
      size.width > MAX_NODE_WIDTH ||
      size.height < MIN_NODE_HEIGHT ||
      size.height > MAX_NODE_HEIGHT
    ) {
      issues.push({
        severity: 'error',
        code: 'INVALID_SIZE',
        message: `Node "${label(node)}" has an unsupported window size.`,
        nodeId: node.id,
      });
    }
  }

  for (const node of nodes) {
    const count = childCounts.get(node.id) ?? 0;
    if (count > MAX_CHILDREN_PER_NODE) {
      issues.push({
        severity: 'warning',
        code: 'CHILD_LIMIT_EXCEEDED',
        message: `"${label(node)}" has ${count} children, above the limit of ${MAX_CHILDREN_PER_NODE}.`,
        nodeId: node.id,
      });
    }
  }

  // Every non-root node must be reachable from the root; anything else is an
  // orphan (or points into a cycle).
  const reachable = new Set<NodeId>();
  const stack: NodeId[] = root ? [root.id] : [];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    for (const node of nodes) {
      if (node.parentId === id) stack.push(node.id);
    }
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) {
      issues.push({
        severity: 'error',
        code: reachable.size === 0 ? 'MISSING_ROOT' : 'CYCLE',
        message: `Node "${label(node)}" is not reachable from the root (cycle or orphan).`,
        nodeId: node.id,
      });
    }
  }

  // Edges mirror parentId exactly.
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const expectedId = createEdgeId(node.parentId, node.id);
    if (!doc.edges[expectedId]) {
      issues.push({
        severity: 'error',
        code: 'EDGE_MISMATCH',
        message: `Edge for ${node.parentId} → ${node.id} is missing.`,
        nodeId: node.id,
      });
    }
  }
  for (const edge of Object.values(doc.edges)) {
    const target = doc.nodes[edge.targetNodeId];
    if (!target || target.parentId !== edge.sourceNodeId) {
      issues.push({
        severity: 'error',
        code: 'EDGE_MISMATCH',
        message: `Edge ${edge.id} does not match any parent/child relationship.`,
        nodeId: edge.targetNodeId,
      });
    }
  }

  return issues;
}

export function isValidGraph(doc: GraphDocument): boolean {
  return !validateGraph(doc).some((issue) => issue.severity === 'error');
}

export function computeStats(doc: GraphDocument): GraphStats {
  const nodes = Object.values(doc.nodes);
  const childCounts = new Map<NodeId, number>();
  for (const node of nodes) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  }

  let maxDepth = 0;
  const depthCache = new Map<NodeId, number>();
  const depthOf = (node: NoteNode, guard: Set<NodeId>): number => {
    if (node.parentId === null) return 0;
    const cached = depthCache.get(node.id);
    if (cached !== undefined) return cached;
    if (guard.has(node.id)) return 0; // cycle guard; validation reports this separately
    guard.add(node.id);
    const parent = doc.nodes[node.parentId];
    const depth = parent ? depthOf(parent, guard) + 1 : 0;
    depthCache.set(node.id, depth);
    return depth;
  };
  for (const node of nodes) maxDepth = Math.max(maxDepth, depthOf(node, new Set()));

  let totalCharacters = 0;
  const overLimitNodeIds: NodeId[] = [];
  for (const node of nodes) {
    totalCharacters += node.content.length;
    for (const message of node.chat) totalCharacters += message.content.length;
    if (node.content.length > MAX_NODE_CONTENT_LENGTH) overLimitNodeIds.push(node.id);
  }

  return {
    nodeCount: nodes.length,
    edgeCount: Object.keys(doc.edges).length,
    maxDepth,
    maxChildren: childCounts.size === 0 ? 0 : Math.max(...childCounts.values()),
    overLimitNodeIds,
    totalCharacters,
  };
}

function label(node: NoteNode): string {
  return node.title.trim() || node.content.trim().slice(0, 24) || node.id;
}

/**
 * Repairs recoverable problems without inventing or discarding user content:
 *  - drops edges that do not correspond to a parentId relation
 *  - re-parents unreachable nodes onto the root so nothing is lost
 *  - clamps non-finite positions to the origin
 * Content is never truncated here — over-limit notes are reported instead.
 */
export function normalizeDocument(doc: GraphDocument): { doc: GraphDocument; issues: ValidationIssue[] } {
  const issues = validateGraph(doc);
  const hasErrors = issues.some((issue) => issue.severity === 'error');
  if (!hasErrors) return { doc, issues };

  const nodes: Record<NodeId, NoteNode> = {};
  for (const [id, node] of Object.entries(doc.nodes)) {
    const kind = node.kind === 'ai' ? 'ai' : 'note';
    nodes[id] = {
      ...node,
      position: {
        x: Number.isFinite(node.position.x) ? node.position.x : 0,
        y: Number.isFinite(node.position.y) ? node.position.y : 0,
      },
      size: clampNodeSize(node.size ?? defaultNodeSize(kind)),
      kind,
      chat: sanitizeChat(node.chat),
      content: typeof node.content === 'string' ? node.content : '',
      title: typeof node.title === 'string' ? node.title : '',
      collapsed: Boolean(node.collapsed),
      contentVersion: Number.isFinite(node.contentVersion) ? node.contentVersion : 1,
    };
  }

  const root = nodes[doc.rootNodeId];
  if (!root) {
    // Unrecoverable root loss: promote the oldest parentless node, else bail out.
    const candidates = Object.values(nodes)
      .filter((node) => node.parentId === null)
      .sort((a, b) => a.createdAt - b.createdAt);
    const promoted = candidates[0];
    if (!promoted) {
      return { doc, issues };
    }
    promoted.parentId = null;
  } else if (root.parentId !== null) {
    nodes[root.id] = { ...root, parentId: null };
  }

  const rootId = doc.nodes[doc.rootNodeId] ? doc.rootNodeId : (Object.values(nodes).find((n) => n.parentId === null)?.id ?? doc.rootNodeId);

  // Re-parent unreachable nodes so their content survives the repair.
  const reachable = new Set<NodeId>();
  const stack: NodeId[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    for (const node of Object.values(nodes)) {
      if (node.parentId === id) stack.push(node.id);
    }
  }
  for (const node of Object.values(nodes)) {
    if (!reachable.has(node.id)) {
      nodes[node.id] = { ...node, parentId: rootId };
    }
  }

  const edges: GraphDocument['edges'] = {};
  for (const node of Object.values(nodes)) {
    if (node.parentId === null) continue;
    const id = createEdgeId(node.parentId, node.id);
    edges[id] = { id, sourceNodeId: node.parentId, targetNodeId: node.id };
  }

  return { doc: { ...doc, schemaVersion: SCHEMA_VERSION, nodes, edges, rootNodeId: rootId }, issues };
}

/** Keeps only well-formed chat turns; malformed entries are dropped, not rendered. */
function sanitizeChat(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Partial<ChatMessage>;
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) continue;
    if (typeof candidate.content !== 'string') continue;
    if (candidate.role !== 'user' && candidate.role !== 'assistant') continue;
    out.push({
      id: candidate.id,
      role: candidate.role,
      content: candidate.content,
      createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : 0,
      ...(candidate.interrupted ? { interrupted: true } : {}),
    });
  }
  return out;
}
