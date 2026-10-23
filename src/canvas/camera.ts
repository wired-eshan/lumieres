/**
 * Camera state and camera-producing operations.
 *
 * The camera is plain mutable data owned by the render engine — never React
 * state — because it changes on every pointer-move and must not rerender the
 * component tree. Functions here return *new* cameras so they stay testable.
 */

import { MAX_ZOOM, MIN_ZOOM } from '../config';
import type { Point, Rect } from '../graph/types';
import { clamp } from '../utils/misc';
import { screenToWorld, visibleWorldRect } from './coordinateTransforms';

export interface Camera {
  /** World x at the viewport's left edge. */
  x: number;
  /** World y at the viewport's top edge. */
  y: number;
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const IDENTITY_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function createCamera(partial: Partial<Camera> = {}): Camera {
  return {
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    zoom: clamp(partial.zoom ?? 1, MIN_ZOOM, MAX_ZOOM),
  };
}

export function clampZoom(zoom: number): number {
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

export function panCamera(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  return { ...camera, x: camera.x - dxScreen / camera.zoom, y: camera.y - dyScreen / camera.zoom };
}

/**
 * Zoom so the world point currently under `screenPoint` stays under it.
 * This is the standard "zoom around cursor" behaviour and the reason wheel
 * zooming feels anchored rather than drifting.
 */
export function zoomAround(camera: Camera, screenPoint: Point, factor: number): Camera {
  const nextZoom = clampZoom(camera.zoom * factor);
  if (nextZoom === camera.zoom) return camera;
  const anchorWorld = screenToWorld(camera, screenPoint);
  return {
    zoom: nextZoom,
    x: anchorWorld.x - screenPoint.x / nextZoom,
    y: anchorWorld.y - screenPoint.y / nextZoom,
  };
}

/** Sets an absolute zoom level around a screen point. */
export function zoomToAround(camera: Camera, screenPoint: Point, zoom: number): Camera {
  const nextZoom = clampZoom(zoom);
  if (nextZoom === camera.zoom) return camera;
  const anchorWorld = screenToWorld(camera, screenPoint);
  return {
    zoom: nextZoom,
    x: anchorWorld.x - screenPoint.x / nextZoom,
    y: anchorWorld.y - screenPoint.y / nextZoom,
  };
}

/** Centres the viewport on a world rectangle, optionally fitting it to size. */
export function centerOnRect(
  rect: Rect,
  viewport: Viewport,
  options: { zoom?: number; padding?: number } = {},
): Camera {
  const padding = options.padding ?? 0;
  const zoom = clampZoom(
    options.zoom ??
      Math.min(
        viewport.width / Math.max(rect.width + padding * 2, 1),
        viewport.height / Math.max(rect.height + padding * 2, 1),
      ),
  );
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return {
    zoom,
    x: centerX - viewport.width / (2 * zoom),
    y: centerY - viewport.height / (2 * zoom),
  };
}

/** Fits a world rectangle into the viewport with breathing room. */
export function fitToRect(rect: Rect, viewport: Viewport, padding = 80): Camera {
  const zoom = clampZoom(
    Math.min(
      viewport.width / Math.max(rect.width + padding * 2, 1),
      viewport.height / Math.max(rect.height + padding * 2, 1),
    ),
  );
  return centerOnRect(rect, viewport, { zoom });
}

export function fitToPoint(point: Point, viewport: Viewport, zoom: number): Camera {
  const clamped = clampZoom(zoom);
  return {
    zoom: clamped,
    x: point.x - viewport.width / (2 * clamped),
    y: point.y - viewport.height / (2 * clamped),
  };
}

export function isRectVisible(camera: Camera, viewport: Viewport, rect: Rect): boolean {
  const visible = visibleWorldRect(camera, viewport);
  return (
    rect.x < visible.x + visible.width &&
    rect.x + rect.width > visible.x &&
    rect.y < visible.y + visible.height &&
    rect.y + rect.height > visible.y
  );
}

/**
 * Guarantees a world rect is fully inside the viewport.
 *
 * Pans, and zooms out only when the rect cannot fit at the current zoom. It
 * never zooms in: revealing a small window should not yank the user's zoom
 * level, which is what makes `revealNode` unobtrusive after a branch is created.
 */
export function ensureRectVisible(
  camera: Camera,
  viewport: Viewport,
  rect: Rect,
  margin = 60,
): Camera {
  const visible = visibleWorldRect(camera, viewport);
  let zoom = camera.zoom;
  const maxZoomForRect = Math.min(
    (viewport.width - margin * 2) / Math.max(rect.width, 1),
    (viewport.height - margin * 2) / Math.max(rect.height, 1),
  );
  if (maxZoomForRect < zoom) zoom = clampZoom(maxZoomForRect);

  const visibleAfterZoom = { width: viewport.width / zoom, height: viewport.height / zoom };
  let x = camera.x;
  let y = camera.y;

  if (rect.x < visible.x + margin / camera.zoom) x = rect.x - margin / zoom;
  if (rect.x + rect.width > visible.x + visible.width - margin / camera.zoom) {
    x = rect.x + rect.width + margin / zoom - visibleAfterZoom.width;
  }
  if (rect.y < visible.y + margin / camera.zoom) y = rect.y - margin / zoom;
  if (rect.y + rect.height > visible.y + visible.height - margin / camera.zoom) {
    y = rect.y + rect.height + margin / zoom - visibleAfterZoom.height;
  }

  return { x, y, zoom };
}
