import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { CanvasEngine } from '../canvas/engine';
import { graphController } from '../graph/graphController';
import { useGraphStore } from '../graph/graphStore';
import {
  appendChatMessage,
  createEmptyDocument,
  evaluateSourceReference,
  getChildren,
  getNode,
  resizeNode,
  setNodeKind,
} from '../graph/graphOperations';
import { isValidGraph, validateGraph } from '../graph/graphValidation';
import { createAutosave } from '../persistence/autosave';
import { createDocumentRepository, type RepositoryKind } from '../persistence/documentRepository';
import { MAX_CHILDREN_PER_NODE } from '../graph/types';

/**
 * End-to-end workflow through the real stores, controller, engine and
 * persistence layer — the exact path the UI drives:
 *
 *   type content → highlight a phrase → create a child branch → edit the child
 *   → create a grandchild → move nodes → reload → verify the graph came back.
 *
 * Only the DOM text-measurement step is replaced (jsdom has no layout engine):
 * the selection offsets are supplied directly, exactly as the editor would.
 */
function setupEngine(): CanvasEngine {
  const doc = createEmptyDocument('Workflow');
  useGraphStore.getState().replaceDocument(doc, { resetHistory: true });
  useGraphStore.getState().setSaveStatus('idle');

  const engine = new CanvasEngine(graphController);
  const unsubscribe = graphController.subscribe((nextDoc, change) => engine.setDocument(nextDoc, change));
  engine.destroy = engine.destroy.bind(engine);
  cleanup.push(unsubscribe, () => engine.destroy());
  return engine;
}

const cleanup: Array<() => void> = [];

/** Simulates the open editor: draft text, then commit it like the debounce does. */
function typeInto(engine: CanvasEngine, nodeId: string, content: string): void {
  engine.setDraft(nodeId, content);
  engine.flushDraft();
}

function select(engine: CanvasEngine, nodeId: string, needle: string): void {
  const node = getNode(engine.doc, nodeId);
  if (!node) throw new Error('node missing');
  const start = node.content.indexOf(needle);
  if (start === -1) throw new Error(`"${needle}" is not in the note`);
  engine.setBranchAction({
    nodeId,
    text: needle,
    start,
    end: start + needle.length,
    anchor: { x: node.position.x + 100, y: node.position.y + 200 },
  });
}

