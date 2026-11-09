/**
 * Which source ranges a window should paint as "this is where my branches came
 * from".
 *
 * Both the canvas renderer and the AI chat panel read this, so the tricky cases
 * are pinned here: a reference recorded against a *message* must never be read
 * as a body range, offsets must be checked against the live text (stale
 * references are not painted), and a child reparented elsewhere must not paint
 * on its old source.
 */

import { describe, expect, it } from 'vitest';
import {
  appendChatMessage,
  createBranch,
  createEmptyDocument,
  updateNodeContent,
} from './graphOperations';
import { collectBodySourceRanges, collectMessageSourceRanges } from './sourceHighlights';
import type { ChatMessage, GraphDocument, SourceReference } from './types';

function noteWithContent(content: string): GraphDocument {
  const doc = createEmptyDocument('Highlights');
  const result = updateNodeContent(doc, doc.rootNodeId, content);
  if (!result.ok) throw new Error(result.message);
  return result.value.doc;
}

function branchFrom(
  doc: GraphDocument,
  parentId: string,
  reference: SourceReference,
  position = { x: 400, y: 0 },
): GraphDocument {
  const result = createBranch(doc, {
    parentId,
    position,
    sourceReference: reference,
  });
  if (!result.ok) throw new Error(result.message);
  return result.value.doc;
}

function reference(overrides: Partial<SourceReference> & { sourceNodeId: string }): SourceReference {
  return {
    selectedTextSnapshot: 'selected phrase',
    startOffset: 0,
    endOffset: 'selected phrase'.length,
    sourceContentVersion: 1,
    ...overrides,
  };
}

describe('collectBodySourceRanges', () => {
  it('returns the range a child branch was created from', () => {
    const content = 'alpha selected phrase omega';
    const doc = noteWithContent(content);
    const rootId = doc.rootNodeId;
    const start = content.indexOf('selected phrase');
    const branched = branchFrom(doc, rootId, reference({
      sourceNodeId: rootId,
      startOffset: start,
      endOffset: start + 'selected phrase'.length,
    }));

    expect(collectBodySourceRanges(branched, rootId)).toEqual([
      { start, end: start + 'selected phrase'.length },
    ]);
  });

  it('collects every phrase a window seeded, from different children', () => {
    const content = 'alpha beta gamma';
    let doc = noteWithContent(content);
    const rootId = doc.rootNodeId;
    doc = branchFrom(doc, rootId, reference({
      sourceNodeId: rootId, startOffset: 0, endOffset: 5, selectedTextSnapshot: 'alpha',
    }), { x: 400, y: 0 });
    doc = branchFrom(doc, rootId, reference({
      sourceNodeId: rootId, startOffset: 11, endOffset: 16, selectedTextSnapshot: 'gamma',
    }), { x: 400, y: 300 });

    expect(collectBodySourceRanges(doc, rootId)).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
    ]);
  });

  it('skips a reference whose text no longer matches (stale)', () => {
    const content = 'alpha selected phrase omega';
    let doc = noteWithContent(content);
    const rootId = doc.rootNodeId;
    const start = content.indexOf('selected phrase');
    doc = branchFrom(doc, rootId, reference({
      sourceNodeId: rootId, startOffset: start, endOffset: start + 15,
    }));

    // Editing the note moves the text out from under the recorded offsets.
    const edited = updateNodeContent(doc, rootId, 'completely rewritten note body');
    if (!edited.ok) throw new Error(edited.message);

    expect(collectBodySourceRanges(edited.value.doc, rootId)).toEqual([]);
  });

  it('never returns ranges recorded against an AI message', () => {
    // A branch made from a reply belongs to the chat renderer, not the body.
    let doc = noteWithContent('note body text');
    const rootId = doc.rootNodeId;
    const chat = appendChatMessage(doc, rootId, {
      id: 'm1', role: 'assistant', content: 'a reply with selected phrase', createdAt: 1,
    } satisfies ChatMessage);
    if (!chat.ok) throw new Error(chat.message);
    doc = chat.value.doc;

    const start = 'a reply with '.length;
    doc = branchFrom(doc, rootId, reference({
      sourceNodeId: rootId,
      sourceMessageId: 'm1',
      startOffset: start,
      endOffset: start + 15,
      selectedTextSnapshot: 'selected phrase',
    }));

    expect(collectBodySourceRanges(doc, rootId)).toEqual([]);
    const byMessage = collectMessageSourceRanges(doc, rootId);
    expect(byMessage.get('m1')).toEqual([{ start, end: start + 15 }]);
  });

  it('ignores a reference that points at a different window', () => {
    // A reparented child keeps its original source reference; its offsets index
    // the window it came from, so they must not paint on the new parent.
    const doc = noteWithContent('unrelated window text');
    const rootId = doc.rootNodeId;
    const child = createBranch(doc, {
      parentId: rootId,
      position: { x: 400, y: 0 },
      sourceReference: reference({ sourceNodeId: 'some-other-node' }),
    });
    if (!child.ok) throw new Error(child.message);

    expect(collectBodySourceRanges(child.value.doc, rootId)).toEqual([]);
  });
});

describe('collectMessageSourceRanges', () => {
  it('keys ranges by message and supports several branches per message', () => {
    let doc = noteWithContent('body');
    const rootId = doc.rootNodeId;
    const reply = 'alpha beta gamma';
    const chat = appendChatMessage(doc, rootId, {
      id: 'm1', role: 'assistant', content: reply, createdAt: 1,
    } satisfies ChatMessage);
    if (!chat.ok) throw new Error(chat.message);
    doc = chat.value.doc;

    doc = branchFrom(doc, rootId, reference({
      sourceNodeId: rootId, sourceMessageId: 'm1',
      startOffset: 0, endOffset: 5, selectedTextSnapshot: 'alpha',
    }), { x: 400, y: 0 });
    doc = branchFrom(doc, rootId, reference({
      sourceNodeId: rootId, sourceMessageId: 'm1',
      startOffset: 11, endOffset: 16, selectedTextSnapshot: 'gamma',
    }), { x: 400, y: 300 });

    const ranges = collectMessageSourceRanges(doc, rootId);
    expect(ranges.get('m1')).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
    ]);
  });

  it('does not attribute another window\'s message id to this window', () => {
    // Regression: comparing a message id to a *node* id meant this lookup never
    // matched, so branches made from a reply were never highlighted at all.
    let doc = noteWithContent('body');
    const rootId = doc.rootNodeId;
    const chat = appendChatMessage(doc, rootId, {
      id: 'm1', role: 'assistant', content: 'a reply', createdAt: 1,
    } satisfies ChatMessage);
    if (!chat.ok) throw new Error(chat.message);
    doc = chat.value.doc;
    doc = branchFrom(doc, rootId, reference({
      sourceNodeId: rootId, sourceMessageId: 'm1',
      startOffset: 0, endOffset: 1, selectedTextSnapshot: 'a',
    }));

    const child = Object.values(doc.nodes).find((node) => node.parentId === rootId);
    expect(child).toBeDefined();
    expect(collectMessageSourceRanges(doc, child?.id ?? '')).toEqual(new Map());
    expect(collectMessageSourceRanges(doc, rootId).get('m1')).toHaveLength(1);
  });
});
