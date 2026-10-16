import { describe, expect, it } from 'vitest';
import { applyPatch, canRedo, canUndo, pushPatch, redo, undo, type HistoryState, type Patch } from './history';
import { createBranch, createEmptyDocument, deleteSubtree, getNode, updateNodeContent } from './graphOperations';
import type { GraphDocument, NoteNode } from './types';

function contentPatch(before: NoteNode, after: NoteNode): Patch {
  return {
    kind: 'update',
    nodeId: before.id,
    before: { content: before.content, contentVersion: before.contentVersion, updatedAt: before.updatedAt },
    after: { content: after.content, contentVersion: after.contentVersion, updatedAt: after.updatedAt },
    label: 'Edit note',
  };
}

function edit(doc: GraphDocument, content: string, now = Date.now()): { doc: GraphDocument; patch: Patch } {
  const before = getNode(doc, doc.rootNodeId);
  if (!before) throw new Error('missing root');
  const result = updateNodeContent(doc, doc.rootNodeId, content, now);
  if (!result.ok) throw new Error(result.message);
  return { doc: result.value.doc, patch: contentPatch(before, result.value.node) };
}

describe('undo/redo history', () => {
  it('is empty for a new document', () => {
    let history = pushPatch({ past: [], future: [] }, {
      kind: 'insert',
      nodes: [],
      edges: [],
      label: 'noop',
    });
    expect(canUndo(history)).toBe(true);
    history = { past: [], future: [] };
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
  });

  it('coalesces a typing burst into a single undo step', () => {
    let doc = createEmptyDocument();
    let history: HistoryState = { past: [], future: [] };

    const base = Date.now();
    for (const [index, text] of ['h', 'he', 'hel', 'hell', 'hello'].entries()) {
      const step = edit(doc, text, base + index * 60);
      doc = step.doc;
      history = pushPatch(history, step.patch, base + index * 60);
    }

    expect(history.past).toHaveLength(1);

    const undone = undo(doc, history);
    expect(getNode(undone.doc, undone.doc.rootNodeId)?.content).toBe('');
    expect(undone.history.future).toHaveLength(1);
  });

  it('splits separate bursts that are far apart in time', () => {
    let doc = createEmptyDocument();
    let history: HistoryState = { past: [], future: [] };

    const first = edit(doc, 'first', 1000);
    doc = first.doc;
    history = pushPatch(history, first.patch, 1000);

    const second = edit(doc, 'first second', 5000);
    doc = second.doc;
    history = pushPatch(history, second.patch, 5000);

    expect(history.past).toHaveLength(2);
    const once = undo(doc, history);
    expect(getNode(once.doc, once.doc.rootNodeId)?.content).toBe('first');
    const twice = undo(once.doc, once.history);
    expect(getNode(twice.doc, twice.doc.rootNodeId)?.content).toBe('');
  });

  it('round-trips a redo back to the edited state', () => {
    let doc = createEmptyDocument();
    const step = edit(doc, 'hello');
    doc = step.doc;
    const history = pushPatch({ past: [], future: [] }, step.patch);

    const undone = undo(doc, history);
    const redone = redo(undone.doc, undone.history);

    expect(getNode(redone.doc, redone.doc.rootNodeId)?.content).toBe('hello');
    expect(redone.doc).not.toBe(doc);
  });

  it('restores a deleted subtree, edges included', () => {
    let doc = createEmptyDocument();
    const child = createBranch(doc, { parentId: doc.rootNodeId, position: { x: 500, y: 0 } });
    if (!child.ok) throw new Error(child.message);
    doc = child.value.doc;
    const grandchild = createBranch(doc, { parentId: child.value.node.id, position: { x: 1000, y: 0 } });
    if (!grandchild.ok) throw new Error(grandchild.message);
    doc = grandchild.value.doc;

    const deletion = deleteSubtree(doc, child.value.node.id);
    if (!deletion.ok) throw new Error(deletion.message);

    const patch: Patch = {
      kind: 'remove',
      nodes: deletion.value.removedNodes,
      edges: deletion.value.removedEdges,
      label: 'Delete note',
    };
    const history = pushPatch({ past: [], future: [] }, patch);

    const restored = undo(deletion.value.doc, history);
    expect(Object.keys(restored.doc.nodes)).toHaveLength(3);
    expect(Object.keys(restored.doc.edges)).toHaveLength(2);
    expect(restored.doc.nodes[grandchild.value.node.id]).toBeDefined();
  });

  it('discards the redo stack once new work happens', () => {
    let doc = createEmptyDocument();
    const first = edit(doc, 'one', 1000);
    doc = first.doc;
    let history = pushPatch({ past: [], future: [] }, first.patch, 1000);

    const undone = undo(doc, history);
    expect(canRedo(undone.history)).toBe(true);

    const branch = createBranch(undone.doc, { parentId: undone.doc.rootNodeId, position: { x: 500, y: 0 } });
    if (!branch.ok) throw new Error(branch.message);
    const branched = {
      doc: branch.value.doc,
      patch: { kind: 'insert' as const, nodes: [branch.value.node], edges: [branch.value.edge], label: 'Create branch' },
    };
    history = pushPatch(undone.history, branched.patch);
    expect(canRedo(history)).toBe(false);
  });

  it('applies and inverts patches symmetrically', () => {
    const doc = createEmptyDocument();
    const step = edit(doc, 'hello');
    const applied = applyPatch(doc, step.patch, 2000);
    expect(getNode(applied, doc.rootNodeId)?.content).toBe('hello');

    const reverted = applyPatch(applied, {
      kind: 'update',
      nodeId: step.patch.kind === 'update' ? step.patch.nodeId : '',
      before: step.patch.kind === 'update' ? step.patch.after : {},
      after: step.patch.kind === 'update' ? step.patch.before : {},
      label: 'inverse',
    });
    expect(getNode(reverted, doc.rootNodeId)?.content).toBe('');
  });
});
