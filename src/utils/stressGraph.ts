/**
 * Synthetic graph generator for performance validation.
 *
 * Produces deterministic, structurally valid documents of an arbitrary size so
 * rendering, hit-testing and persistence can be measured against something
 * bigger than a hand-made example. Used by the test suite, and available in dev
 * builds from the browser console (`__lumieresStress(5000)`).
 */

import { createEmptyDocument, createNoteNode } from '../graph/graphOperations';
import { resolveChildPosition } from '../graph/layout';
import { nodeSize } from '../graph/metrics';
import { SpatialGrid } from '../canvas/spatialIndex';
import { createEdgeId } from './id';
import { SCHEMA_VERSION, type GraphDocument, type GraphEdge, type NodeId, type NoteNode } from '../graph/types';

export interface StressGraphOptions {
  totalNodes?: number;
  /** Children per node before the structure widens. Hard-capped at 50. */
  branching?: number;
  /** Seed text length per note, in characters. */
  contentLength?: number;
  title?: string;
}

const WORDS = [
  'signal',
  'pattern',
  'context',
  'branch',
  'structure',
  'question',
  'evidence',
  'synthesis',
  'hypothesis',
  'observation',
  'constraint',
  'analogy',
];

function sentence(seed: number, length: number): string {
  const parts: string[] = [];
  let size = 0;
  let index = seed;
  while (size < length) {
    const word = WORDS[index % WORDS.length] ?? 'note';
    parts.push(word);
    size += word.length + 1;
    index += 7;
  }
  return parts.join(' ').slice(0, Math.max(1, length));
}

/**
 * Builds a wide, shallow tree by default — the shape that stresses culling and
 * hit-testing hardest, because many windows are simultaneously on screen.
 *
 * Nodes are accumulated into plain maps and attached to the document once.
 * Routing 5,000 creations through `createBranch` would copy the node map on
 * every call (O(n²) overall, seconds of work) — the same reason the import path
 * builds its document in bulk. The result is still validated like any other
 * document, and the domain rules it relies on are covered by the operation
 * tests, so this shortcut changes *how fast* the graph is built, not what a
 * valid graph is.
 */
export function createStressGraph(options: StressGraphOptions = {}): GraphDocument {
  const totalNodes = Math.max(1, options.totalNodes ?? 5000);
  const branching = Math.min(50, Math.max(1, options.branching ?? 12));
  const contentLength = options.contentLength ?? 180;
  const now = Date.now();

  const base = createEmptyDocument(options.title ?? `Stress test · ${totalNodes} notes`, now);
  const nodes: Record<NodeId, NoteNode> = {};
  const edges: Record<string, GraphEdge> = {};
  const grid = new SpatialGrid(480);

  const root = createNoteNode({
    id: base.rootNodeId,
    parentId: null,
    title: 'Root note',
    content: sentence(0, contentLength),
    position: { x: 0, y: 0 },
    now,
  });
  nodes[root.id] = root;
  grid.insert(root.id, { ...root.position, ...nodeSize(root.collapsed, root.size) });

  // Breadth-first so every node fills its quota before the next level starts.
  const queue: NoteNode[] = [root];
  const childCounts = new Map<NodeId, number>();
  let created = 1;

  while (created < totalNodes && queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;

    for (let slot = 0; slot < branching && created < totalNodes; slot += 1) {
      const index = childCounts.get(parent.id) ?? 0;
      const position = resolveChildPosition(parent, index, (rect, ignore) =>
        grid.isOccupied(rect, ignore),
      );
      const node = createNoteNode({
        parentId: parent.id,
        title: `${WORDS[(created * 5) % WORDS.length] ?? 'note'} ${created}`,
        content: sentence(created, contentLength),
        position,
        now,
      });

      nodes[node.id] = node;
      const edge: GraphEdge = {
        id: createEdgeId(parent.id, node.id),
        sourceNodeId: parent.id,
        targetNodeId: node.id,
      };
      edges[edge.id] = edge;
      grid.insert(node.id, { ...position, ...nodeSize(node.collapsed, node.size) });

      childCounts.set(parent.id, index + 1);
      queue.push(node);
      created += 1;
    }
  }

  return { ...base, schemaVersion: SCHEMA_VERSION, nodes, edges, updatedAt: now };
}

/** Registers the dev-console helper. Never runs in production builds. */
export function registerStressGraphHelper(controller: {
  replaceDocument: (doc: GraphDocument) => void;
}): void {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>)['__lumieresStress'] = (count = 5000) => {
    const doc = createStressGraph({ totalNodes: count });
    controller.replaceDocument(doc);
    return `${Object.keys(doc.nodes).length} notes loaded`;
  };
}
