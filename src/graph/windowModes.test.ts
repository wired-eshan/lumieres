import { describe, expect, it } from 'vitest';
import {
  appendChatMessage,
  createEmptyDocument,
  evaluateSourceReference,
  getNode,
  getNodeRect,
  resizeNode,
  setNodeKind,
  updateNodeContent,
} from './graphOperations';
import { useGraphStore } from './graphStore';
import { isValidGraph } from './graphValidation';
import {
  AI_NODE_HEIGHT,
  AI_NODE_WIDTH,
  MAX_NODE_WIDTH,
  MIN_NODE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
} from './metrics';
import type { ChatMessage, GraphDocument } from './types';

function aiDocument(): { doc: GraphDocument; nodeId: string } {
  const base = createEmptyDocument('Modes');
  const nodeId = base.rootNodeId;
  const result = setNodeKind(base, nodeId, 'ai');
  if (!result.ok) throw new Error(result.message);
  return { doc: result.value.doc, nodeId };
}

function message(content: string, role: 'user' | 'assistant' = 'user', id = 'm1'): ChatMessage {
  return { id, role, content, createdAt: 1000 };
}

describe('window modes', () => {
  it('switches a note to AI and back without losing note content or chat', () => {
    let doc = createEmptyDocument('Modes');
    const nodeId = doc.rootNodeId;
    const withContent = updateNodeContent(doc, nodeId, 'editable context');
    if (!withContent.ok) throw new Error(withContent.message);
    doc = withContent.value.doc;

    const toAi = setNodeKind(doc, nodeId, 'ai');
    if (!toAi.ok) throw new Error(toAi.message);
    doc = toAi.value.doc;
    expect(getNode(doc, nodeId)?.kind).toBe('ai');
    expect(getNode(doc, nodeId)?.content).toBe('editable context');
    // A window still at the default note size grows to the chat default.
    expect(getNode(doc, nodeId)?.size).toEqual({ width: AI_NODE_WIDTH, height: AI_NODE_HEIGHT });

    const chat = appendChatMessage(doc, nodeId, message('hello'));
    if (!chat.ok) throw new Error(chat.message);
    doc = chat.value.doc;

    const toNote = setNodeKind(doc, nodeId, 'note');
    if (!toNote.ok) throw new Error(toNote.message);
    doc = toNote.value.doc;
    expect(getNode(doc, nodeId)?.kind).toBe('note');
    expect(getNode(doc, nodeId)?.content).toBe('editable context');
    expect(getNode(doc, nodeId)?.chat).toHaveLength(1);
    expect(isValidGraph(doc)).toBe(true);
  });

  it('leaves a user-chosen size alone when toggling modes', () => {
    const { doc, nodeId } = aiDocument();
    const resized = resizeNode(doc, nodeId, { width: 600, height: 500 });
    if (!resized.ok) throw new Error(resized.message);

    const note = setNodeKind(resized.value.doc, nodeId, 'note');
    if (!note.ok) throw new Error(note.message);
    expect(getNode(note.value.doc, nodeId)?.size).toEqual({ width: 600, height: 500 });
    expect(getNode(note.value.doc, nodeId)?.size).not.toEqual({ width: NODE_WIDTH, height: NODE_HEIGHT });
  });
});

