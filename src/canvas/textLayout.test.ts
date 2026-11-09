/**
 * Offset-accuracy of the wrapped-text layout.
 *
 * The source-range highlight paints a translucent amber rect behind the exact
 * glyphs a branch was created from. Getting that right depends on every line
 * reporting precisely where in the source it begins — so a few invariants are
 * pinned here rather than trusting the wrap visually.
 */

import { describe, expect, it } from 'vitest';
import { rangeToLineSpans, wrapText } from './textLayout';

describe('wrapText line starts', () => {
  it('tracks each line to its source offset across paragraphs and line breaks', () => {
    // In a non-DOM environment (no canvas 2D context) wrapText lays out one
    // line per paragraph, but line starts walk the source — including the
    // newlines and any blank paragraphs.
    const text = 'alpha\n\nbeta\ngamma';
    const layout = wrapText(text, '400 13px sans-serif', 300, 8);
    expect(layout.lines).toEqual(['alpha', '', 'beta', 'gamma']);
    expect(layout.lineStarts).toEqual([0, 6, 7, 12]);
    // alpha(0-5), \n(6... actually alpha\n is 0-5), then blank line between
    // \n\n occupies offset 6, beta begins at 7, gamma at 12.
    expect(text.slice(0)).toHaveLength(17);
  });

  it('reports null clip and a sane line-count limit', () => {
    const layout = wrapText('one\ntwo\nthree', '400 13px sans-serif', 300, 2);
    expect(layout.lines).toEqual(['one', 'two']);
    expect(layout.clipped).toBe(true);
    expect(layout.lineStarts).toEqual([0, 4]);
  });
});

describe('rangeToLineSpans', () => {
  const layout = {
    lines: ['hello world', 'second line', 'third'],
    lineStarts: [0, 12, 24],
    clipped: false,
  };

  it('returns an empty list for an empty or inverted range', () => {
    expect(rangeToLineSpans(layout, 5, 5)).toEqual([]);
    expect(rangeToLineSpans(layout, 6, 4)).toEqual([]);
  });

  it('maps a single-line range to one span', () => {
    // "world" is offsets 6..11 within the first line.
    expect(rangeToLineSpans(layout, 6, 11)).toEqual([{ line: 0, from: 6, to: 11 }]);
  });

  it('splits a multi-line range across the lines it covers', () => {
    // From "world" (0:6..11) through "second" (1:0..6) and the start of "line".
    const spans = rangeToLineSpans(layout, 6, 14);
    expect(spans).toEqual([
      { line: 0, from: 6, to: 11 },
      { line: 1, from: 0, to: 2 },
    ]);
  });

  it('ignores a range that begins after the wrapped text', () => {
    expect(rangeToLineSpans(layout, 99, 120)).toEqual([]);
  });
});
