/**
 * Character-limit enforcement for note bodies.
 *
 * Counting convention: JavaScript `String.prototype.length`, i.e. UTF-16 code
 * units. The same convention is used for selection offsets and the stored
 * `contentVersion`, so a selection range and the limit can never disagree.
 *
 * The limit is enforced against the *result* of an edit rather than by blocking
 * keystrokes, which means a paste that would overflow is trimmed to the space
 * actually left instead of being swallowed whole. Existing over-limit content is
 * never truncated here — see `applyTextEdit`'s contract and
 * `graphValidation.validateGraph`, which reports over-limit notes on load.
 */

import { MAX_NODE_CONTENT_LENGTH } from '../graph/types';

export const CHARACTER_LIMIT = MAX_NODE_CONTENT_LENGTH;

export interface TextEditResult {
  /** Value the editor should now hold (never longer than the limit). */
  value: string;
  /** True when content had to be trimmed to fit. */
  limited: boolean;
  /** True when nothing could be added at all. */
  rejected: boolean;
  /** Caret position after the edit, in UTF-16 code units. */
  caret: number;
  /** How many characters were dropped, for a precise message. */
  droppedCharacters: number;
}

/**
 * Resolves a proposed `next` value against `previous`, enforcing `limit`.
 *
 * The incoming change is recovered as (common prefix, inserted middle, common
 * suffix) so a paste can be trimmed to the remaining budget while the text
 * around it is preserved exactly.
 *
 * `caretInNext` is where the editing surface put the caret after the browser
 * applied the change. It is reported back untouched for accepted edits — the
 * caller must not reposition the caret then, because the browser already placed
 * it where the user expects (typing mid-text, backspace, delete, IME, paste).
 */
export function applyTextEdit(
  previous: string,
  next: string,
  limit: number = CHARACTER_LIMIT,
  caretInNext: number = next.length,
): TextEditResult {
  if (next.length <= limit) {
    return {
      value: next,
      limited: false,
      rejected: false,
      caret: clampCaret(caretInNext, next.length),
      droppedCharacters: 0,
    };
  }

  if (previous.length >= limit) {
    // Already at (or above) the ceiling: refuse the insertion outright rather
    // than silently reshaping existing content. The caret stays at the point the
    // insertion was attempted — the text around it is untouched, so jumping to
    // the end of the note would be a gratuitous move.
    const { prefix } = commonAffixes(previous, next);
    return {
      value: previous,
      limited: true,
      rejected: true,
      caret: prefix,
      droppedCharacters: next.length - previous.length,
    };
  }

  const { prefix, suffix } = commonAffixes(previous, next);
  const inserted = next.slice(prefix, next.length - suffix);
  const removed = previous.slice(prefix, previous.length - suffix);
  const budget = limit - (previous.length - removed.length);
  const keptInserted = budget > 0 ? inserted.slice(0, budget) : '';
  const value = previous.slice(0, prefix) + keptInserted + previous.slice(previous.length - suffix);

  return {
    value,
    limited: true,
    rejected: keptInserted.length === 0,
    caret: prefix + keptInserted.length,
    droppedCharacters: inserted.length - keptInserted.length,
  };
}

function clampCaret(caret: number, length: number): number {
  if (!Number.isFinite(caret)) return length;
  return Math.max(0, Math.min(Math.trunc(caret), length));
}

function commonAffixes(previous: string, next: string): { prefix: number; suffix: number } {
  const maxPrefix = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < maxPrefix && previous[prefix] === next[prefix]) prefix += 1;

  const maxSuffix = Math.min(previous.length, next.length) - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, suffix };
}

export interface LimitStatus {
  used: number;
  limit: number;
  remaining: number;
  ratio: number;
  level: 'normal' | 'warning' | 'full' | 'over';
}

export function limitStatus(content: string, limit: number = CHARACTER_LIMIT): LimitStatus {
  const used = content.length;
  const ratio = limit === 0 ? 1 : used / limit;
  let level: LimitStatus['level'] = 'normal';
  if (used > limit) level = 'over';
  else if (used >= limit) level = 'full';
  else if (ratio >= 0.9) level = 'warning';
  return { used, limit, remaining: Math.max(0, limit - used), ratio, level };
}

export function limitMessage(status: LimitStatus): string | null {
  switch (status.level) {
    case 'over':
      return `This note holds ${status.used.toLocaleString('en-US')} characters — ${(status.used - status.limit).toLocaleString('en-US')} over the limit. It is kept intact; trim it before adding more.`;
    case 'full':
      return 'Character limit reached. Delete some text to keep writing.';
    case 'warning':
      return `${status.remaining.toLocaleString('en-US')} characters remaining.`;
    default:
      return null;
  }
}