describe('the branching workflow, end to end', () => {
  let engine: CanvasEngine;
  let repositoryKind: RepositoryKind;

  beforeEach(() => {
    while (cleanup.length > 0) cleanup.pop()?.();
    engine = setupEngine();
    repositoryKind = 'memory';
  });

  it('runs the whole flow and restores it after a reload', async () => {
    const rootId = engine.doc.rootNodeId;

    // 1. Write content into the root note.
    const rootText = 'Photosynthesis converts light into chemical energy stored in glucose.';
    typeInto(engine, rootId, rootText);
    expect(getNode(engine.doc, rootId)?.content).toBe(rootText);

    // 2. Highlight a phrase and branch.
    select(engine, rootId, 'chemical energy');
    const childId = engine.createBranchFromSelection();
    expect(childId).not.toBeNull();
    if (!childId) return;

    const child = getNode(engine.doc, childId);
    expect(child?.parentId).toBe(rootId);
    expect(child?.title).toBe('chemical energy');
    expect(child?.sourceReference).toEqual({
      sourceNodeId: rootId,
      selectedTextSnapshot: 'chemical energy',
      startOffset: rootText.indexOf('chemical energy'),
      endOffset: rootText.indexOf('chemical energy') + 'chemical energy'.length,
      sourceContentVersion: getNode(engine.doc, rootId)?.contentVersion,
    });
    // The source note is untouched.
    expect(getNode(engine.doc, rootId)?.content).toBe(rootText);

    // 3. The new window is focused and ready to type.
    expect(engine.getEditingId()).toBe(childId);
    expect(engine.getSelectedIds()).toEqual([childId]);
    // …and a repeated call cannot create a duplicate.
    expect(engine.createBranchFromSelection()).toBeNull();

    // 4. Edit the child.
    const childText = 'Chemical energy is stored in the bonds of glucose molecules.';
    typeInto(engine, childId, childText);
    expect(getNode(engine.doc, childId)?.content).toBe(childText);
    expect(getNode(engine.doc, childId)?.contentVersion).toBeGreaterThan(1);

    // 5. Branch again from the child, creating a grandchild.
    select(engine, childId, 'glucose molecules');
    const grandchildId = engine.createBranchFromSelection();
    expect(grandchildId).not.toBeNull();
    if (!grandchildId) return;

    const grandchild = getNode(engine.doc, grandchildId);
    expect(grandchild?.parentId).toBe(childId);
    expect(grandchild?.sourceReference?.sourceNodeId).toBe(childId);

    // 6. Move nodes around without touching relationships.
    const moved = graphController.moveNodes({
      [childId]: { x: 900, y: 120 },
      [grandchildId]: { x: 1500, y: -260 },
    });
    expect(moved.ok).toBe(true);
    expect(getNode(engine.doc, grandchildId)?.parentId).toBe(childId);
    expect(Object.keys(engine.doc.edges)).toHaveLength(2);

    // 7. Persist and reload.
    const repository = await createDocumentRepository({ databaseName: 'lumieres_workflow' });
    repositoryKind = repository.kind;
    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 5 });
    autosave.start();
    await autosave.flush();
    autosave.stop();

    const documentId = engine.doc.id;
    const loaded = await repository.load(documentId);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    // Simulate a refresh: a brand new engine over an empty store.
    useGraphStore.getState().replaceDocument(createEmptyDocument('scrap'), { resetHistory: true });
    const reloaded = new CanvasEngine(graphController);
    const unsubscribe = graphController.subscribe((nextDoc, change) => reloaded.setDocument(nextDoc, change));
    graphController.replaceDocument(loaded.doc, { resetHistory: true });
    reloaded.fitToView();

    // 8. Verify everything came back.
    expect(validateGraph(reloaded.doc)).toEqual([]);
    expect(isValidGraph(reloaded.doc)).toBe(true);
    expect(Object.keys(reloaded.doc.nodes)).toHaveLength(3);
    expect(Object.keys(reloaded.doc.edges)).toHaveLength(2);

    expect(getNode(reloaded.doc, rootId)?.content).toBe(rootText);
    expect(getNode(reloaded.doc, childId)?.content).toBe(childText);
    expect(getNode(reloaded.doc, childId)?.position).toEqual({ x: 900, y: 120 });
    expect(getNode(reloaded.doc, grandchildId)?.position).toEqual({ x: 1500, y: -260 });
    expect(getNode(reloaded.doc, grandchildId)?.parentId).toBe(childId);
    expect(getChildren(reloaded.doc, rootId).map((node) => node.id)).toEqual([childId]);

    const reference = getNode(reloaded.doc, grandchildId)?.sourceReference;
    expect(reference?.selectedTextSnapshot).toBe('glucose molecules');
    const restoredSource = getNode(reloaded.doc, reference?.sourceNodeId ?? '');
    expect(restoredSource?.content.slice(reference?.startOffset, reference?.endOffset)).toBe(
      'glucose molecules',
    );

    unsubscribe();
    reloaded.destroy();
    expect(repositoryKind).toBe('indexeddb');
  });

  it('marks a source reference stale without rewriting the branch', () => {
    const rootId = engine.doc.rootNodeId;
    typeInto(engine, rootId, 'Alpha beta gamma');
    select(engine, rootId, 'beta');
    const childId = engine.createBranchFromSelection();
    if (!childId) throw new Error('branch not created');

    typeInto(engine, rootId, 'Alpha BETA gamma');

    const child = getNode(engine.doc, childId);
    expect(child?.sourceReference?.selectedTextSnapshot).toBe('beta');
    // The branch's own content is untouched by the source edit.
    expect(child?.content).toBe('');
  });

  it('refuses the 51st branch from a note and says why', () => {
    const rootId = engine.doc.rootNodeId;
    for (let index = 0; index < MAX_CHILDREN_PER_NODE; index += 1) {
      const created = engine.createBranchFromNode(rootId);
      expect(created).not.toBeNull();
    }

    expect(getChildren(engine.doc, rootId)).toHaveLength(MAX_CHILDREN_PER_NODE);
    expect(engine.canBranch(rootId).allowed).toBe(false);

    const rejected = engine.createBranchFromNode(rootId);
    expect(rejected).toBeNull();
    expect(engine.getSnapshot().toast?.tone).toBe('error');
    expect(engine.getSnapshot().toast?.message).toContain('50');
    // The limit did not corrupt the graph.
    expect(validateGraph(engine.doc)).toEqual([]);
  });

  it('previews a subtree deletion, then applies and undoes it', () => {
    const rootId = engine.doc.rootNodeId;
    typeInto(engine, rootId, 'root');
    const childId = engine.createBranchFromNode(rootId);
    if (!childId) throw new Error('branch not created');
    typeInto(engine, childId, 'x'.repeat(400));
    const grandchildId = engine.createBranchFromNode(childId);
    if (!grandchildId) throw new Error('grandchild not created');

    engine.requestDelete([childId]);
    const pending = engine.getSnapshot().pendingAction;
    expect(pending?.kind).toBe('delete');
    if (pending?.kind !== 'delete') return;
    expect(pending.nodeCount).toBe(2);
    // Counts the whole subtree: the child's 400 characters plus the
    // grandchild's (empty) content.
    expect(pending.characterCount).toBe(400);

    engine.confirmPendingAction();
    expect(Object.keys(engine.doc.nodes)).toHaveLength(1);
    expect(Object.keys(engine.doc.edges)).toHaveLength(0);

    engine.undo();
    expect(Object.keys(engine.doc.nodes)).toHaveLength(3);
    expect(getNode(engine.doc, grandchildId)?.parentId).toBe(childId);
    expect(isValidGraph(engine.doc)).toBe(true);
  });

  it('routes undo and redo through the engine without losing text', () => {
    const rootId = engine.doc.rootNodeId;
    typeInto(engine, rootId, 'a version of the note');

    engine.undo();
    expect(getNode(engine.doc, rootId)?.content).toBe('');
    engine.redo();
    expect(getNode(engine.doc, rootId)?.content).toBe('a version of the note');
  });

  it('undoes a branch creation back to a single note', () => {
    const rootId = engine.doc.rootNodeId;
    const childId = engine.createBranchFromNode(rootId);
    if (!childId) throw new Error('branch not created');
    expect(Object.keys(engine.doc.nodes)).toHaveLength(2);

    engine.undo();
    expect(Object.keys(engine.doc.nodes)).toHaveLength(1);
    expect(Object.keys(engine.doc.edges)).toHaveLength(0);
    // The camera follows the undo target rather than leaving the view stranded.
    expect(engine.getSelectedIds()).toEqual([rootId]);
  });

  it('keeps the camera out of the document', () => {
    const rootId = engine.doc.rootNodeId;
    const before = { ...getNode(engine.doc, rootId)?.position };

    engine.zoomBy(1.6);
    engine.zoomBy(0.4);
    engine.panByScreen(400, -250);
    engine.resetZoom();
    engine.fitToView();

    expect(getNode(engine.doc, rootId)?.position).toEqual(before);
  });

  it('branches from a selection inside an AI reply and keeps the message reference', () => {
    const rootId = engine.doc.rootNodeId;
    const ai = setNodeKind(engine.doc, rootId, 'ai');
    if (!ai.ok) throw new Error(ai.message);
    useGraphStore.getState().replaceDocument(ai.value.doc, { resetHistory: true });

    const appended = appendChatMessage(
      useGraphStore.getState().doc,
      rootId,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'Alpha beta gamma',
        createdAt: 10,
      },
    );
    if (!appended.ok) throw new Error(appended.message);
    useGraphStore.getState().replaceDocument(appended.value.doc, { resetHistory: true });

    const node = getNode(engine.doc, rootId);
    if (!node) throw new Error('node missing');
    engine.setBranchAction({
      nodeId: rootId,
      text: 'beta',
      start: 6,
      end: 10,
      sourceMessageId: 'assistant-1',
      anchor: { x: node.position.x + 120, y: node.position.y },
    });

    const childId = engine.createBranchFromSelection();
    if (!childId) throw new Error('branch not created');
    const child = getNode(engine.doc, childId);
    expect(child?.sourceReference?.selectedTextSnapshot).toBe('beta');
    expect(child?.sourceReference?.sourceMessageId).toBe('assistant-1');
    if (!child) return;
    expect(evaluateSourceReference(engine.doc, child).status).toBe('valid');
  });

  it('persists AI mode, resized dimensions and conversation across reload', async () => {
    const rootId = engine.doc.rootNodeId;
    let doc = useGraphStore.getState().doc;
    const ai = setNodeKind(doc, rootId, 'ai');
    if (!ai.ok) throw new Error(ai.message);
    doc = ai.value.doc;
    const chat = appendChatMessage(doc, rootId, {
      id: 'm1',
      role: 'user',
      content: 'Remember this thought',
      createdAt: 20,
    });
    if (!chat.ok) throw new Error(chat.message);
    doc = chat.value.doc;
    const resized = resizeNode(doc, rootId, { width: 540, height: 620 });
    if (!resized.ok) throw new Error(resized.message);
    useGraphStore.getState().replaceDocument(resized.value.doc, { resetHistory: true });

    // Resize commits through the same engine path a corner drag uses.
    engine.setDraftNodeSize(rootId, { width: 600, height: 640 });
    engine.commitDraftNodeSize(rootId);
    expect(getNode(engine.doc, rootId)?.size).toEqual({ width: 600, height: 640 });

    const repository = await createDocumentRepository({ databaseName: 'lumieres_ai_workflow' });
    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 5 });
    autosave.start();
    await autosave.flush();
    autosave.stop();

    const loaded = await repository.load(engine.doc.id);
    expect(loaded).not.toBeNull();
    const restored = loaded ? getNode(loaded.doc, rootId) : null;
    expect(restored?.kind).toBe('ai');
    expect(restored?.size).toEqual({ width: 600, height: 640 });
    expect(restored?.chat.map((message) => message.content)).toEqual(['Remember this thought']);
    expect(validateGraph(loaded!.doc)).toEqual([]);
  });
});
