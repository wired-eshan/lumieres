import { describe, expect, it } from 'vitest';
import { SpatialGrid } from './spatialIndex';

const RECT = (x: number, y: number, width = 340, height = 268) => ({ x, y, width, height });

describe('spatial grid', () => {
  it('finds nodes under a point', () => {
    const grid = new SpatialGrid(256);
    grid.insert('a', RECT(0, 0));
    grid.insert('b', RECT(1000, 1000));

    expect(grid.queryPoint({ x: 10, y: 10 })).toEqual(['a']);
    expect(grid.queryPoint({ x: 1010, y: 1010 })).toEqual(['b']);
    expect(grid.queryPoint({ x: 500, y: 500 })).toEqual([]);
  });

  it('finds nodes intersecting a rect', () => {
    const grid = new SpatialGrid(256);
    grid.insert('a', RECT(0, 0));
    grid.insert('b', RECT(400, 0));
    grid.insert('c', RECT(2000, 2000));

    const hits = grid.queryRect({ x: 0, y: 0, width: 800, height: 300 }).sort();
    expect(hits).toEqual(['a', 'b']);
  });

  it('handles a node spanning several cells', () => {
    const grid = new SpatialGrid(100);
    grid.insert('big', RECT(-200, -200, 900, 900));
    expect(grid.queryPoint({ x: 300, y: 300 })).toEqual(['big']);
    expect(grid.queryPoint({ x: -250, y: -250 })).toEqual([]);
  });

  it('removes nodes cleanly', () => {
    const grid = new SpatialGrid(128);
    grid.insert('a', RECT(0, 0));
    grid.remove('a');
    expect(grid.size).toBe(0);
    expect(grid.queryPoint({ x: 1, y: 1 })).toEqual([]);
    expect(grid.queryRect(RECT(0, 0))).toEqual([]);
  });

  it('updates a moved node without leaving stale entries', () => {
    const grid = new SpatialGrid(128);
    grid.insert('a', RECT(0, 0));
    grid.update('a', RECT(5000, 5000));
    expect(grid.queryPoint({ x: 10, y: 10 })).toEqual([]);
    expect(grid.queryPoint({ x: 5010, y: 5010 })).toEqual(['a']);
    expect(grid.size).toBe(1);
  });

  it('reports occupancy but can ignore the node being placed', () => {
    const grid = new SpatialGrid(256);
    grid.insert('a', RECT(0, 0));
    expect(grid.isOccupied(RECT(10, 10))).toBe(true);
    expect(grid.isOccupied(RECT(10, 10), 'a')).toBe(false);
    expect(grid.isOccupied(RECT(2000, 2000))).toBe(false);
  });

  it('rebuilds from a whole document', () => {
    const grid = new SpatialGrid(256);
    grid.insert('stale', RECT(0, 0));
    grid.rebuild([
      ['x', RECT(0, 0)],
      ['y', RECT(600, 0)],
    ]);
    expect(grid.size).toBe(2);
    expect(grid.queryPoint({ x: 1, y: 1 })).toEqual(['x']);
  });

  it('stays fast with 5,000 nodes', () => {
    const grid = new SpatialGrid(480);
    const nodes: Array<readonly [string, ReturnType<typeof RECT>]> = [];
    for (let index = 0; index < 5000; index += 1) {
      const column = index % 100;
      const row = Math.floor(index / 100);
      nodes.push([`n${index}`, RECT(column * 480, row * 340)]);
    }

    const rebuildStart = performance.now();
    grid.rebuild(nodes);
    const rebuildMs = performance.now() - rebuildStart;

    const queryStart = performance.now();
    for (let index = 0; index < 200; index += 1) {
      grid.queryRect({ x: index * 40, y: index * 20, width: 1200, height: 800 });
    }
    const queryMs = performance.now() - queryStart;

    const pointStart = performance.now();
    for (let index = 0; index < 500; index += 1) {
      grid.queryPoint({ x: index * 9, y: index * 7 });
    }
    const pointMs = performance.now() - pointStart;

    // Generous bounds: these catch algorithmic regressions (an O(n) scan per
    // query would blow past them) without being flaky on a busy machine.
    expect(rebuildMs).toBeLessThan(400);
    expect(queryMs).toBeLessThan(400);
    expect(pointMs).toBeLessThan(200);
    // A point query must not degrade to a full scan.
    expect(pointMs).toBeLessThan(queryMs + 60);
  });
});
