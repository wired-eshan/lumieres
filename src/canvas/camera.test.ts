import { describe, expect, it } from 'vitest';
import {
  centerOnRect,
  clampZoom,
  ensureRectVisible,
  fitToRect,
  panCamera,
  zoomAround,
  zoomToAround,
  type Camera,
  type Viewport,
} from './camera';
import {
  normalizeRect,
  pointInRect,
  screenRectToWorld,
  screenToWorld,
  visibleWorldRect,
  worldRectToScreen,
  worldToScreen,
} from './coordinateTransforms';
import { MAX_ZOOM, MIN_ZOOM } from '../graph/metrics';

const VIEWPORT: Viewport = { width: 1200, height: 800 };

describe('coordinate transforms', () => {
  it('maps world to screen and back at any camera', () => {
    const camera: Camera = { x: -250, y: 130, zoom: 0.75 };
    const world = { x: 412.5, y: -88.25 };
    const screen = worldToScreen(camera, world);
    const roundTrip = screenToWorld(camera, screen);

    expect(roundTrip.x).toBeCloseTo(world.x, 9);
    expect(roundTrip.y).toBeCloseTo(world.y, 9);
  });

  it('treats the camera origin as the viewport top-left', () => {
    const camera: Camera = { x: 100, y: 50, zoom: 2 };
    expect(worldToScreen(camera, { x: 100, y: 50 })).toEqual({ x: 0, y: 0 });
    expect(worldToScreen(camera, { x: 150, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it('converts rectangles in both directions', () => {
    const camera: Camera = { x: 10, y: 20, zoom: 0.5 };
    const rect = { x: 30, y: 60, width: 200, height: 100 };
    const screen = worldRectToScreen(camera, rect);
    expect(screen).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(screenRectToWorld(camera, screen)).toEqual(rect);
  });

  it('reports the visible world rect from zoom and viewport', () => {
    const camera: Camera = { x: -100, y: -100, zoom: 2 };
    expect(visibleWorldRect(camera, VIEWPORT)).toEqual({ x: -100, y: -100, width: 600, height: 400 });
  });

  it('normalizes a drag rectangle regardless of direction', () => {
    expect(normalizeRect({ x: 10, y: 10 }, { x: -5, y: 30 })).toEqual({
      x: -5,
      y: 10,
      width: 15,
      height: 20,
    });
    expect(pointInRect({ x: 0, y: 15 }, { x: -5, y: 10, width: 15, height: 20 })).toBe(true);
    expect(pointInRect({ x: 0, y: 0 }, { x: -5, y: 10, width: 15, height: 20 })).toBe(false);
  });
});

describe('zoom around the cursor', () => {
  it('keeps the world point under the cursor fixed', () => {
    const camera: Camera = { x: 40, y: -20, zoom: 1 };
    const cursor = { x: 733, y: 219 };
    const worldUnderCursor = screenToWorld(camera, cursor);

    for (const factor of [1.1, 1.1, 1.1, 0.5, 2]) {
      const next = zoomAround(camera, cursor, factor);
      const worldAfter = screenToWorld(next, cursor);
      expect(worldAfter.x).toBeCloseTo(worldUnderCursor.x, 6);
      expect(worldAfter.y).toBeCloseTo(worldUnderCursor.y, 6);
    }
  });

  it('clamps to the zoom range without drifting', () => {
    const camera: Camera = { x: 0, y: 0, zoom: MAX_ZOOM };
    const cursor = { x: 200, y: 200 };
    const zoomedIn = zoomAround(camera, cursor, 4);
    expect(zoomedIn.zoom).toBe(MAX_ZOOM);
    expect(zoomedIn).toEqual(camera);

    const zoomedOut: Camera = { x: 0, y: 0, zoom: MIN_ZOOM };
    expect(zoomAround(zoomedOut, cursor, 0.1).zoom).toBe(MIN_ZOOM);
  });

  it('zooms to an absolute level around the cursor', () => {
    const camera: Camera = { x: 100, y: 100, zoom: 0.5 };
    const cursor = { x: 400, y: 300 };
    const worldBefore = screenToWorld(camera, cursor);
    const next = zoomToAround(camera, cursor, 1.75);
    expect(next.zoom).toBe(1.75);
    expect(screenToWorld(next, cursor).x).toBeCloseTo(worldBefore.x, 6);
  });

  it('clamps helper values', () => {
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(0.0001)).toBe(MIN_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });
});

describe('panning', () => {
  it('moves the camera opposite to the drag direction', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    // Dragging 100px to the right reveals world to the left.
    expect(panCamera(camera, 100, 0).x).toBe(-100);
    expect(panCamera(camera, 0, 50).y).toBe(-50);
  });

  it('scales pan distance by zoom so the world tracks the pointer exactly', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 2 };
    const panned = panCamera(camera, 100, 0);
    expect(panned.x).toBe(-50);
    // The world point under the pointer is unchanged by the pan.
    const before = screenToWorld(camera, { x: 300, y: 100 });
    const after = screenToWorld(panned, { x: 400, y: 100 });
    expect(after.x).toBeCloseTo(before.x, 9);
  });

  it('never changes zoom while panning', () => {
    expect(panCamera({ x: 5, y: 5, zoom: 0.42 }, 900, -300).zoom).toBe(0.42);
  });
});

describe('framing', () => {
  it('centres a rectangle in the viewport', () => {
    const rect = { x: 1000, y: 400, width: 400, height: 200 };
    const camera = centerOnRect(rect, VIEWPORT, { zoom: 1 });
    const center = screenToWorld(camera, { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 });
    expect(center.x).toBeCloseTo(1200, 6);
    expect(center.y).toBeCloseTo(500, 6);
  });

  it('fits a large graph inside the viewport with padding', () => {
    const rect = { x: -5000, y: -3000, width: 10_000, height: 6_000 };
    const camera = fitToRect(rect, VIEWPORT, 80);
    const visible = visibleWorldRect(camera, VIEWPORT);
    expect(visible.width).toBeGreaterThanOrEqual(10_000);
    expect(visible.height).toBeGreaterThanOrEqual(6_000);
    expect(camera.zoom).toBeLessThan(1);
  });

  it('does not zoom out when the rect is already visible', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    const rect = { x: 100, y: 100, width: 200, height: 200 };
    expect(ensureRectVisible(camera, VIEWPORT, rect)).toEqual(camera);
  });

  it('pans a window that is off-screen into view', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 1 };
    const rect = { x: 4000, y: 3000, width: 340, height: 268 };
    const next = ensureRectVisible(camera, VIEWPORT, rect, 60);
    const screen = worldToScreen(next, { x: rect.x, y: rect.y });
    expect(screen.x).toBeGreaterThanOrEqual(0);
    expect(screen.y).toBeGreaterThanOrEqual(0);
    expect(screen.x + rect.width * next.zoom).toBeLessThanOrEqual(VIEWPORT.width);
    expect(screen.y + rect.height * next.zoom).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('leaves the zoom level alone when the rect fits comfortably', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 0.2 };
    const rect = { x: 2000, y: 2000, width: 340, height: 268 };
    const next = ensureRectVisible(camera, VIEWPORT, rect, 60);
    // Revealing a window must not yank the user's zoom level.
    expect(next.zoom).toBe(camera.zoom);
  });

  it('zooms out when a window is larger than the viewport at the current zoom', () => {
    const camera: Camera = { x: 0, y: 0, zoom: 3 };
    const rect = { x: 2000, y: 2000, width: 340, height: 268 };
    const next = ensureRectVisible(camera, VIEWPORT, rect, 60);
    expect(next.zoom).toBeLessThan(camera.zoom);
    const visible = visibleWorldRect(next, VIEWPORT);
    expect(visible.width).toBeGreaterThanOrEqual(rect.width);
  });
});
