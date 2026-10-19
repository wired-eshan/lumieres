/**
 * Hit testing against the spatial index.
 *
 * Windows may overlap (users are free to stack them), so a hit resolves to the
 * topmost candidate: the one painted last, which we define as the most recently
 * created node. Selection never silently jumps to a window hidden underneath.
 */

import { nodeRectAt } from './renderer';
import { compareRenderOrder } from '../graph/graphOperations';
import { rectsOverlap } from '../utils/geometry';
import type { SpatialGrid } from './spatialIndex';
import type { GraphDocument, NodeId, Point, Rect } from '../graph/types';

export interface Hit {
  nodeId: NodeId;
  rect: Rect;
}

function rectFor(doc: GraphDocument, id: NodeId, drafts: ReadonlyMap<NodeId, Point>): Rect | null {
  const node = doc.nodes[id];
  if (!node) return null;
  return nodeRectAt(drafts.get(id) ?? node.position, node.collapsed, node.size);
}

/** Topmost node under a world point, or null on empty canvas. */
export function hitTestNode(
  doc: GraphDocument,
  index: SpatialGrid,
  worldPoint: Point,
  drafts: ReadonlyMap<NodeId, Point> = new Map(),
): Hit | null {
  const candidates = index.queryPoint(worldPoint);
  const depthCache = new Map<NodeId, number>();
  let best: Hit | null = null;
  let bestNode = null as (typeof doc.nodes)[string] | null;

  for (const id of candidates) {
    const node = doc.nodes[id];
    if (!node) continue;
    const rect = rectFor(doc, id, drafts);
    if (!rect) continue;
    if (worldPoint.x < rect.x || worldPoint.x > rect.x + rect.width) continue;
    if (worldPoint.y < rect.y || worldPoint.y > rect.y + rect.height) continue;
    // Highest in paint order wins, so selection never jumps to a window that is
    // hidden underneath another.
    if (!bestNode || compareRenderOrder(doc, node, bestNode, depthCache) > 0) {
      best = { nodeId: id, rect };
      bestNode = node;
    }
  }
  return best;
}

/** Every node whose bounds intersect a world rect (marquee selection). */
export function nodesInRect(
  doc: GraphDocument,
  index: SpatialGrid,
  worldRect: Rect,
  drafts: ReadonlyMap<NodeId, Point> = new Map(),
): NodeId[] {
  const out: NodeId[] = [];
  for (const id of index.queryRect(worldRect)) {
    const rect = rectFor(doc, id, drafts);
    if (rect && rectsOverlap(worldRect, rect)) out.push(id);
  }
  return out;
}
