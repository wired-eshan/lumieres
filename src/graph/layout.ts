/**
 * Deterministic initial placement for new branches.
 *
 * This is a *placement aid*, not a layout engine: it only ever runs when a node
 * is created. Existing windows are never moved by it, so manual arrangement is
 * always preserved.
 *
 * Strategy
 *  1. Canonical slot: children fan out to the right of the parent, alternating
 *     above/below the parent's centre line so the branch column stays balanced
 *     as it grows (`slotOffsetForIndex`).
 *  2. Collision probe: if the canonical slot lands on an occupied window, walk a
 *     fixed, deterministic candidate list (further right, then a vertical sweep)
 *     until a free spot is found.
 */

import { BRANCH_GAP_X, BRANCH_GAP_Y, nodeSize } from './metrics';
import type { NodeId, NoteNode, Point, Rect } from './types';

export interface OccupancyQuery {
  /** True when the given rect overlaps an existing window (ignoring `ignoreId`). */
  (rect: Rect, ignoreId?: NodeId): boolean;
}

const STEP_X = nodeSize(false).width + BRANCH_GAP_X;
const STEP_Y = nodeSize(false).height + BRANCH_GAP_Y;

/**
 * Vertical offset of the n-th child relative to its parent's top edge.
 * Index 0 sits level with the parent; subsequent children alternate up and down.
 */
export function slotOffsetForIndex(index: number): number {
  if (index <= 0) return 0;
  const ring = Math.ceil(index / 2);
  const direction = index % 2 === 0 ? 1 : -1;
  return direction * ring * STEP_Y;
}

export function canonicalChildPosition(parent: NoteNode, index: number): Point {
  const parentWidth = nodeSize(parent.collapsed).width;
  return {
    x: parent.position.x + parentWidth + BRANCH_GAP_X,
    y: parent.position.y + slotOffsetForIndex(index),
  };
}

/**
 * Deterministic candidate positions to try, in order, when the canonical slot is
 * taken. Bounded so placement can never loop forever on a dense canvas.
 */
export function candidatePositions(preferred: Point): Point[] {
  const out: Point[] = [preferred];
  for (let column = 1; column <= 3; column += 1) {
    const x = preferred.x + column * STEP_X;
    out.push({ x, y: preferred.y });
    for (let row = 1; row <= 4; row += 1) {
      out.push({ x, y: preferred.y + row * STEP_Y });
      out.push({ x, y: preferred.y - row * STEP_Y });
    }
  }
  // Final fallback: straight below the preferred slot, far enough to clear most clusters.
  out.push({ x: preferred.x, y: preferred.y + 6 * STEP_Y });
  return out;
}

/**
 * Resolves the world position for the `index`-th child of `parent`.
 *
 * Takes the parent node itself rather than a document, so callers that are
 * building a graph in bulk (the stress generator, an importer) never have to
 * materialise a whole document just to place one window. `isOccupied` is
 * injected — backed by the canvas spatial index in the app — which keeps this
 * module free of rendering concerns and trivially unit-testable.
 */
export function resolveChildPosition(
  parent: NoteNode,
  index: number,
  isOccupied: OccupancyQuery,
  size: { width: number; height: number } = nodeSize(false),
): Point {
  const preferred = canonicalChildPosition(parent, index);
  for (const candidate of candidatePositions(preferred)) {
    const rect: Rect = { x: candidate.x, y: candidate.y, width: size.width, height: size.height };
    if (!isOccupied(rect)) return candidate;
  }
  return { x: preferred.x, y: preferred.y + 6 * STEP_Y };
}

/** Bounding box of a set of nodes, in world coordinates. Empty when no nodes. */
export function boundsOf(nodes: NoteNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const size = nodeSize(node.collapsed);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
