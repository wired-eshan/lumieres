import { describe, expect, it } from 'vitest';
import { boundsOf, canonicalChildPosition, candidatePositions, resolveChildPosition, slotOffsetForIndex } from './layout';
import { rectsOverlap } from '../utils/geometry';
import { createBranch, createEmptyDocument, getChildren, getNode, type CreateBranchValue } from './graphOperations';
import { nodeSize } from './metrics';
import { SpatialGrid } from '../canvas/spatialIndex';
import type { GraphDocument, Point, Rect } from './types';

function addChild(doc: GraphDocument, parentId: string, position: Point): CreateBranchValue {
  const result = createBranch(doc, { parentId, position });
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe('branch placement', () => {
  it('fans children out symmetrically around the parent', () => {
    expect(slotOffsetForIndex(0)).toBe(0);
    expect(slotOffsetForIndex(1)).toBeLessThan(0);
    expect(slotOffsetForIndex(2)).toBeGreaterThan(0);
    expect(Math.abs(slotOffsetForIndex(1))).toBe(Math.abs(slotOffsetForIndex(2)));
    expect(Math.abs(slotOffsetForIndex(3))).toBeGreaterThan(Math.abs(slotOffsetForIndex(1)));
  });

  it('places a child to the right of its parent without overlapping it', () => {
    const doc = createEmptyDocument();
    const parent = getNode(doc, doc.rootNodeId);
    if (!parent) throw new Error('missing root');

    const position = canonicalChildPosition(parent, 0);
    const parentRect: Rect = { ...parent.position, ...nodeSize(false) };
    const childRect: Rect = { ...position, ...nodeSize(false) };

    expect(rectsOverlap(parentRect, childRect)).toBe(false);
    expect(position.x).toBeGreaterThan(parent.position.x + parentRect.width);
  });

  it('is deterministic: identical inputs give identical placements', () => {
    const doc = createEmptyDocument();
    const parent = getNode(doc, doc.rootNodeId);
    if (!parent) throw new Error('missing root');
    const isOccupied = () => false;
    const first = resolveChildPosition(parent, 3, isOccupied);
    const second = resolveChildPosition(parent, 3, isOccupied);
    expect(first).toEqual(second);
  });

  it('steps around occupied space instead of stacking windows', () => {
    const occupied: Rect[] = [{ x: 472, y: 0, width: 340, height: 268 }];
    const isOccupied = (rect: Rect): boolean => occupied.some((other) => rectsOverlap(rect, other));
    const doc = createEmptyDocument();
    const parent = getNode(doc, doc.rootNodeId);
    if (!parent) throw new Error('missing root');
    const position = resolveChildPosition(parent, 0, isOccupied);
    expect(rectsOverlap({ ...position, ...nodeSize(false) }, occupied[0] as Rect)).toBe(false);
  });

  it('produces a finite candidate list for a dense canvas', () => {
    const candidates = candidatePositions({ x: 0, y: 0 });
    expect(candidates.length).toBeGreaterThan(4);
    expect(candidates.length).toBeLessThan(60);
    expect(new Set(candidates.map((point) => `${point.x},${point.y}`)).size).toBe(candidates.length);
  });

  it('never places new branches on top of existing ones across 50 siblings', () => {
    // Uses the same occupancy query the engine passes in (backed by the grid).
    let doc = createEmptyDocument();
    const grid = new SpatialGrid(240);
    const root = getNode(doc, doc.rootNodeId);
    if (!root) throw new Error('missing root');
    grid.insert(root.id, { ...root.position, ...nodeSize(false) });

    for (let index = 0; index < 50; index += 1) {
      const position = resolveChildPosition(root, index, (rect, ignore) =>
        grid.isOccupied(rect, ignore),
      );
      const rect: Rect = { ...position, ...nodeSize(false) };
      expect(rectsOverlap(rect, { ...root.position, ...nodeSize(false) })).toBe(false);
      const added = addChild(doc, doc.rootNodeId, position);
      doc = added.doc;
      grid.insert(added.node.id, rect);
    }

    const children = getChildren(doc, doc.rootNodeId);
    expect(children).toHaveLength(50);
    for (let a = 0; a < children.length; a += 1) {
      for (let b = a + 1; b < children.length; b += 1) {
        const left = children[a];
        const right = children[b];
        if (!left || !right) continue;
        const overlaps = rectsOverlap(
          { ...left.position, ...nodeSize(false) },
          { ...right.position, ...nodeSize(false) },
        );
        expect(overlaps).toBe(false);
      }
    }
  });

  it('bounds the whole graph for fit-to-view', () => {
    let doc = createEmptyDocument();
    const first = addChild(doc, doc.rootNodeId, { x: 500, y: -200 });
    doc = first.doc;
    const second = addChild(doc, doc.rootNodeId, { x: 500, y: 200 });
    doc = second.doc;

    const bounds = boundsOf(Object.values(doc.nodes));
    expect(bounds).not.toBeNull();
    expect(bounds?.x).toBe(0);
    expect(bounds?.width).toBe(500 + nodeSize(false).width);
    expect(bounds?.width).toBeGreaterThan(0);
  });
});
