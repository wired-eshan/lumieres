/**
 * Word-wrapping and measurement for canvas-drawn note text.
 *
 * Results are cached per node and invalidated when the content, the available
 * width or the font changes, so a pan/zoom never re-measures text and typing
 * only re-measures the one note being edited.
 *
 * Wrapping stops after `maxLines + 1` lines: a note window never shows more, so
 * measuring the remaining 19,000 characters would be pure waste. The extra line
 * is what tells us the text was clipped.
 */

export interface WrappedText {
  lines: string[];
  /** Character offset in the source text at which each line begins. */
  lineStarts: number[];
  /** True when the text did not fit into `maxLines`. */
  clipped: boolean;
}

interface CacheEntry {
  text: string;
  font: string;
  maxWidth: number;
  maxLines: number;
  layout: WrappedText;
}

let measureContext: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext) return measureContext;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  measureContext = canvas.getContext('2d');
  return measureContext;
}

export function measureTextWidth(text: string, font: string): number {
  const ctx = getMeasureContext();
  if (!ctx) return text.length * 7; // deterministic fallback for non-DOM environments
  ctx.font = font;
  return ctx.measureText(text).width;
}

/** Greedy word wrap that never splits a word unless it alone exceeds the width. */
export function wrapText(
  text: string,
  font: string,
  maxWidth: number,
  maxLines: number,
): WrappedText {
  const ctx = getMeasureContext();
  if (!ctx) {
    // Deterministic fallback for non-DOM environments (e.g. jsdom): one line per
    // paragraph. Line starts walk the source so callers can still map ranges.
    const paragraphs = text.split('\n');
    const clipped = paragraphs.length > maxLines;
    const kept = paragraphs.slice(0, maxLines);
    const lineStarts: number[] = [];
    let cursor = 0;
    for (const paragraph of kept) {
      lineStarts.push(cursor);
      cursor += paragraph.length + 1;
    }
    return { lines: kept, lineStarts, clipped };
  }
  ctx.font = font;

  const lines: string[] = [];
  const lineStarts: number[] = [];
  let clipped = false;

  const paragraphs = text.split('\n');
  // Absolute offset in `text` where the current paragraph begins. Kept in step
  // with the emitted lines so every line can report where it starts in source.
  let paraOffset = 0;

  for (let p = 0; p < paragraphs.length; p += 1) {
    const paragraph = paragraphs[p] ?? '';
    const nextParaOffset = paraOffset + paragraph.length + 1;
    if (lines.length >= maxLines) {
      clipped = true;
      break;
    }
    if (paragraph.length === 0) {
      lines.push('');
      lineStarts.push(paraOffset);
      paraOffset = nextParaOffset;
      continue;
    }

    const words = paragraph.split(/(\s+)/).filter((token) => token.length > 0);
    // Absolute source offset where each word begins. Words reconstruct the
    // paragraph in order, so a running `indexOf` maps each to its position.
    const wordStarts: number[] = [];
    {
      let search = 0;
      for (const word of words) {
        const index = paragraph.indexOf(word, search);
        wordStarts.push(paraOffset + index);
        search = index + word.length;
      }
    }
    let current = '';
    // Absolute source offset of the *first character* of the in-progress line,
    // matching the exact string that eventually gets pushed (leading whitespace
    // included, since a line's first character may be indentation). The first
    // line of a paragraph begins where the paragraph does.
    let pendingStart = paraOffset;

    for (let w = 0; w < words.length; w += 1) {
      const word = words[w] as string;
      const wordStart = wordStarts[w] as number;
      const candidate = current + word;
      if (ctx.measureText(candidate).width <= maxWidth || current.length === 0) {
        if (current.length === 0 && ctx.measureText(word).width > maxWidth) {
          // A single token wider than the line: hard-break it by characters.
          // Every emitted chunk starts at the source offset of its first char.
          let chunk = '';
          let chunkStart = wordStart;
          for (let ci = 0; ci < word.length; ci += 1) {
            const char = word[ci] as string;
            if (ctx.measureText(chunk + char).width > maxWidth && chunk.length > 0) {
              if (lines.length >= maxLines) {
                clipped = true;
                break;
              }
              lines.push(chunk);
              lineStarts.push(chunkStart);
              chunk = char;
              chunkStart = wordStart + ci;
            } else {
              chunk += char;
            }
          }
          current = chunk;
          pendingStart = chunkStart;
          if (clipped) break;
        } else {
          current = candidate;
        }
      } else {
        if (lines.length >= maxLines) {
          clipped = true;
          break;
        }
        lines.push(current.trimEnd());
        lineStarts.push(pendingStart);
        const trimmed = word.trimStart();
        current = trimmed;
        const leading = word.length - trimmed.length;
        pendingStart = wordStart + leading;
      }
    }
    if (clipped) break;
    if (current.length > 0) {
      if (lines.length >= maxLines) {
        clipped = true;
        break;
      }
      lines.push(current.trimEnd());
      lineStarts.push(pendingStart);
    }
    paraOffset = nextParaOffset;
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
    lineStarts.length = maxLines;
    clipped = true;
  }
  return { lines, lineStarts, clipped };
}

