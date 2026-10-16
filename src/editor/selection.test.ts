/**
 * Selection measurement.
 *
 * jsdom has no layout engine, so this suite verifies the *plumbing* rather than
 * pixel accuracy: that the mirror is built with the right structure, that the
 * selected range is escaped rather than injected as HTML, that offsets come back
 * unchanged, and that the geometry is expressed in the textarea's own layout
 * space. Pixel-accurate placement of the floating action is verified manually in
 * a browser (see README).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { branchAnchorWorld, measureSelection, readSelection } from './selection';

/** jsdom reports all-zero rects; derive them from the marker attribute instead. */
function stubLayout(): void {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element): DOMRect {
    const marker = this.getAttribute('data-marker');
    const left = marker === 'start' ? 40 : marker === 'end' ? 130 : 0;
    const top = marker ? 20 : 0;
    return {
      x: left,
      y: top,
      left,
      top,
      right: left + 1,
      bottom: top + 20,
      width: 1,
      height: 20,
      toJSON: () => ({}),
    } as DOMRect;
  };
}

function makeTextarea(value: string): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  document.body.appendChild(textarea);
  return textarea;
}

beforeEach(() => {
  stubLayout();
  document.body.innerHTML = '';
});

describe('readSelection', () => {
  it('returns null for a collapsed caret', () => {
    const textarea = makeTextarea('hello world');
    textarea.setSelectionRange(5, 5);
    expect(readSelection(textarea)).toBeNull();
  });

  it('returns the offsets of a real selection', () => {
    const textarea = makeTextarea('hello world');
    textarea.setSelectionRange(6, 11);
    expect(readSelection(textarea)).toEqual({ start: 6, end: 11 });
  });
});

describe('measureSelection', () => {
  it('returns null when the range is empty', () => {
    const textarea = makeTextarea('hello world');
    expect(measureSelection(textarea, 3, 3)).toBeNull();
    expect(measureSelection(textarea, 8, 2)).toBeNull();
  });

  it('reports the selected text and unchanged offsets', () => {
    const textarea = makeTextarea('Photosynthesis converts light into chemical energy.');
    const start = 'Photosynthesis converts light into '.length;
    const end = start + 'chemical energy'.length;

    const geometry = measureSelection(textarea, start, end);
    expect(geometry).not.toBeNull();
    expect(geometry?.text).toBe('chemical energy');
    expect(geometry?.start).toBe(start);
    expect(geometry?.end).toBe(end);
    expect(geometry?.lineHeight).toBeGreaterThan(0);
  });

  it('clamps offsets that fall outside the current text', () => {
    const textarea = makeTextarea('short');
    const geometry = measureSelection(textarea, 2, 999);
    expect(geometry?.start).toBe(2);
    expect(geometry?.end).toBe(5);
    expect(geometry?.text).toBe('ort');
  });

  it('escapes markup instead of injecting it into the measurement mirror', () => {
    const textarea = makeTextarea('danger <img src=x onerror="boom()"> zone');
    const geometry = measureSelection(textarea, 0, textarea.value.length);

    expect(geometry?.text).toBe('danger <img src=x onerror="boom()"> zone');
    const mirror = document.getElementById('lumieres-selection-mirror');
    expect(mirror).not.toBeNull();
    // The tag is text in the mirror, not an element.
    expect(mirror?.querySelector('img')).toBeNull();
    expect(mirror?.innerHTML).toContain('&lt;img');
  });

  it('reuses a single mirror element across calls', () => {
    const first = makeTextarea('one two three');
    measureSelection(first, 0, 3);
    const second = makeTextarea('four five six');
    measureSelection(second, 5, 9);

    expect(document.querySelectorAll('#lumieres-selection-mirror')).toHaveLength(1);
  });

  it('measures in the textarea layout space, not screen space', () => {
    // The mirror copies the untransformed layout properties, so a camera
    // transform on the editor's ancestors cannot distort the result.
    const textarea = makeTextarea('alpha beta');
    textarea.style.width = '312px';
    const geometry = measureSelection(textarea, 0, 5);
    expect(geometry?.startRect.height).toBe(20);
    expect(geometry?.endRect.x).toBeGreaterThan(geometry?.startRect.x ?? 0);
  });
});

describe('branchAnchorWorld', () => {
  it('hangs off the window top edge, at the end of the selection', () => {
    const anchor = branchAnchorWorld(
      { x: 500, y: 300 },
      14,
      {
        startRect: { x: 0, y: 0, width: 1, height: 20 },
        endRect: { x: 60, y: 40, width: 1, height: 20 },
        text: 'beta',
        start: 6,
        end: 10,
        lineHeight: 20,
      },
    );

    // The selected line's own y is deliberately ignored: a control hung off the
    // line drifts down the window as the selection moves.
    expect(anchor).toEqual({ x: 500 + 14 + 60, y: 300 });
  });
});
