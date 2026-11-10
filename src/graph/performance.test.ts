/**
 * Performance validation on synthetic graphs.
 *
 * What is measured here is everything that is measurable outside a browser:
 * document construction, index maintenance, culling and hit-test queries, and
 * the cost of a single-node edit on a large document. Frame rate itself is not
 * asserted — jsdom has no rasteriser — so these tests bound the *work per
 * frame* rather than claiming a frame rate. See README for the manual check and
 * the numbers observed there.
 *
 * Bounds are deliberately generous (they catch algorithmic regressions such as
 * an O(n) scan per query, not micro-variance on a loaded machine).
 */

import { describe, expect, it } from 'vitest';
import { createStressGraph } from '../utils/stressGraph';
import { validateGraph } from './graphValidation';
import { getChildCount, getNode, updateNodeContent } from './graphOperations';
import { SpatialGrid } from '../canvas/spatialIndex';
import { GraphRenderer, nodeRectAt } from '../canvas/renderer';
import { hitTestNode, nodesInRect } from '../canvas/hitTesting';
import { visibleWorldRect } from '../canvas/coordinateTransforms';
import { TextLayoutCache } from '../canvas/textLayout';
import { fonts } from '../canvas/theme';
import { displayTitle } from './displayTitle';
import { MAX_CHILDREN_PER_NODE, MAX_NODE_CONTENT_LENGTH, type Point } from './types';
import type { Camera } from '../canvas/camera';
import type { GraphDocument } from './types';

function report(label: string, ms: number): void {
  // Printed so the measured numbers are visible in test output rather than
  // being asserted into existence.
  console.log(`    ${label}: ${ms.toFixed(1)}ms`);
}

function indexOf(doc: GraphDocument): SpatialGrid {
  const grid = new SpatialGrid(480);
  grid.rebuild(
    Object.values(doc.nodes).map((node) => [node.id, nodeRectAt(node.position, node.collapsed)] as const),
  );
  return grid;
}