/**
 * Maps a `[start, end)` range of the source text onto the wrapped lines,
 * returning the character offsets *within each line's rendered string* that are
 * covered by the range. This lets the renderer paint a highlight that aligns
 * exactly with the glyphs it draws.
 *
 * Returns an array of `{ line, from, to }` covering the range in order; empty
 * when the range is absent, inverted, or falls wholly beyond the wrapped text.
 * A line's `from` is clamped so it never exceeds the line string's length, and
 * only ranges that have begun before the text was clipped are reported.
 */
export function rangeToLineSpans(
  layout: WrappedText,
  start: number,
  end: number,
): Array<{ line: number; from: number; to: number }> {
  const spans: Array<{ line: number; from: number; to: number }> = [];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return spans;

  for (let i = 0; i < layout.lines.length; i += 1) {
    const line = layout.lines[i];
    const lineStart = layout.lineStarts[i] ?? 0;
    if (line === undefined) continue;
    const lineLen = line.length;
    if (lineLen === 0) continue;
    const lineEnd = lineStart + lineLen;
    if (end <= lineStart) break; // range is entirely before this line
    if (start > lineEnd) continue; // range is entirely after this line
    const from = Math.max(0, Math.min(start, lineEnd) - lineStart);
    const to = Math.max(0, Math.min(end, lineEnd) - lineStart);
    if (to > from) spans.push({ line: i, from: Math.min(from, lineLen), to: Math.min(to, lineLen) });
  }
  return spans;
}

/** Truncates a single line with an ellipsis so it fits `maxWidth`. */
export function ellipsize(text: string, font: string, maxWidth: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  if (measureTextWidth(flat, font) <= maxWidth) return flat;

  const ctx = getMeasureContext();
  if (ctx) ctx.font = font;
  let low = 0;
  let high = flat.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${flat.slice(0, mid)}…`;
    const width = ctx ? ctx.measureText(candidate).width : candidate.length * 7;
    if (width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${flat.slice(0, low)}…`;
}

/**
 * Per-node layout cache. `get` is O(1) on a hit and only re-wraps when one of
 * the inputs actually changed.
 */
export class TextLayoutCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string, text: string, font: string, maxWidth: number, maxLines: number): WrappedText {
    const existing = this.entries.get(key);
    if (
      existing &&
      existing.text === text &&
      existing.font === font &&
      existing.maxWidth === maxWidth &&
      existing.maxLines === maxLines
    ) {
      return existing.layout;
    }
    const rounded = Math.round(maxWidth * 2) / 2;
    const layout = wrapText(text, font, rounded, maxLines);
    this.entries.set(key, { text, font, maxWidth: rounded, maxLines, layout });
    return layout;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Module-level cache shared by the renderer (and resettable in tests). */
export const textLayoutCache = new TextLayoutCache();

/**
 * Memoised `ellipsize` for the low-zoom title labels.
 *
 * Unlike body text, the title of an off-screen-tier window is measured against
 * a *screen-space* width — which changes on every wheel tick but stays constant
 * while panning or dragging, when the label is still painted every frame. A
 * small LRU keyed by (text, font, rounded width) keeps that path measure-free
 * without touching the per-node body cache.
 *
 * Bounded deliberately: the key space is every visible title at every integer
 * zoom step, which is tiny, and an unbounded map on an adversarial graph would
 * be a leak.
 */
const TITLE_LABEL_CACHE_LIMIT = 512;
const titleLabelCache = new Map<string, string>();

export function ellipsizeCached(text: string, font: string, maxWidth: number): string {
  // Half-pixel buckets: the same quantisation the layout cache uses, so a
  // fractional pan offset cannot create a key per frame.
  const width = Math.max(1, Math.round(maxWidth * 2) / 2);
  const key = `${font}\u0000${width}\u0000${text}`;
  const hit = titleLabelCache.get(key);
  if (hit !== undefined) {
    // Refresh recency: Map preserves insertion order, so re-inserting is an LRU touch.
    titleLabelCache.delete(key);
    titleLabelCache.set(key, hit);
    return hit;
  }
  const label = ellipsize(text, font, width);
  titleLabelCache.set(key, label);
  if (titleLabelCache.size > TITLE_LABEL_CACHE_LIMIT) {
    const oldest = titleLabelCache.keys().next();
    if (!oldest.done) titleLabelCache.delete(oldest.value);
  }
  return label;
}

/** Test hook: drops every memoised title label. */
export function clearTitleLabelCache(): void {
  titleLabelCache.clear();
}
