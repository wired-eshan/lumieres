/**
 * Window geometry, in **world units**.
 *
 * These constants are the single source of truth shared by the Canvas 2D
 * renderer and the HTML editor overlay, so the two always line up pixel for
 * pixel (the overlay is positioned with the very same camera transform).
 */

import type { WindowKind, WindowSize } from './types';

export const NODE_WIDTH = 340;
export const NODE_HEIGHT = 268;

/** A fresh AI window is a little larger: a conversation needs more room. */
export const AI_NODE_WIDTH = 440;
export const AI_NODE_HEIGHT = 440;

/**
 * Resize bounds. Minima keep the header, body and composer usable; maxima stop
 * a single window from swallowing the workspace at 100% zoom.
 */
export const MIN_NODE_WIDTH = 260;
export const MIN_NODE_HEIGHT = 240;
export const MAX_NODE_WIDTH = 960;
export const MAX_NODE_HEIGHT = 900;

export const NODE_HEADER_HEIGHT = 46;
export const NODE_FOOTER_HEIGHT = 30;
export const NODE_CONTENT_PADDING = 14;
export const NODE_RADIUS = 14;
export const COLLAPSED_HEIGHT = 48;

/** Horizontal gap between a parent's right edge and its children's left edge. */
export const BRANCH_GAP_X = 132;
/** Vertical gap between sibling windows. */
export const BRANCH_GAP_Y = 44;

export const BODY_FONT_SIZE = 13;
export const BODY_LINE_HEIGHT = 20;
export const TITLE_FONT_SIZE = 14;
export const TITLE_LINE_HEIGHT = 19;
export const LABEL_FONT_SIZE = 11;

/** Default size for a window's mode. Used when a node is created or migrated. */
export function defaultNodeSize(kind: WindowKind): WindowSize {
  return kind === 'ai'
    ? { width: AI_NODE_WIDTH, height: AI_NODE_HEIGHT }
    : { width: NODE_WIDTH, height: NODE_HEIGHT };
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Clamps a requested window size into the supported range.
 *
 * Dimensions are world units, so a resize survives zooming, panning and reload
 * unchanged. Collapsed height is a presentation concern and is applied by
 * `nodeSize`, never persisted over the user's chosen height.
 */
export function clampNodeSize(size: WindowSize): WindowSize {
  const width = Number.isFinite(size.width) ? size.width : NODE_WIDTH;
  const height = Number.isFinite(size.height) ? size.height : NODE_HEIGHT;
  return {
    width: Math.round(clamp(width, MIN_NODE_WIDTH, MAX_NODE_WIDTH)),
    height: Math.round(clamp(height, MIN_NODE_HEIGHT, MAX_NODE_HEIGHT)),
  };
}

/**
 * World-space size of a node in its current collapsed state.
 *
 * `size` is optional so tests and synthetic-graph builders that do not care
 * about resizing keep the historical default.
 */
export function nodeSize(
  collapsed: boolean,
  size: WindowSize = defaultNodeSize('note'),
): WindowSize {
  const clamped = clampNodeSize(size);
  return {
    width: clamped.width,
    height: collapsed ? COLLAPSED_HEIGHT : clamped.height,
  };
}

/** Height of the source-reference chip drawn above the body. */
export const SOURCE_CHIP_HEIGHT = 22;
export const SOURCE_CHIP_GAP = 8;

/**
 * Vertical offset (from the window's top edge) at which the note body starts.
 *
 * Shared by the canvas renderer and the HTML editor so the textarea lands
 * exactly on top of the preview it replaces — if these ever disagreed, the text
 * would visibly jump when a note is opened for editing.
 */
export function bodyTopOffset(hasSourceChip: boolean): number {
  return (
    NODE_HEADER_HEIGHT +
    NODE_CONTENT_PADDING * 0.5 +
    (hasSourceChip ? SOURCE_CHIP_HEIGHT + SOURCE_CHIP_GAP : 0)
  );
}

/** Height available to the note body (excluding the chip and the footer). */
export function bodyHeightFor(
  hasSourceChip: boolean,
  height: number = NODE_HEIGHT,
): number {
  return height - NODE_FOOTER_HEIGHT - bodyTopOffset(hasSourceChip) - 6;
}

/** Interior box available to the note body, in world units. */
export function bodyBox(
  collapsed: boolean,
  size: WindowSize = defaultNodeSize('note'),
): { x: number; y: number; width: number; height: number } {
  const node = nodeSize(collapsed, size);
  return {
    x: NODE_CONTENT_PADDING,
    y: bodyTopOffset(true),
    width: node.width - NODE_CONTENT_PADDING * 2,
    height: node.height - NODE_FOOTER_HEIGHT - bodyTopOffset(true) - 6,
  };
}

/** Grid spacing for the canvas background, in world units. */
export const GRID_SIZE = 28;

/** Camera limits. Below MIN_ZOOM the canvas switches to a simplified rendering mode. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
/** Zoom level at which canvas text stops being drawn in favour of block placeholders. */
export const TEXT_LOD_ZOOM = 0.42;
/** Below this zoom the HTML editor overlay is closed to avoid unreadable editing. */
export const MIN_EDIT_ZOOM = 0.5;
