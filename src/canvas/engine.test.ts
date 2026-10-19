/**
 * Engine behaviour: gestures, camera/overlay synchronisation and the boundary
 * between view state and document state.
 *
 * `getContext` is stubbed with a recording 2D context so the real frame path
 * runs (mount → frame → syncOverlays → renderer.draw) against a real DOM. That
 * is what lets these tests assert the architectural rules: the camera never
 * writes to the document, and overlays are positioned from the camera without
 * any React render.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanvasEngine } from './engine';
import { graphController } from '../graph/graphController';
import { useGraphStore } from '../graph/graphStore';
import { createBranch, createEmptyDocument, getNode } from '../graph/graphOperations';
import type { Point } from '../graph/types';

const VIEWPORT = { width: 1200, height: 800 };
/** Default camera: world (0,0) sits at screen (320,180) at zoom 1. */
const ORIGIN_SCREEN = { x: 320, y: 180 };

function stubContext(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(
    {},
    {
      get(_target, property: string | symbol) {
        if (typeof property !== 'string') return undefined;
        if (property === 'measureText') return (text: string) => ({ width: text.length * 7 });
        return (..._args: unknown[]) => state[property] ?? undefined;
      },
      set(_target, property: string | symbol, value) {
        if (typeof property === 'string') state[property] = value;
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function waitForFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

interface Harness {
  engine: CanvasEngine;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  screen: HTMLDivElement;
  detach: () => void;
}

let harness: Harness | null = null;

function mountEngine(doc = createEmptyDocument('Engine test')): Harness {
  useGraphStore.getState().replaceDocument(doc, { resetHistory: true });

  const engine = new CanvasEngine(graphController);
  const unsubscribe = graphController.subscribe((nextDoc, change) => engine.setDocument(nextDoc, change));

  const canvas = document.createElement('canvas');
  (canvas as unknown as { getContext: () => unknown }).getContext = () => stubContext();
  const overlay = document.createElement('div');
  const screen = document.createElement('div');
  document.body.append(canvas, overlay, screen);

  engine.mount({ canvas, overlayLayer: overlay, screenLayer: screen });
  engine.resize(VIEWPORT.width, VIEWPORT.height, 1);

  harness = {
    engine,
    canvas,
    overlay,
    screen,
    detach: () => {
      unsubscribe();
      engine.destroy();
      canvas.remove();
      overlay.remove();
      screen.remove();
    },
  };
  return harness;
}

function withChild(): { doc: ReturnType<typeof createEmptyDocument>; childId: string } {
  const doc = createEmptyDocument('Engine test');
  const child = createBranch(doc, { parentId: doc.rootNodeId, position: { x: 500, y: 400 } });
  if (!child.ok) throw new Error(child.message);
  return { doc: child.value.doc, childId: child.value.node.id };
}

const noModifiers = { button: 0, panModifier: false, additive: false, editingLocked: false };

beforeEach(() => {
  harness = null;
});

afterEach(() => {
  harness?.detach();
  harness = null;
});

describe('camera and overlay synchronisation', () => {
  it('mirrors the camera onto the overlay layer', async () => {
    const { engine, overlay } = mountEngine();
    await waitForFrame();
    expect(overlay.style.transform).toBe('translate(320px, 180px) scale(1)');

    engine.panByScreen(100, -40);
    engine.setZoom(2, { x: 0, y: 0 });
    await waitForFrame();

    const camera = engine.camera;
    expect(overlay.style.transform).toBe(
      `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})`,
    );
    expect(overlay.style.transform).toContain('scale(2)');
  });

  it('positions the editing window in world units, not screen units', async () => {
    const { engine, overlay } = mountEngine();
    const rootId = engine.doc.rootNodeId;
    const element = document.createElement('div');
    overlay.appendChild(element);
    engine.registerEditingElement(element);
    engine.startEditing(rootId);
    await waitForFrame();

    // World position, unscaled: the layer applies the camera transform.
    expect(element.style.transform).toBe('translate3d(0px, 0px, 0)');

    engine.panByScreen(500, 500);
    await waitForFrame();
    // Panning must not move the window within the transformed layer.
    expect(element.style.transform).toBe('translate3d(0px, 0px, 0)');
  });

  it('hides a floating control whose anchor is off-screen', async () => {
    const { engine, screen } = mountEngine();
    const element = document.createElement('div');
    screen.appendChild(element);
    engine.registerToolbarElement(element);
    engine.setSelection([engine.doc.rootNodeId]);
    await waitForFrame();
    expect(element.style.display).toBe('');

    // Move the camera far away; the control is parked rather than left floating.
    engine.centerOn(90_000, 90_000);
    await waitForFrame();
    expect(element.style.display).toBe('none');
  });

  it('closes the editor when zooming too far out to edit', async () => {
    const { engine } = mountEngine();
    engine.startEditing(engine.doc.rootNodeId);
    expect(engine.getEditingId()).not.toBeNull();

    engine.setZoom(0.15);
    await waitForFrame();
    expect(engine.getEditingId()).toBeNull();
  });
});

describe('the floating branch action', () => {
  /** Reads the `translate3d(x, y, …)` a placement wrote onto an element. */
  function placement(element: HTMLElement): { x: number; y: number } {
    const match = /translate3d\((-?\d+)px, (-?\d+)px/.exec(element.style.transform);
    if (!match) throw new Error(`not positioned: "${element.style.transform}"`);
    return { x: Number(match[1]), y: Number(match[2]) };
  }

  it('hangs off the window, one gap above the frame at any selection', async () => {
    const { engine: instance, screen } = mountEngine();
    const element = document.createElement('div');
    screen.appendChild(element);
    instance.registerBranchElement(element);
    instance.setBranchSize({ width: 200, height: 60 });

    const rootId = instance.doc.rootNodeId;
    // A selection ending hard against the window's left edge: centring on the
    // anchor alone would push the control out past the frame.
    instance.setBranchAction({ nodeId: rootId, text: 'Root', start: 0, end: 4, anchor: { x: 14, y: 0 } });
    await waitForFrame();
    const first = placement(element);

    // A selection at the end of a long note: the same control, at the same
    // distance from the window — this is what used to drift down and off it.
    instance.setBranchAction({ nodeId: rootId, text: 'end', start: 500, end: 503, anchor: { x: 320, y: 0 } });
    await waitForFrame();
    const second = placement(element);

    const frame = instance.worldToScreen({ x: 0, y: 0 });
    expect(element.style.display).toBe('');
    // 10px above the window's top edge in both cases.
    expect(first.y).toBe(frame.y - 10);
    expect(second.y).toBe(frame.y - 10);
    // Clamped over the window: never hanging off its left or right edge.
    expect(first.x).toBeGreaterThanOrEqual(frame.x + 100);
    expect(second.x).toBeLessThanOrEqual(frame.x + 340 - 100);
  });

  it('stays reachable when the window header is above the viewport', async () => {
    const { engine: instance, screen } = mountEngine();
    const element = document.createElement('div');
    screen.appendChild(element);
    instance.registerBranchElement(element);
    instance.setBranchSize({ width: 200, height: 60 });

    // Push the window up so its top edge leaves the viewport but the note body
    // is still on screen.
    instance.centerOn(170, 532);
    instance.setBranchAction({
      nodeId: instance.doc.rootNodeId,
      text: 'Root',
      start: 0,
      end: 4,
      anchor: { x: 14, y: 0 },
    });
    await waitForFrame();

    expect(instance.worldToScreen({ x: 0, y: 0 }).y).toBeLessThan(0);
    expect(element.style.display).toBe('');
    const { y } = placement(element);
    // Its bottom edge is the anchor, so the whole control has to fit inside.
    expect(y).toBeGreaterThanOrEqual(8 + 60);
    expect(y - 60).toBeLessThan(VIEWPORT.height);
  });
});

describe('gestures', () => {
  it('keeps the document still while panning', async () => {
    const { engine } = mountEngine();
    const before = { ...engine.camera };
    const positionsBefore = Object.values(engine.doc.nodes).map((node) => ({ ...node.position }));

    engine.pointerDown({ x: 100, y: 100 }, { ...noModifiers, panModifier: true });
    engine.pointerMove({ x: 400, y: 260 });
    engine.pointerUp();
    await waitForFrame();

    expect(engine.camera).not.toEqual(before);
    expect(Object.values(engine.doc.nodes).map((node) => ({ ...node.position }))).toEqual(positionsBefore);
    expect(useGraphStore.getState().doc).toBe(engine.doc);
  });

  it('drags a window and commits exactly one document change on release', async () => {
    const { engine } = mountEngine();
    const rootId = engine.doc.rootNodeId;
    const store = useGraphStore.getState();
    const before = store.doc.nodes[rootId]?.position;

    engine.pointerDown({ x: ORIGIN_SCREEN.x + 20, y: ORIGIN_SCREEN.y + 20 }, noModifiers);
    expect(engine.getSelectedIds()).toEqual([rootId]);

    engine.pointerMove({ x: ORIGIN_SCREEN.x + 120, y: ORIGIN_SCREEN.y + 70 });
    engine.pointerMove({ x: ORIGIN_SCREEN.x + 220, y: ORIGIN_SCREEN.y + 120 });

    // The draft offset lives in the engine; the document is untouched mid-drag.
    expect(useGraphStore.getState().doc.nodes[rootId]?.position).toEqual(before);

    engine.pointerUp();
    await waitForFrame();

    const after = useGraphStore.getState().doc.nodes[rootId]?.position;
    expect(after).toEqual({ x: (before?.x ?? 0) + 200, y: (before?.y ?? 0) + 100 });
    expect(engine.getNode(rootId)?.position).toEqual(after);
  });

  it('cancels a drag without writing to the document', async () => {
    const { engine } = mountEngine();
    const rootId = engine.doc.rootNodeId;
    const before = { ...useGraphStore.getState().doc.nodes[rootId]?.position };

    engine.pointerDown({ x: ORIGIN_SCREEN.x + 20, y: ORIGIN_SCREEN.y + 20 }, noModifiers);
    engine.pointerMove({ x: ORIGIN_SCREEN.x + 320, y: ORIGIN_SCREEN.y + 20 });
    engine.cancelGesture();
    await waitForFrame();

    expect(useGraphStore.getState().doc.nodes[rootId]?.position).toEqual(before);
  });

  it('resizes a selected painted window from its corner and commits once', async () => {
    const { engine } = mountEngine();
    const rootId = engine.doc.rootNodeId;
    engine.setSelection([rootId]);
    const before = useGraphStore.getState().doc.nodes[rootId]?.size;
    if (!before) throw new Error('root missing');

    // Bottom-right corner of the root window (world 0,0 + 340x268).
    const corner = { x: ORIGIN_SCREEN.x + before.width - 8, y: ORIGIN_SCREEN.y + before.height - 8 };
    engine.pointerDown(corner, noModifiers);
    engine.pointerMove({ x: corner.x + 60, y: corner.y + 40 });

    // Mid-gesture, the document still has the old size; the engine draws a draft.
    expect(useGraphStore.getState().doc.nodes[rootId]?.size).toEqual(before);

    engine.pointerUp();
    await waitForFrame();

    expect(useGraphStore.getState().doc.nodes[rootId]?.size).toEqual({
      width: before.width + 60,
      height: before.height + 40,
    });
    // Resizing must not move the window or change its position deliberately.
    expect(useGraphStore.getState().doc.nodes[rootId]?.position).toEqual({ x: 0, y: 0 });
  });

  it('cancelling a corner resize restores the committed size', async () => {
    const { engine } = mountEngine();
    const rootId = engine.doc.rootNodeId;
    engine.setSelection([rootId]);
    const before = useGraphStore.getState().doc.nodes[rootId]?.size;
    if (!before) throw new Error('root missing');

    const corner = { x: ORIGIN_SCREEN.x + before.width - 8, y: ORIGIN_SCREEN.y + before.height - 8 };
    engine.pointerDown(corner, noModifiers);
    engine.pointerMove({ x: corner.x + 120, y: corner.y + 90 });
    engine.cancelGesture();
    await waitForFrame();

    expect(useGraphStore.getState().doc.nodes[rootId]?.size).toEqual(before);
  });

  it('marquee-selects the windows inside the dragged rectangle', async () => {
    const { doc, childId } = withChild();
    const { engine } = mountEngine(doc);
    const rootId = engine.doc.rootNodeId;

    // A rectangle covering both windows (root at world 0,0; child at 500,400),
    // expressed in screen coordinates through the default camera.
    engine.pointerDown({ x: 220, y: 80 }, noModifiers);
    engine.pointerMove({ x: 1220, y: 880 });
    engine.pointerUp();
    await waitForFrame();

    expect(new Set(engine.getSelectedIds())).toEqual(new Set([rootId, childId]));
  });

  it('starts a marquee from empty canvas and clears the previous selection', async () => {
    const { engine } = mountEngine();
    const rootId = engine.doc.rootNodeId;
    engine.setSelection([rootId]);

    // Screen point well clear of the root window.
    engine.pointerDown({ x: 1100, y: 760 }, noModifiers);
    engine.pointerMove({ x: 1180, y: 780 });
    engine.pointerUp();
    await waitForFrame();

    expect(engine.getSelectedIds()).toEqual([]);
  });

  it('hit-tests the topmost window rather than an arbitrary one', () => {
    const { engine } = mountEngine();
    const overlap = engine.createBranchFromNode(engine.doc.rootNodeId);
    if (!overlap) throw new Error('branch not created');

    // Drop the child directly on top of the root; the newer window wins.
    graphController.moveNodes({ [overlap]: { x: 0, y: 0 } });
    const hit = engine.hitTest({ x: ORIGIN_SCREEN.x + 20, y: ORIGIN_SCREEN.y + 20 });
    expect(hit).toBe(overlap);
  });

  it('ignores gestures that start inside an overlay', () => {
    const { engine } = mountEngine();
    const before = engine.camera;
    // The interaction layer filters overlay targets before reaching the engine;
    // the engine's own guard is `editingLocked`.
    engine.pointerDown({ x: 100, y: 100 }, { ...noModifiers, editingLocked: true });
    expect(engine.isGestureActive()).toBe(false);
    expect(engine.camera).toBe(before);
  });
});

describe('wheel handling', () => {
  it('zooms around the pointer and keeps the anchored world point fixed', async () => {
    const { engine } = mountEngine();
    const pointer = { x: 700, y: 420 };
    const worldBefore = engine.screenToWorld(pointer);

    engine.wheel(0, -120, pointer, true);
    await waitForFrame();

    const worldAfter = engine.screenToWorld(pointer);
    expect(engine.camera.zoom).toBeGreaterThan(1);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
  });

  it('pans on a plain wheel gesture without changing zoom', async () => {
    const { engine } = mountEngine();
    const zoomBefore = engine.camera.zoom;
    const yBefore = engine.camera.y;

    engine.wheel(0, 180, { x: 600, y: 400 }, false);
    await waitForFrame();

    expect(engine.camera.zoom).toBe(zoomBefore);
    expect(engine.camera.y).not.toBe(yBefore);
  });
});

describe('editing state', () => {
  it('flushes an uncommitted draft when editing stops', () => {
    const { engine } = mountEngine();
    const rootId = engine.doc.rootNodeId;
    engine.startEditing(rootId);
    engine.setDraft(rootId, 'typed but not yet committed');
    engine.stopEditing();

    expect(useGraphStore.getState().doc.nodes[rootId]?.content).toBe('typed but not yet committed');
    expect(engine.getDraft(rootId)).toBeNull();
  });

  it('drops the draft without writing when the window is gone', () => {
    const { engine } = mountEngine();
    const rootId = engine.doc.rootNodeId;
    engine.setDraft(rootId, 'orphaned text');
    useGraphStore.getState().replaceDocument(createEmptyDocument('other'), { resetHistory: true });
    engine.flushDraft();

    expect(getNode(engine.doc, rootId)).toBeUndefined();
  });

  it('marks a newly created branch as selected and editable', () => {
    const { engine } = mountEngine();
    const childId = engine.createBranchFromNode(engine.doc.rootNodeId);
    expect(childId).not.toBeNull();
    expect(engine.getEditingId()).toBe(childId);
    expect(engine.getSelectedIds()).toEqual([childId]);
  });
});

describe('pointer bookkeeping', () => {
  it('reports a screen point in world coordinates', () => {
    const { engine } = mountEngine();
    const world = engine.screenToWorld(ORIGIN_SCREEN);
    expect(world.x).toBeCloseTo(0, 6);
    expect(world.y).toBeCloseTo(0, 6);

    const back: Point = engine.worldToScreen({ x: 340, y: 268 });
    expect(back).toEqual({ x: ORIGIN_SCREEN.x + 340, y: ORIGIN_SCREEN.y + 268 });
  });

  it('tracks hover only when idle', async () => {
    const { engine } = mountEngine();
    engine.pointerMove({ x: ORIGIN_SCREEN.x + 20, y: ORIGIN_SCREEN.y + 20 });
    expect(engine.getSnapshot().hoveredId).toBe(engine.doc.rootNodeId);

    engine.pointerDown({ x: ORIGIN_SCREEN.x + 20, y: ORIGIN_SCREEN.y + 20 }, noModifiers);
    engine.pointerMove({ x: 40, y: 40 });
    expect(engine.getSnapshot().hoveredId).toBe(engine.doc.rootNodeId);
    engine.pointerUp();
  });
});
