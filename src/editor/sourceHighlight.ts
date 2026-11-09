/**
 * Range segmentation for branch source highlights.
 *
 * The canvas paints note-body ranges directly (`rangeToLineSpans` in
 * `canvas/textLayout.ts`), but AI replies are DOM text rather than a textarea.
 * They are split into plain/highlighted segments here so a reply can be wrapped
 * in `<mark>` elements around the exact phrases descendant branches came from.
 *
 * Kept free of React and of the graph model so the offset arithmetic can be
 * tested on its own; the caller is responsible for only passing ranges whose
 * source reference still evaluates as `valid`.
 */

export interface HighlightRange {
  /** UTF-16 offset into the highlighted text. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

export interface TextSegment {
  text: string;
  highlighted: boolean;
}

/**
 * Clamps ranges to the text length, drops empty ones, sorts them and merges
 * overlapping or touching ranges. A message can seed several branches over
 * different phrases — and branches over nested phrases can overlap — so the
 * renderer must never emit nested `<mark>` elements.
 */
export function normalizeHighlightRanges(
  ranges: readonly HighlightRange[],
  length: number,
): HighlightRange[] {
  const clamped = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(range.start, length)),
      end: Math.max(0, Math.min(range.end, length)),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  const merged: HighlightRange[] = [];
  for (const range of clamped) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Splits `content` into alternating plain and highlighted segments. */
export function splitHighlightSegments(
  content: string,
  ranges: readonly HighlightRange[],
): TextSegment[] {
  const normalized = normalizeHighlightRanges(ranges, content.length);
  if (normalized.length === 0) {
    return content.length > 0 ? [{ text: content, highlighted: false }] : [];
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.start > cursor) {
      segments.push({ text: content.slice(cursor, range.start), highlighted: false });
    }
    segments.push({ text: content.slice(range.start, range.end), highlighted: true });
    cursor = range.end;
  }
  if (cursor < content.length) {
    segments.push({ text: content.slice(cursor), highlighted: false });
  }
  return segments;
}
