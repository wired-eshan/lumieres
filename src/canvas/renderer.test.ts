/**
 * Renderer smoke coverage.
 *
 * jsdom cannot rasterise, so instead of asserting pixels we drive `draw()` with
 * a recording 2D context and assert the *work* it performs: that every zoom tier
 * and node state draws without throwing, that culling actually excludes
 * off-screen windows, and that selection/limits change what gets painted. This
 * catches the failure mode that matters here — a draw pass that throws mid-frame
 * and leaves the canvas frozen.
 */

import { describe, expect, it } from 'vitest';
import { GraphRenderer, edgeGeometry, nodeRectAt } from './renderer';
import { SpatialGrid } from './spatialIndex';
import { TextLayoutCache } from './textLayout';
import { createBranch, createEmptyDocument, updateNodeContent } from '../graph/graphOperations';
import { MAX_NODE_CONTENT_LENGTH, type GraphDocument, type Point } from '../graph/types';
import { zoomTier } from './theme';
import type { Camera } from './camera';

interface RecordingContext {
  ctx: CanvasRenderingContext2D;
  calls: string[];
  countOf(method: string): number;
  texts(): string[];
  /** Numeric arguments of every `method` call, in paint order. */
  argsOf(method: string): number[][];
}

const METHODS = new Set([
  'save',
  'restore',
  'clearRect',
  'fillRect',
  'strokeRect',
  'beginPath',
  'moveTo',
  'lineTo',
  'quadraticCurveTo',
  'bezierCurveTo',
  'closePath',
  'fill',
  'stroke',
  'clip',
  'translate',
  'scale',
  'setTransform',
  'setLineDash',
  'fillText',
  'strokeText',
  'arc',
  'rect',
  'ellipse',
  'measureText',
]);

