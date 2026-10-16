/**
 * Uniform-grid spatial index for node hit-testing and viewport culling.
 *
 * A uniform grid (rather than an R-tree) is the right trade-off here: node
 * bounds are near-identical in size, updates are single-cell moves, and both
 * queries we need (point hit-test, rect overlap) are O(cells touched) with a
 * tiny constant. Rebuild is O(n) and only happens on wholesale document change.
 */

import { pointInRect, rectEquals, rectsOverlap } from '../utils/geometry';
import type { NodeId, Point, Rect } from '../graph/types';

const DEFAULT_CELL_SIZE = 480;

interface Entry {
  rect: Rect;
  cells: string[];
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

export class SpatialGrid {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Set<NodeId>>();
  private readonly entries = new Map<NodeId, Entry>();

  constructor(cellSize: number = DEFAULT_CELL_SIZE) {
    this.cellSize = cellSize;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.cells.clear();
    this.entries.clear();
  }

  insert(id: NodeId, rect: Rect): void {
    this.remove(id);
    const keys = this.cellKeysFor(rect);
    for (const key of keys) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.add(id);
      else this.cells.set(key, new Set([id]));
    }
    this.entries.set(id, { rect, cells: keys });
  }

  remove(id: NodeId): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const key of entry.cells) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.cells.delete(key);
    }
    this.entries.delete(id);
  }

  /** Cheap no-op when the rect has not moved out of its cells. */
  update(id: NodeId, rect: Rect): void {
    const entry = this.entries.get(id);
    if (entry && rectEquals(entry.rect, rect)) return;
    this.insert(id, rect);
  }

  rebuild(entries: Iterable<readonly [NodeId, Rect]>): void {
    this.clear();
    for (const [id, rect] of entries) this.insert(id, rect);
  }

  /** Ids whose bounds contain the point. Callers apply their own z-ordering. */
  queryPoint(point: Point): NodeId[] {
    const bucket = this.cells.get(cellKey(this.cellX(point.x), this.cellY(point.y)));
    if (!bucket) return [];
    const out: NodeId[] = [];
    for (const id of bucket) {
      const entry = this.entries.get(id);
      if (entry && pointInRect(point, entry.rect)) out.push(id);
    }
    return out;
  }

  /** Ids whose bounds intersect the rect. */
  queryRect(rect: Rect): NodeId[] {
    const out = new Set<NodeId>();
    const minX = this.cellX(rect.x);
    const maxX = this.cellX(rect.x + rect.width);
    const minY = this.cellY(rect.y);
    const maxY = this.cellY(rect.y + rect.height);
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) {
        const bucket = this.cells.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) {
          const entry = this.entries.get(id);
          if (entry && rectsOverlap(rect, entry.rect)) out.add(id);
        }
      }
    }
    return [...out];
  }

  /** True when the rect overlaps any indexed node other than `ignoreId`. */
  isOccupied(rect: Rect, ignoreId?: NodeId): boolean {
    const hits = this.queryRect(rect);
    return hits.some((id) => id !== ignoreId);
  }

  private cellKeysFor(rect: Rect): string[] {
    const keys: string[] = [];
    const minX = this.cellX(rect.x);
    const maxX = this.cellX(rect.x + rect.width);
    const minY = this.cellY(rect.y);
    const maxY = this.cellY(rect.y + rect.height);
    for (let cx = minX; cx <= maxX; cx += 1) {
      for (let cy = minY; cy <= maxY; cy += 1) keys.push(cellKey(cx, cy));
    }
    return keys;
  }

  private cellX(x: number): number {
    return Math.floor(x / this.cellSize);
  }

  private cellY(y: number): number {
    return Math.floor(y / this.cellSize);
  }
}
