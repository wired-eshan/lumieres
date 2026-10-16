/**
 * Selection geometry for a plain `<textarea>`.
 *
 * A textarea exposes selection *offsets* but not their pixel position, so we
 * mirror its text into a hidden, identically-styled div and measure marker spans
 * there. This is the standard technique and it keeps the editor a real textarea:
 * native caret movement, IME, undo inside the field, accessibility and paste all
 * behave exactly as users expect.
 *
 * All results are in the textarea's own layout space ("world units"), because
 * the mirror copies the untransformed layout properties. The caller converts to
 * world coordinates by adding the window's position, so a floating control can
 * stay glued to the selection while the camera moves.
 */

import type { Point, Rect } from '../graph/types';

const MIRROR_ID = 'lumieres-selection-mirror';

const COPIED_PROPERTIES = [
  'boxSizing',
  'width',
  'height',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textAlign',
  'textIndent',
  'textTransform',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
  'tabSize',
] as const;

export interface SelectionGeometry {
  /** Caret rect at the start of the selection, relative to the textarea box. */
  startRect: Rect;
  /** Caret rect at the end of the selection. */
  endRect: Rect;
  /** Selected text exactly as it appears in the field. */
  text: string;
  start: number;
  end: number;
  /** Total number of wrapped lines in the field (useful for clamping floats). */
  lineHeight: number;
}

let mirror: HTMLDivElement | null = null;

function getMirror(): HTMLDivElement {
  if (mirror && mirror.isConnected) return mirror;
  const div = document.createElement('div');
  div.id = MIRROR_ID;
  div.setAttribute('aria-hidden', 'true');
  div.style.position = 'fixed';
  div.style.top = '0';
  div.style.left = '-10000px';
  div.style.visibility = 'hidden';
  div.style.pointerEvents = 'none';
  div.style.whiteSpace = 'pre-wrap';
  div.style.overflowWrap = 'break-word';
  div.style.zIndex = '-1';
  document.body.appendChild(div);
  mirror = div;
  return div;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/ /g, '&nbsp;');
}

/**
 * Measures the pixel geometry of `[start, end)` inside `textarea`.
 * Returns null when the range is empty or the element is not measurable.
 */
export function measureSelection(
  textarea: HTMLTextAreaElement,
  start: number,
  end: number,
): SelectionGeometry | null {
  if (start === end) return null;
  const value = textarea.value;
  const clampedStart = Math.max(0, Math.min(start, value.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, value.length));
  if (clampedStart === clampedEnd) return null;

  const div = getMirror();
  const computed = window.getComputedStyle(textarea);
  for (const property of COPIED_PROPERTIES) {
    div.style.setProperty(
      property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`),
      computed.getPropertyValue(property.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)),
    );
  }
  div.style.width = `${textarea.offsetWidth}px`;
  div.style.height = 'auto';
  div.style.borderStyle = 'solid';
  div.style.borderColor = 'transparent';

  const before = value.slice(0, clampedStart);
  const selected = value.slice(clampedStart, clampedEnd);
  const after = value.slice(clampedEnd);
  div.innerHTML =
    `${escapeHtml(before)}<span data-marker="start"></span>` +
    `<span data-marker="selected">${escapeHtml(selected)}</span>` +
    `<span data-marker="end"></span>${escapeHtml(after)}​`;

  const startMarker = div.querySelector<HTMLElement>('[data-marker="start"]');
  const endMarker = div.querySelector<HTMLElement>('[data-marker="end"]');
  if (!startMarker || !endMarker) return null;

  const divRect = div.getBoundingClientRect();
  const lineHeight = resolveLineHeight(computed);
  const startRect = rectRelativeTo(startMarker, divRect, computed, textarea, lineHeight);
  const endRect = rectRelativeTo(endMarker, divRect, computed, textarea, lineHeight);

  return {
    startRect,
    endRect,
    text: selected,
    start: clampedStart,
    end: clampedEnd,
    lineHeight,
  };
}

/**
 * Resolves a usable line height.
 *
 * `line-height: normal` and unset fonts both parse to NaN, and a NaN here would
 * propagate into the floating action's world anchor and park it at an invalid
 * position. Falls back through the font size to the editor's own default.
 */
function resolveLineHeight(computed: CSSStyleDeclaration): number {
  const fromLineHeight = Number.parseFloat(computed.lineHeight);
  if (Number.isFinite(fromLineHeight) && fromLineHeight > 0) return fromLineHeight;
  const fromFontSize = Number.parseFloat(computed.fontSize);
  if (Number.isFinite(fromFontSize) && fromFontSize > 0) return fromFontSize * 1.4;
  return 20;
}

function rectRelativeTo(
  marker: HTMLElement,
  divRect: DOMRect,
  computed: CSSStyleDeclaration,
  textarea: HTMLTextAreaElement,
  lineHeight: number,
): Rect {
  const markerRect = marker.getBoundingClientRect();
  const paddingLeft = Number.parseFloat(computed.paddingLeft) || 0;
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
  return {
    x: markerRect.left - divRect.left - paddingLeft + textarea.scrollLeft,
    y: markerRect.top - divRect.top - paddingTop + textarea.scrollTop,
    width: 1,
    height: lineHeight,
  };
}

/** Reads the current selection from a textarea, tolerating absent APIs. */
export function readSelection(textarea: HTMLTextAreaElement): { start: number; end: number } | null {
  if (typeof textarea.selectionStart !== 'number' || typeof textarea.selectionEnd !== 'number') {
    return null;
  }
  if (textarea.selectionStart === textarea.selectionEnd) return null;
  return { start: textarea.selectionStart, end: textarea.selectionEnd };
}

/**
 * World anchor for the floating branch action.
 *
 * The action hangs from the *window's top edge*, not from the line the selection
 * ends on. Anchoring to that line made the control's distance from the note
 * depend on where in the text the user was selecting: high up it covered the
 * window's own header, low down it drifted out of the frame entirely. Hanging it
 * off the frame instead keeps one distance at every selection and every zoom —
 * the engine adds the gap in screen pixels and keeps the control over the
 * window. Only the horizontal position follows the selection, so the control
 * still points at the text it will branch from.
 */
export function branchAnchorWorld(nodeOrigin: Point, contentLeft: number, geometry: SelectionGeometry): Point {
  return { x: nodeOrigin.x + contentLeft + geometry.endRect.x, y: nodeOrigin.y };
}
