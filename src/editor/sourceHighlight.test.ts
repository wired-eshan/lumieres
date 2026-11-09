/**
 * Branch source-highlight segmentation for AI replies.
 *
 * A reply is DOM text, so the ranges descendant branches were created from are
 * painted by splitting the text into plain/highlighted segments. The offset
 * arithmetic is where this can silently go wrong (a nested range producing
 * invalid markup, a stale range bleeding into an adjacent phrase), so it is
 * pinned here independently of React.
 */

import { describe, expect, it } from 'vitest';
import { normalizeHighlightRanges, splitHighlightSegments } from './sourceHighlight';

describe('normalizeHighlightRanges', () => {
  it('clamps out-of-bounds ranges to the text length', () => {
    expect(normalizeHighlightRanges([{ start: -5, end: 999 }], 10)).toEqual([{ start: 0, end: 10 }]);
  });

  it('drops empty and inverted ranges', () => {
    expect(normalizeHighlightRanges([{ start: 4, end: 4 }, { start: 8, end: 3 }], 10)).toEqual([]);
  });

  it('sorts ranges and merges the ones that touch or overlap', () => {
    expect(
      normalizeHighlightRanges(
        [
          { start: 8, end: 10 },
          { start: 0, end: 3 },
          { start: 3, end: 5 },
          { start: 4, end: 7 },
        ],
        20,
      ),
    ).toEqual([
      { start: 0, end: 7 },
      { start: 8, end: 10 },
    ]);
  });
});

describe('splitHighlightSegments', () => {
  it('returns one plain segment when there are no ranges', () => {
    expect(splitHighlightSegments('hello', [])).toEqual([{ text: 'hello', highlighted: false }]);
  });

  it('marks only the selected phrase', () => {
    expect(splitHighlightSegments('hello world', [{ start: 6, end: 11 }])).toEqual([
      { text: 'hello ', highlighted: false },
      { text: 'world', highlighted: true },
    ]);
  });

  it('supports several separate phrases from repeated branching', () => {
    // Two branches were made from this one reply, from "alpha" and "gamma".
    expect(
      splitHighlightSegments('alpha beta gamma', [
        { start: 0, end: 5 },
        { start: 11, end: 16 },
      ]),
    ).toEqual([
      { text: 'alpha', highlighted: true },
      { text: ' beta ', highlighted: false },
      { text: 'gamma', highlighted: true },
    ]);
  });

  it('never nests overlapping marks — nested phrases merge', () => {
    // A branch from "world" and another from "hello world" must paint one mark.
    expect(
      splitHighlightSegments('hello world', [
        { start: 6, end: 11 },
        { start: 0, end: 11 },
      ]),
    ).toEqual([{ text: 'hello world', highlighted: true }]);
  });

  it('handles a highlight that reaches the end of the text', () => {
    expect(splitHighlightSegments('abcdef', [{ start: 3, end: 6 }])).toEqual([
      { text: 'abc', highlighted: false },
      { text: 'def', highlighted: true },
    ]);
  });

  it('handles a highlight that starts at the very beginning', () => {
    expect(splitHighlightSegments('abcdef', [{ start: 0, end: 2 }])).toEqual([
      { text: 'ab', highlighted: true },
      { text: 'cdef', highlighted: false },
    ]);
  });

  it('ignores a range that lies wholly beyond the message text', () => {
    expect(splitHighlightSegments('short', [{ start: 10, end: 20 }])).toEqual([
      { text: 'short', highlighted: false },
    ]);
  });
});
