/**
 * Pure coordinate math.
 *
 * One convention, used everywhere: the camera stores the **world** coordinate
 * that sits at the viewport's top-left corner, plus a zoom factor.
 *
 *   screen = (world - camera) * zoom
 *   world  = camera + screen / zoom
 *
 * Node positions are always world coordinates, so panning or zooming never
 * touches the document.
 */

import type { Point, Rect } from '../graph/types';
import type { Camera } from './camera';

export function worldToScreen(camera: Camera, world: Point): Point {
  return {
    x: (world.x - camera.x) * camera.zoom,
    y: (world.y - camera.y) * camera.zoom,
  };
}

export function screenToWorld(camera: Camera, screen: Point): Point {
  return {
    x: camera.x + screen.x / camera.zoom,
    y: camera.y + screen.y / camera.zoom,
  };
}

export function worldRectToScreen(camera: Camera, rect: Rect): Rect {
  const topLeft = worldToScreen(camera, { x: rect.x, y: rect.y });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width * camera.zoom,
    height: rect.height * camera.zoom,
  };
}

export function screenRectToWorld(camera: Camera, rect: Rect): Rect {
  const topLeft = screenToWorld(camera, { x: rect.x, y: rect.y });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: rect.width / camera.zoom,
    height: rect.height / camera.zoom,
  };
}

/** World-space rectangle currently visible in a viewport of the given size. */
export function visibleWorldRect(camera: Camera, viewport: { width: number; height: number }): Rect {
  return {
    x: camera.x,
    y: camera.y,
    width: viewport.width / camera.zoom,
    height: viewport.height / camera.zoom,
  };
}

export { normalizeRect, pointInRect, rectsOverlap } from '../utils/geometry';