describe('synthetic graph shapes', () => {
  it('builds the 1 root + 50 children shape', () => {
    const started = performance.now();
    const doc = createStressGraph({ totalNodes: 51, branching: MAX_CHILDREN_PER_NODE, contentLength: 400 });
    report('1 root + 50 children', performance.now() - started);

    expect(Object.keys(doc.nodes)).toHaveLength(51);
    expect(getChildCount(doc, doc.rootNodeId)).toBe(50);
    expect(validateGraph(doc).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('builds several levels with hundreds of nodes', () => {
    const doc = createStressGraph({ totalNodes: 600, branching: 12, contentLength: 600 });
    expect(Object.keys(doc.nodes)).toHaveLength(600);
    expect(Object.keys(doc.edges)).toHaveLength(599);
    expect(validateGraph(doc).filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('builds and validates a 5,000-node stress graph', () => {
    const started = performance.now();
    const doc = createStressGraph({ totalNodes: 5000, branching: 12, contentLength: 400 });
    const buildMs = performance.now() - started;
    report('build 5,000 nodes', buildMs);

    expect(Object.keys(doc.nodes)).toHaveLength(5000);

    const validateStart = performance.now();
    const errors = validateGraph(doc).filter((issue) => issue.severity === 'error');
    report('validate 5,000 nodes', performance.now() - validateStart);
    expect(errors).toEqual([]);

    // Every note is placed without overlapping its parent.
    const sample = Object.values(doc.nodes).slice(0, 200);
    for (const node of sample) {
      if (!node.parentId) continue;
      const parent = getNode(doc, node.parentId);
      expect(parent).toBeDefined();
      expect(node.position.x).toBeGreaterThan((parent?.position.x ?? 0));
    }
  });
});

describe('per-frame work on a 5,000-node canvas', () => {
  const doc = createStressGraph({ totalNodes: 5000, branching: 12, contentLength: 400 });
  const grid = indexOf(doc);

  it('culls to the visible viewport in well under a frame', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 0.55 };
    const viewport = { width: 1600, height: 900 };
    const visible = visibleWorldRect(camera, viewport);
    const cullRect = { x: visible.x - 240, y: visible.y - 240, width: visible.width + 480, height: visible.height + 480 };

    const started = performance.now();
    let drawn = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      drawn = grid.queryRect(cullRect).length;
    }
    const perFrame = (performance.now() - started) / 60;
    report('cull query (per frame)', perFrame);

    expect(drawn).toBeGreaterThan(0);
    // A whole frame budget at 60fps is 16.7ms; culling must be a small slice.
    expect(perFrame).toBeLessThan(4);
  });

  it('hit-tests in constant-ish time regardless of graph size', () => {
    const started = performance.now();
    for (let probe = 0; probe < 500; probe += 1) {
      hitTestNode(doc, grid, { x: (probe % 100) * 480, y: Math.floor(probe / 100) * 340 });
    }
    const perHit = (performance.now() - started) / 500;
    report('hit test (per probe)', perHit);
    expect(perHit).toBeLessThan(1.5);
  });

  it('answers marquee selection queries quickly', () => {
    const started = performance.now();
    for (let probe = 0; probe < 60; probe += 1) {
      nodesInRect(doc, grid, { x: probe * 100, y: probe * 60, width: 1800, height: 1200 });
    }
    const perQuery = (performance.now() - started) / 60;
    report('marquee query', perQuery);
    expect(perQuery).toBeLessThan(6);
  });

  it('keeps wrapped-text measurement off the pan path', () => {
    const cache = new TextLayoutCache();
    const sample = Object.values(doc.nodes).slice(0, 400);
    for (const node of sample) cache.get(node.id, node.content, fonts.body, 300, 9);

    const started = performance.now();
    for (let pass = 0; pass < 20; pass += 1) {
      for (const node of sample) cache.get(node.id, node.content, fonts.body, 300, 9);
    }
    const perPass = (performance.now() - started) / 20;
    report('cached layout lookup, 400 notes', perPass);

    // Panning and zooming only ever hit the cache.
    expect(perPass).toBeLessThan(6);
  });

  it('costs a bounded amount to edit one note out of 5,000', () => {
    const target = Object.keys(doc.nodes)[2500];
    if (!target) throw new Error('no target node');

    const started = performance.now();
    for (let edit = 0; edit < 50; edit += 1) {
      const result = updateNodeContent(doc, target, `edited ${edit}`);
      expect(result.ok).toBe(true);
    }
    const perEdit = (performance.now() - started) / 50;
    report('single-node content update', perEdit);

    // One structural-sharing copy of the node map per keystroke commit.
    expect(perEdit).toBeLessThan(3);

    // The edit did not touch any other node object.
    const updated = updateNodeContent(doc, target, 'final');
    if (!updated.ok) throw new Error('update failed');
    let shared = 0;
    for (const [id, node] of Object.entries(doc.nodes)) {
      if (id !== target && updated.value.doc.nodes[id] === node) shared += 1;
    }
    expect(shared).toBe(4999);
  });

  /**
   * jsdom has no rasteriser and every canvas operation is a Proxy trap, so the
   * frames below are orders of magnitude dearer than in a browser. The useful
   * invariant is therefore cost per *drawn window*, not a frame rate: the
   * renderer must do work proportional to what is on screen. An O(N) scan
   * hidden inside a per-window draw — as child counting and source-highlight
   * collection once were — pushes this past 0.7ms per window on this document,
   * while the indexed paths measure ~0.01ms (labels) and ~0.06ms (full text).
   */
  function steadyFrame(zoom: number, passes: number): { perFrame: number; drawn: number } {
    const renderer = new GraphRenderer();
    const camera: Camera = { x: 0, y: 0, zoom };
    const frame = {
      doc,
      camera,
      viewport: { width: 1600, height: 900 },
      draftPositions: new Map<string, Point>(),
      selectedIds: new Set<string>(),
      hoveredId: null,
      editingNodeId: null,
      marquee: null,
      index: grid,
      now: 1000,
    };
    // Warm: first paint builds wrapped-text layouts and derived titles.
    renderer.draw(createNoopContext(), frame);
    const started = performance.now();
    for (let pass = 0; pass < passes; pass += 1) renderer.draw(createNoopContext(), frame);
    return { perFrame: (performance.now() - started) / passes, drawn: renderer.stats.drawnNodes };
  }

  it('labels a zoomed-out frame in O(visible), with cached labels', () => {
    // Below the text tier each window is one derived title (memoised on node
    // identity) plus up to two cached preview lines — no skeleton bars, and no
    // measurement once the ellipsis cache is warm.
    const { perFrame, drawn } = steadyFrame(0.3, 20);
    report('title+preview frame, 5,000 nodes', perFrame);
    console.log(`      … per drawn window: ${(perFrame / Math.max(1, drawn)).toFixed(3)}ms`);

    expect(drawn).toBeGreaterThan(0);
    // Culling: only what is on screen is painted.
    expect(drawn).toBeLessThan(5000);
    expect(perFrame / Math.max(1, drawn)).toBeLessThan(0.15);
  });

  it('draws full-text windows without scanning the document per window', () => {
    // The text tier paints the most per window, so any accidental whole-document
    // walk (branch counts, descendant source-range scans) dominates here first.
    const { perFrame, drawn } = steadyFrame(0.5, 8);
    report('full-text frame, 5,000 nodes', perFrame);
    console.log(`      … per drawn window: ${(perFrame / Math.max(1, drawn)).toFixed(3)}ms`);

    expect(drawn).toBeGreaterThan(0);
    expect(perFrame / Math.max(1, drawn)).toBeLessThan(0.35);
  });

  it('derives a display title from only the leading slice of a note', () => {
    const node = Object.values(doc.nodes)[100];
    if (!node) throw new Error('no node');
    const huge = { ...node, title: '', content: 'x'.repeat(MAX_NODE_CONTENT_LENGTH) };
    const started = performance.now();
    for (let pass = 0; pass < 200; pass += 1) {
      // A fresh object each time defeats the identity memo, so this measures the
      // derivation itself: the 2,000-character inspection cap must hold.
      displayTitle({ ...huge });
    }
    const perCall = (performance.now() - started) / 200;
    report('title derivation, 20,000-char note', perCall);
    expect(perCall).toBeLessThan(1);
  });
});

/** Minimal 2D context for renderer timing; jsdom has no rasteriser. */
function createNoopContext(): CanvasRenderingContext2D {
  const noop = (): undefined => undefined;
  return new Proxy({} as CanvasRenderingContext2D, {
    get: (_target, property) => {
      if (property === 'measureText') return (text: string) => ({ width: text.length * 7 });
      return noop;
    },
    set: () => true,
  });
}
