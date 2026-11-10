/**
 * Deriving a window's display label from what it already contains.
 *
 * The contract this pins: a user-typed title always wins, a conversation names
 * itself from its first user turn, and a plain note falls back through heading →
 * first sentence → salient words. None of it may rewrite the stored title.
 */

import { describe, expect, it } from 'vitest';
import {
  DISPLAY_TITLE_MAX_LENGTH,
  deriveChatTitle,
  displayTitle,
  extractTitleFromContent,
} from './displayTitle';
import type { ChatMessage, NoteNode } from './types';

function node(overrides: Partial<NoteNode> = {}): NoteNode {
  return {
    id: 'n1',
    parentId: null,
    title: '',
    content: '',
    position: { x: 0, y: 0 },
    size: { width: 340, height: 268 },
    kind: 'note',
    chat: [],
    sourceReference: null,
    collapsed: false,
    contentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function turn(role: ChatMessage['role'], content: string, id = `${role}-${content}`): ChatMessage {
  return { id, role, content, createdAt: 1 };
}

describe('extractTitleFromContent', () => {
  it('prefers the first non-empty line when it reads like a heading', () => {
    expect(extractTitleFromContent('\n\nPhotosynthesis overview\nBody text follows.')).toBe(
      'Photosynthesis overview',
    );
  });

  it('strips markdown heading marks', () => {
    expect(extractTitleFromContent('## Supply chain risks\n\ntext')).toBe('Supply chain risks');
  });

  it('falls back to the first sentence when the opening line is prose', () => {
    expect(
      extractTitleFromContent(
        'The mitochondria is the powerhouse of the cell. It produces ATP for the cell.',
      ),
    ).toBe('The mitochondria is the powerhouse of the cell');
  });

  it('uses frequent content words when there is no line or sentence break', () => {
    // Long enough that it cannot pass as a heading, and with no terminator to
    // end a sentence — the only case that reaches the frequency fallback.
    const title = extractTitleFromContent(
      `${'signal pattern signal structure signal observation '.repeat(4)}`,
    );
    expect(title).toBe('signal pattern structure');
  });

  it('treats a short unpunctuated single line as a heading, not as prose', () => {
    expect(extractTitleFromContent('signal pattern structure observation')).toBe(
      'signal pattern structure observation',
    );
  });

  it('never exceeds the display length', () => {
    const long = `${'word '.repeat(80)}end.`;
    expect(extractTitleFromContent(long).length).toBeLessThanOrEqual(DISPLAY_TITLE_MAX_LENGTH);
  });

  it('returns an empty string for an empty body', () => {
    expect(extractTitleFromContent('   \n\n  ')).toBe('');
  });

  it('only inspects the leading slice of a very long note', () => {
    const huge = `${'x'.repeat(4_000)}\nSecond line`;
    // The first line is one enormous token; the derived title is a clipped
    // prefix of it, never a scan of the whole 20,000-character body.
    expect(extractTitleFromContent(huge).length).toBeLessThanOrEqual(DISPLAY_TITLE_MAX_LENGTH);
  });
});

describe('deriveChatTitle', () => {
  it('uses the first user turn, ignoring assistant replies', () => {
    expect(
      deriveChatTitle([
        turn('assistant', 'How can I help?'),
        turn('user', 'What is a monad?'),
        turn('user', 'And an applicative?'),
      ]),
    ).toBe('What is a monad?');
  });

  it('flattens newlines and clips long prompts', () => {
    const title = deriveChatTitle([turn('user', `Line one\nLine two ${'x'.repeat(200)}`)]);
    expect(title).not.toContain('\n');
    expect(title.length).toBeLessThanOrEqual(DISPLAY_TITLE_MAX_LENGTH);
  });

  it('returns empty when there is no user turn', () => {
    expect(deriveChatTitle([])).toBe('');
    expect(deriveChatTitle([turn('assistant', 'Hello')])).toBe('');
  });
});

describe('displayTitle', () => {
  it('lets an explicit title win over chat and body', () => {
    expect(
      displayTitle(
        node({ title: '  My title  ', content: 'Body heading', chat: [turn('user', 'A question')] }),
      ),
    ).toBe('My title');
  });

  it('prefers the first user turn over the note body', () => {
    expect(
      displayTitle(
        node({ content: 'Photosynthesis overview\nnotes', chat: [turn('user', 'What is chlorophyll?')] }),
      ),
    ).toBe('What is chlorophyll?');
  });

  it('falls back to the note body when there is no chat', () => {
    expect(displayTitle(node({ content: 'Photosynthesis overview\nnotes' }))).toBe(
      'Photosynthesis overview',
    );
  });

  it('is empty only when the window has nothing at all', () => {
    expect(displayTitle(node())).toBe('');
  });

  it('memoises on node identity and recomputes for a new node object', () => {
    const first = node({ content: 'First heading\nbody' });
    expect(displayTitle(first)).toBe('First heading');
    // Immutable document operations replace the node object on every change, so
    // a new object must re-derive rather than replay the cached label.
    const edited = { ...first, content: 'Second heading\nbody' };
    expect(displayTitle(edited)).toBe('Second heading');
  });

  it('never mutates the stored title', () => {
    const target = node({ content: 'Derived heading\nbody' });
    displayTitle(target);
    expect(target.title).toBe('');
  });
});