describe('resizing', () => {
  it('clamps to the supported range and updates the rect', () => {
    const doc = createEmptyDocument('Resize');
    const nodeId = doc.rootNodeId;

    const tiny = resizeNode(doc, nodeId, { width: 10, height: 10 });
    if (!tiny.ok) throw new Error(tiny.message);
    expect(getNode(tiny.value.doc, nodeId)?.size.width).toBe(MIN_NODE_WIDTH);
    expect(getNodeRect(tiny.value.node).width).toBe(MIN_NODE_WIDTH);

    const huge = resizeNode(tiny.value.doc, nodeId, { width: 5000, height: 5000 });
    if (!huge.ok) throw new Error(huge.message);
    expect(getNode(huge.value.doc, nodeId)?.size.width).toBe(MAX_NODE_WIDTH);
  });

  it('rejects non-finite sizes', () => {
    const doc = createEmptyDocument();
    const result = resizeNode(doc, doc.rootNodeId, { width: Number.NaN, height: 300 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_SIZE');
  });

  it('persists height independently of collapse', () => {
    let doc = createEmptyDocument();
    const nodeId = doc.rootNodeId;
    const resized = resizeNode(doc, nodeId, { width: 500, height: 640 });
    if (!resized.ok) throw new Error(resized.message);
    doc = resized.value.doc;
    expect(getNode(doc, nodeId)?.size.height).toBe(640);
    expect(getNodeRect(getNode(doc, nodeId)!).height).toBe(640);
  });
});

describe('window mode and size history', () => {
  it('undoes and redoes a mode switch and a resize', () => {
    const doc = createEmptyDocument('Undo');
    const rootId = doc.rootNodeId;
    useGraphStore.getState().replaceDocument(doc, { resetHistory: true });

    useGraphStore.getState().setNodeKind(rootId, 'ai');
    useGraphStore.getState().resizeNode(rootId, { width: 600, height: 500 });
    expect(getNode(useGraphStore.getState().doc, rootId)?.kind).toBe('ai');
    expect(getNode(useGraphStore.getState().doc, rootId)?.size).toEqual({ width: 600, height: 500 });

    useGraphStore.getState().undo();
    expect(getNode(useGraphStore.getState().doc, rootId)?.size).toEqual({
      width: AI_NODE_WIDTH,
      height: AI_NODE_HEIGHT,
    });
    useGraphStore.getState().undo();
    expect(getNode(useGraphStore.getState().doc, rootId)?.kind).toBe('note');
    expect(getNode(useGraphStore.getState().doc, rootId)?.size).toEqual({
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    });

    useGraphStore.getState().redo();
    useGraphStore.getState().redo();
    expect(getNode(useGraphStore.getState().doc, rootId)?.kind).toBe('ai');
    expect(getNode(useGraphStore.getState().doc, rootId)?.size).toEqual({ width: 600, height: 500 });
  });
});

describe('chat messages in the document', () => {
  it('appends turns and enforces the per-message limit', () => {
    const { doc, nodeId } = aiDocument();
    const first = appendChatMessage(doc, nodeId, message('hi'));
    if (!first.ok) throw new Error(first.message);
    expect(getNode(first.value.doc, nodeId)?.chat.map((turn) => turn.content)).toEqual(['hi']);

    const tooLong = appendChatMessage(
      first.value.doc,
      nodeId,
      message('x'.repeat(20_001), 'user', 'm2'),
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.code).toBe('CONTENT_LIMIT_EXCEEDED');
  });

  it('rejects duplicate message ids', () => {
    const { doc, nodeId } = aiDocument();
    const first = appendChatMessage(doc, nodeId, message('hi'));
    if (!first.ok) throw new Error(first.message);
    const duplicate = appendChatMessage(first.value.doc, nodeId, message('again'));
    expect(duplicate.ok).toBe(false);
  });
});

describe('source references into an AI message', () => {
  it('validates against the named message and reports staleness', () => {
    const { doc, nodeId } = aiDocument();
    const appended = appendChatMessage(doc, nodeId, message('Alpha beta gamma', 'assistant', 'm1'));
    if (!appended.ok) throw new Error(appended.message);
    let current = appended.value.doc;

    const reference = {
      sourceNodeId: nodeId,
      sourceMessageId: 'm1',
      selectedTextSnapshot: 'beta',
      startOffset: 6,
      endOffset: 10,
      sourceContentVersion: getNode(current, nodeId)?.contentVersion ?? 1,
    };
    const child = {
      ...getNode(current, nodeId)!,
      id: 'child',
      parentId: nodeId,
      sourceReference: reference,
    };
    current = {
      ...current,
      nodes: {
        ...current.nodes,
        [nodeId]: { ...getNode(current, nodeId)! },
        child,
      },
      edges: { ...current.edges, [`e:${nodeId}->child`]: { id: `e:${nodeId}->child`, sourceNodeId: nodeId, targetNodeId: 'child' } },
    };

    expect(evaluateSourceReference(current, child).status).toBe('valid');

    // The message is immutable in normal use; simulate an edit to prove the
    // reference is checked against the message, not against the note body.
    const editedSource = {
      ...getNode(current, nodeId)!,
      chat: [{ ...message('Alpha BETA gamma', 'assistant', 'm1') }],
    };
    const edited: GraphDocument = { ...current, nodes: { ...current.nodes, [nodeId]: editedSource } };
    expect(evaluateSourceReference(edited, child).status).toBe('stale');
    expect(getNode(edited, nodeId)?.chat[0]?.content).toBe('Alpha BETA gamma');
    expect(child.sourceReference.selectedTextSnapshot).toBe('beta');
  });

  it('reports stale when the referenced message disappears', () => {
    const { doc, nodeId } = aiDocument();
    const appended = appendChatMessage(doc, nodeId, message('hello', 'assistant', 'm1'));
    if (!appended.ok) throw new Error(appended.message);
    const source = getNode(appended.value.doc, nodeId)!;
    const reference = {
      sourceNodeId: nodeId,
      sourceMessageId: 'm1',
      selectedTextSnapshot: 'hello',
      startOffset: 0,
      endOffset: 5,
      sourceContentVersion: 1,
    };
    // The source node itself no longer contains the referenced message.
    const withoutMessage: GraphDocument = {
      ...appended.value.doc,
      nodes: {
        ...appended.value.doc.nodes,
        [nodeId]: { ...source, chat: [] },
      },
    };
    const branch = { ...source, sourceReference: reference };
    const result = evaluateSourceReference(withoutMessage, branch);
    expect(result.status).toBe('stale');
    expect(result.currentText).toBeNull();
  });
});
