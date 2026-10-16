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
  if (!ctx) return { lines: text.split('\n').slice(0, maxLines), clipped: false };
  ctx.font = font;

  const lines: string[] = [];
  const paragraphs = text.split('\n');
  let clipped = false;

  for (let p = 0; p < paragraphs.length; p += 1) {
    const paragraph = paragraphs[p] ?? '';
    if (lines.length >= maxLines) {
      clipped = true;
      break;
    }
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    const words = paragraph.split(/(\s+)/).filter((token) => token.length > 0);
    let current = '';
    for (const word of words) {
      const candidate = current + word;
      if (ctx.measureText(candidate).width <= maxWidth || current.length === 0) {
        if (current.length === 0 && ctx.measureText(word).width > maxWidth) {
          // A single token wider than the line: hard-break it by characters.
          let chunk = '';
          for (const char of word) {
            if (ctx.measureText(chunk + char).width > maxWidth && chunk.length > 0) {
              if (lines.length >= maxLines) {
                clipped = true;
                break;
              }
              lines.push(chunk);
              chunk = char;
            } else {
              chunk += char;
            }
          }
          current = chunk;
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
        current = word.trimStart();
      }
    }
    if (clipped) break;
    if (current.length > 0) {
      if (lines.length >= maxLines) {
        clipped = true;
        break;
      }
      lines.push(current.trimEnd());
    }
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
    clipped = true;
  }
  return { lines, clipped };
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
