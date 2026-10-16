import { describe, expect, it } from 'vitest';
import { CHARACTER_LIMIT, applyTextEdit, limitMessage, limitStatus } from './characterLimit';

const LIMIT = 20;

describe('applyTextEdit', () => {
  it('accepts anything within the limit', () => {
    const result = applyTextEdit('hello', 'hello world', LIMIT);
    expect(result.value).toBe('hello world');
    expect(result.limited).toBe(false);
    expect(result.caret).toBe(11);
  });

  it('trims a paste to the space actually left', () => {
    const previous = 'a'.repeat(15);
    const paste = 'b'.repeat(50);
    const result = applyTextEdit(previous, previous + paste, LIMIT);

    expect(result.limited).toBe(true);
    expect(result.rejected).toBe(false);
    expect(result.value).toBe('a'.repeat(15) + 'b'.repeat(5));
    expect(result.value.length).toBe(LIMIT);
    expect(result.droppedCharacters).toBe(45);
    expect(result.caret).toBe(LIMIT);
  });

  it('preserves surrounding text when trimming a paste in the middle', () => {
    const previous = 'start-END';
    const next = `start-${'x'.repeat(40)}-END`;
    const result = applyTextEdit(previous, next, LIMIT);

    // The change is recovered as a maximal common prefix ("start-"), an
    // insertion, and a common suffix ("END"); only the insertion is trimmed, and
    // the eleven characters that fit are kept in place.
    expect(result.value).toBe(`start-${'x'.repeat(11)}END`);
    expect(result.value.length).toBe(LIMIT);
    expect(result.droppedCharacters).toBe(30);
  });

  it('refuses further insertions once the limit is reached', () => {
    const full = 'z'.repeat(LIMIT);
    const result = applyTextEdit(full, full + 'more', LIMIT);
    expect(result.rejected).toBe(true);
    expect(result.value).toBe(full);
    expect(result.caret).toBe(LIMIT);
  });

  it('reports the caret the editing surface ended up with, not the end of the text', () => {
    // "hello world" with the caret after "hello" — typing or backspacing in the
    // middle of a note must not move the caret to the end.
    const result = applyTextEdit('hello world', 'hello  world', LIMIT, 6);
    expect(result.value).toBe('hello  world');
    expect(result.caret).toBe(6);
  });

  it('keeps a refused insertion at the point it was attempted', () => {
    const full = 'z'.repeat(LIMIT);
    const attempted = `${full.slice(0, 4)}x${full.slice(4)}`;
    const result = applyTextEdit(full, attempted, LIMIT);

    expect(result.rejected).toBe(true);
    expect(result.value).toBe(full);
    // Offset 4, where the insertion was tried — not the end of the note.
    expect(result.caret).toBe(4);
  });

  it('never truncates existing over-limit content', () => {
    const overLimit = 'y'.repeat(LIMIT + 30);
    const result = applyTextEdit(overLimit, overLimit, LIMIT);
    expect(result.value).toBe(overLimit);
    expect(result.value.length).toBe(LIMIT + 30);
  });

  it('accepts deletions that bring content back under the limit', () => {
    const overLimit = 'y'.repeat(LIMIT + 5);
    const shorter = overLimit.slice(0, LIMIT - 2);
    const result = applyTextEdit(overLimit, shorter, LIMIT);
    expect(result.value).toBe(shorter);
    expect(result.limited).toBe(false);
  });

  it('treats a replacement of equal length as allowed', () => {
    const result = applyTextEdit('a'.repeat(LIMIT), `${'a'.repeat(LIMIT - 1)}b`, LIMIT);
    expect(result.value.length).toBe(LIMIT);
    expect(result.value.endsWith('b')).toBe(true);
    expect(result.limited).toBe(false);
  });

  it('uses the documented 20,000-character limit by default', () => {
    expect(CHARACTER_LIMIT).toBe(20_000);
    const atLimit = 'a'.repeat(CHARACTER_LIMIT);
    expect(applyTextEdit('', atLimit, CHARACTER_LIMIT).limited).toBe(false);
    expect(applyTextEdit(atLimit, `${atLimit}b`).rejected).toBe(true);
  });

  it('counts UTF-16 code units, matching selection offsets', () => {
    // An emoji is two code units, so the limit counts it as two — the same
    // convention the textarea and the source-reference offsets use.
    const emoji = '😀';
    expect(emoji.length).toBe(2);
    const result = applyTextEdit('', emoji.repeat(3), 4);
    expect(result.value).toBe(emoji.repeat(2));
    expect(result.value.length).toBe(4);
  });
});

describe('limitStatus', () => {
  it('reports levels used by the counter', () => {
    expect(limitStatus('', 100).level).toBe('normal');
    expect(limitStatus('a'.repeat(90), 100).level).toBe('warning');
    expect(limitStatus('a'.repeat(100), 100).level).toBe('full');
    expect(limitStatus('a'.repeat(101), 100).level).toBe('over');
  });

  it('explains an over-limit note without implying data loss', () => {
    const message = limitMessage(limitStatus('a'.repeat(105), 100));
    expect(message).toContain('kept intact');
  });

  it('has no message while there is room to spare', () => {
    expect(limitMessage(limitStatus('short', 100))).toBeNull();
  });
});