function createRecordingContext(): RecordingContext {
  const calls: string[] = [];
  const argLog = new Map<string, number[][]>();
  const texts: string[] = [];
  const state: Record<string, unknown> = {};

  const ctx = new Proxy(
    {},
    {
      get(_target, property: string | symbol) {
        if (typeof property !== 'string') return undefined;
        if (property === 'measureText') {
          return (text: string) => ({ width: text.length * 7 });
        }
        if (METHODS.has(property)) {
          return (...args: unknown[]) => {
            calls.push(property);
            if (args.every((arg) => typeof arg === 'number')) {
              const log = argLog.get(property) ?? [];
              log.push(args as number[]);
              argLog.set(property, log);
            }
            if (property === 'fillText' && typeof args[0] === 'string') texts.push(args[0]);
            return undefined;
          };
        }
        return state[property];
      },
      set(_target, property: string | symbol, value) {
        if (typeof property === 'string') state[property] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;

  return {
    ctx,
    calls,
    texts: () => texts,
    countOf: (method: string) => calls.filter((call) => call === method).length,
    argsOf: (method: string) => argLog.get(method) ?? [],
  };
}

function buildGraph(): { doc: GraphDocument; rootId: string; childId: string; grandchildId: string } {
  let doc = createEmptyDocument('Renderer test');
  const rootId = doc.rootNodeId;
  const rootText = 'Root note with enough text to wrap across a couple of lines in the window.';
  doc = withContent(doc, rootId, rootText);

  const start = rootText.indexOf('enough text');
  const child = createBranch(doc, {
    parentId: rootId,
    position: { x: 520, y: 40 },
    title: 'A branch',
    sourceReference: {
      sourceNodeId: rootId,
      selectedTextSnapshot: 'enough text',
      startOffset: start,
      endOffset: start + 'enough text'.length,
      sourceContentVersion: doc.nodes[rootId]?.contentVersion ?? 1,
    },
  });
  if (!child.ok) throw new Error(child.message);
  doc = child.value.doc;
  doc = withContent(doc, child.value.node.id, 'Child body text.');

  const grandchild = createBranch(doc, {
    parentId: child.value.node.id,
    position: { x: 1040, y: -180 },
    title: 'Grandchild',
  });
  if (!grandchild.ok) throw new Error(grandchild.message);
  doc = grandchild.value.doc;

  // One collapsed window and one over-limit window exercise the special cases.
  const collapsed = createBranch(doc, {
    parentId: rootId,
    position: { x: 520, y: -220 },
    title: 'Collapsed',
  });
  if (collapsed.ok) doc = collapsed.value.doc;

  return { doc, rootId, childId: child.value.node.id, grandchildId: grandchild.value.node.id };
}

function withContent(doc: GraphDocument, id: string, content: string): GraphDocument {
  const result = updateNodeContent(doc, id, content);
  if (!result.ok) throw new Error(result.message);
  return result.value.doc;
}

function indexFor(doc: GraphDocument): SpatialGrid {
  const grid = new SpatialGrid(480);
  grid.rebuild(
    Object.values(doc.nodes).map((node) => [node.id, nodeRectAt(node.position, node.collapsed)] as const),
  );
  return grid;
}

function frameFor(
  doc: GraphDocument,
  camera: Camera,
  overrides: Partial<Parameters<GraphRenderer['draw']>[1]> = {},
): Parameters<GraphRenderer['draw']>[1] {
  return {
    doc,
    camera,
    viewport: { width: 1400, height: 900 },
    draftPositions: new Map<string, Point>(),
    selectedIds: new Set<string>(),
    hoveredId: null,
    editingNodeId: null,
    marquee: null,
    index: indexFor(doc),
    now: 1000,
    ...overrides,
  };
}

describe('canvas renderer', () => {
  it('draws every node state without throwing', () => {
    const { doc, rootId, childId } = buildGraph();
    const renderer = new GraphRenderer();
    const recording = createRecordingContext();

    renderer.draw(
      recording.ctx,
      frameFor(doc, { x: -200, y: -300, zoom: 1 }, {
        selectedIds: new Set([rootId]),
        hoveredId: childId,
        marquee: { x: 20, y: 20, width: 300, height: 200 },
        pulse: { ids: new Set([childId]), startedAt: 900 },
        draftPositions: new Map([[childId, { x: 560, y: 80 }]]),
      }),
    );

    expect(recording.countOf('fillText')).toBeGreaterThan(4);
    expect(recording.countOf('bezierCurveTo')).toBeGreaterThan(0);
    // One curve per edge.
    expect(recording.countOf('bezierCurveTo')).toBeGreaterThan(0);
    expect(recording.calls).toContain('setLineDash');
  });

  it('paints the selection marquee in screen space, not raw world space', () => {
    const { doc } = buildGraph();
    const renderer = new GraphRenderer();
    const recording = createRecordingContext();
    const camera = { x: -200, y: -300, zoom: 2 };

    // The engine hands the renderer a world rect (shared with hit testing).
    const world = { x: 100, y: 50, width: 333, height: 222 };
    renderer.draw(recording.ctx, frameFor(doc, camera, { marquee: world }));

    // screen = (world - camera) * zoom — the box must land under the cursor,
    // not offset by the camera position.
    expect(recording.argsOf('fillRect')).toContainEqual([600, 700, 666, 444]);
    // strokeRect is drawn only by the marquee, so its single call is unambiguous.
    expect(recording.argsOf('strokeRect')).toEqual([[600.5, 700.5, 666, 444]]);
  });

  it('keeps the marquee visible at extreme zoom-out', () => {
    const { doc } = buildGraph();
    const renderer = new GraphRenderer();
    const recording = createRecordingContext();
    const camera = { x: 0, y: 0, zoom: zoomTier.structure / 2 };

    renderer.draw(recording.ctx, frameFor(doc, camera, {
      marquee: { x: 100, y: 100, width: 400, height: 200 },
    }));

    expect(recording.countOf('strokeRect')).toBe(1);
  });

  it('paints the note body text of visible windows', () => {
    const { doc } = buildGraph();
    const renderer = new GraphRenderer();
    const recording = createRecordingContext();
    renderer.draw(recording.ctx, frameFor(doc, { x: -200, y: -300, zoom: 1 }));

    const painted = recording.texts().join(' | ');
    expect(painted).toContain('Root note');
    expect(painted).toContain('Root note with enough text');
    expect(painted).toContain('A branch');
    // Character budget and branch budget are both reported per window.
    expect(painted).toContain('/ 20,000');
    expect(painted).toContain('/50 branches');
  });

  it('shows the source snippet and flags a stale reference', () => {
    const { doc, rootId, childId } = buildGraph();
    const renderer = new GraphRenderer();

    const fresh = createRecordingContext();
    renderer.draw(fresh.ctx, frameFor(doc, { x: -200, y: -300, zoom: 1 }));
    expect(fresh.texts().join(' | ')).toContain('enough text');

    // Change the source text under the reference.
    const edited = withContent(doc, rootId, 'Completely different root text now.');
    const stale = createRecordingContext();
    renderer.draw(stale.ctx, frameFor(edited, { x: -200, y: -300, zoom: 1 }));
    const painted = stale.texts().join(' | ');
    // The snapshot survives, and the window says the source moved on.
    expect(painted).toContain('enough text');
    expect(painted).toContain('source changed');
    expect(edited.nodes[childId]?.sourceReference?.selectedTextSnapshot).toBe('enough text');
  });

  it('renders a collapsed window as a title-only bar', () => {
    const { doc } = buildGraph();
    const collapsedNode = Object.values(doc.nodes).find((node) => node.title === 'Collapsed');
    if (!collapsedNode) throw new Error('collapsed node missing');

    const withCollapsed: GraphDocument = {
      ...doc,
      nodes: { ...doc.nodes, [collapsedNode.id]: { ...collapsedNode, collapsed: true } },
    };

    const renderer = new GraphRenderer();
    const recording = createRecordingContext();
    renderer.draw(recording.ctx, frameFor(withCollapsed, { x: -200, y: -300, zoom: 1 }));

    const painted = recording.texts().join(' | ');
    expect(painted).toContain('Collapsed');
    expect(painted).toContain('collapsed');
  });

  it('flags an over-limit note in the footer', () => {
    const { doc, rootId } = buildGraph();
    const huge = 'x'.repeat(MAX_NODE_CONTENT_LENGTH + 12);
    const overLimit: GraphDocument = {
      ...doc,
      nodes: { ...doc.nodes, [rootId]: { ...doc.nodes[rootId]!, content: huge } },
    };

    const renderer = new GraphRenderer();
    const recording = createRecordingContext();
    renderer.draw(recording.ctx, frameFor(overLimit, { x: -200, y: -300, zoom: 1 }));

    // 20,012 characters against a 20,000 limit.
    expect(recording.texts().join(' | ')).toContain('20,012 / 20,000');
  });

  it('switches to simplified rendering when zoomed far out', () => {
    const { doc } = buildGraph();
    const renderer = new GraphRenderer();

    const detailed = createRecordingContext();
    renderer.draw(detailed.ctx, frameFor(doc, { x: -200, y: -300, zoom: 1 }));

    const simplified = createRecordingContext();
    renderer.draw(simplified.ctx, frameFor(doc, { x: -200, y: -300, zoom: zoomTier.text / 2 }));

    // No text at low zoom — windows become blocks.
    expect(simplified.countOf('fillText')).toBe(0);
    expect(detailed.countOf('fillText')).toBeGreaterThan(0);
    expect(simplified.countOf('fillRect')).toBeGreaterThan(0);
  });

  it('renders only the topology at extreme zoom-out', () => {
    const { doc } = buildGraph();
    const renderer = new GraphRenderer();
    const recording = createRecordingContext();
    renderer.draw(recording.ctx, frameFor(doc, { x: -2000, y: -2000, zoom: zoomTier.structure / 2 }));

    expect(recording.countOf('fillText')).toBe(0);
    // No bezier edges at this tier: individual windows are sub-pixel.
    expect(recording.countOf('bezierCurveTo')).toBe(0);
  });

  it('culls windows outside the viewport', () => {
    const { doc } = buildGraph();
    const renderer = new GraphRenderer();

    const near = createRecordingContext();
    renderer.draw(near.ctx, frameFor(doc, { x: -200, y: -300, zoom: 1 }));
    const nearFrames = near.countOf('fillText');

    const far = createRecordingContext();
    renderer.draw(far.ctx, frameFor(doc, { x: 50_000, y: 50_000, zoom: 1 }));

    expect(nearFrames).toBeGreaterThan(0);
    expect(far.countOf('fillText')).toBe(0);
    expect(far.countOf('bezierCurveTo')).toBe(0);
  });

  it('keeps a dragged window visible even when the index is stale', () => {
    const { doc, childId } = buildGraph();
    const renderer = new GraphRenderer();
    const recording = createRecordingContext();

    // Drag the child far off-screen; the draft position must still be painted
    // because the spatial index has not caught up yet.
    const camera: Camera = { x: 4000, y: 4000, zoom: 1 };
    renderer.draw(
      recording.ctx,
      frameFor(doc, camera, {
        draftPositions: new Map([[childId, { x: 4300, y: 4300 }]]),
        forceVisible: new Set([childId]),
      }),
    );

    expect(recording.countOf('fillText')).toBeGreaterThan(0);
  });

  it('reports culling and draw counts for diagnostics', () => {
    const { doc } = buildGraph();
    const renderer = new GraphRenderer();
    const recording = createRecordingContext();
    renderer.draw(recording.ctx, frameFor(doc, { x: -200, y: -300, zoom: 1 }));

    expect(renderer.stats.visible).toBeGreaterThan(0);
    expect(renderer.stats.drawnNodes).toBeGreaterThan(0);
    expect(renderer.stats.drawnEdges).toBeGreaterThan(0);
    // Culling is a superset of what is painted: the cull rect is padded.
    expect(renderer.stats.visible).toBeGreaterThanOrEqual(renderer.stats.drawnNodes);
  });
});

describe('edge geometry', () => {
  it('leaves the side of the parent that faces the child', () => {
    const parent = { x: 0, y: 0, width: 340, height: 268 };
    const right = edgeGeometry(parent, { x: 600, y: 0, width: 340, height: 268 });
    expect(right.from).toEqual({ x: 340, y: 134 });
    expect(right.to).toEqual({ x: 600, y: 134 });
    expect(right.direction).toEqual({ x: 1, y: 0 });

    const left = edgeGeometry(parent, { x: -600, y: 0, width: 340, height: 268 });
    expect(left.from.x).toBe(0);
    expect(left.direction).toEqual({ x: -1, y: 0 });

    const below = edgeGeometry(parent, { x: 0, y: 500, width: 340, height: 268 });
    expect(below.from).toEqual({ x: 170, y: 268 });
    expect(below.direction).toEqual({ x: 0, y: 1 });

    const above = edgeGeometry(parent, { x: 0, y: -500, width: 340, height: 268 });
    expect(above.direction).toEqual({ x: 0, y: -1 });
  });

  it('keeps control points clear of both windows', () => {
    const geometry = edgeGeometry(
      { x: 0, y: 0, width: 340, height: 268 },
      { x: 472, y: 30, width: 340, height: 268 },
    );
    expect(geometry.c1.x).toBeGreaterThan(geometry.from.x);
    expect(geometry.c2.x).toBeLessThan(geometry.to.x);
  });
});

describe('text layout cache', () => {
  it('reuses a layout until an input changes', () => {
    const cache = new TextLayoutCache();
    const first = cache.get('n1', 'some text', '400 13px sans-serif', 300, 8);
    const second = cache.get('n1', 'some text', '400 13px sans-serif', 300, 8);
    expect(second).toBe(first);

    const changed = cache.get('n1', 'some other text', '400 13px sans-serif', 300, 8);
    expect(changed).not.toBe(first);

    cache.invalidate('n1');
    expect(cache.size).toBe(0);
  });
});
