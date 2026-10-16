import { describe, expect, it } from 'vitest';
import {
  compareRenderOrder,
  createBranch,
  createEmptyDocument,
  deleteSubtree,
  evaluateSourceReference,
  getAncestorIds,
  getChildCount,
  getChildren,
  getDepth,
  getDescendantIds,
  getNode,
  isOverContentLimit,
  moveNode,
  previewDeletion,
  reparentNode,
  resetCanvas,
  updateNodeContent,
  type CreateBranchValue,
} from './graphOperations';
import { MAX_CHILDREN_PER_NODE, MAX_NODE_CONTENT_LENGTH, type GraphDocument, type SourceReference } from './types';
import { isValidGraph, validateGraph } from './graphValidation';

/** Applies a content edit, failing loudly so a broken fixture cannot pass silently. */
function setContent(doc: GraphDocument, nodeId: string, content: string): GraphDocument {
  const result = updateNodeContent(doc, nodeId, content);
  if (!result.ok) throw new Error(result.message);
  return result.value.doc;
}

function addChild(doc: GraphDocument, parentId: string, position = { x: 0, y: 0 }): CreateBranchValue {
  const result = createBranch(doc, { parentId, position });
  if (!result.ok) throw new Error(`expected branch to succeed: ${result.message}`);
  return result.value;
}

describe('document creation', () => {
  it('starts with exactly one root note and no edges', () => {
    const doc = createEmptyDocument('Test canvas');
    const nodes = Object.values(doc.nodes);

    expect(nodes).toHaveLength(1);
    expect(Object.keys(doc.edges)).toHaveLength(0);
    expect(doc.rootNodeId).toBe(nodes[0]?.id);
    expect(nodes[0]?.parentId).toBeNull();
    expect(doc.title).toBe('Test canvas');
    expect(doc.schemaVersion).toBe(1);
    expect(isValidGraph(doc)).toBe(true);
  });
});

describe('branch creation', () => {
  it('creates a child plus a directed edge from any node, at any depth', () => {
    let doc = createEmptyDocument();
    const rootId = doc.rootNodeId;

    const first = addChild(doc, rootId, { x: 500, y: 0 });
    doc = first.doc;

    const second = addChild(doc, first.node.id, { x: 1000, y: 0 });
    doc = second.doc;

    const third = addChild(doc, second.node.id, { x: 1500, y: 0 });
    doc = third.doc;

    expect(Object.keys(doc.nodes)).toHaveLength(4);
    expect(Object.keys(doc.edges)).toHaveLength(3);

    const edge = doc.edges[`e:${second.node.id}->${third.node.id}`];
    expect(edge).toBeDefined();
    expect(edge?.sourceNodeId).toBe(second.node.id);
    expect(edge?.targetNodeId).toBe(third.node.id);

    expect(getAncestorIds(doc, third.node.id)).toEqual([second.node.id, first.node.id, rootId]);
    expect(getDescendantIds(doc, rootId)).toHaveLength(3);
    expect(isValidGraph(doc)).toBe(true);
  });

  it('records a source reference on the new branch and leaves the source untouched', () => {
    let doc = createEmptyDocument();
    doc = setContent(doc, doc.rootNodeId, 'Alpha beta gamma');
    const source = getNode(doc, doc.rootNodeId);
    if (!source) throw new Error('source missing');

    const reference: SourceReference = {
      sourceNodeId: source.id,
      selectedTextSnapshot: 'beta',
      startOffset: 6,
      endOffset: 10,
      sourceContentVersion: source.contentVersion,
    };

    const child = createBranch(doc, {
      parentId: source.id,
      position: { x: 500, y: 0 },
      title: 'beta',
      sourceReference: reference,
    });
    if (!child.ok) throw new Error(child.message);

    expect(child.value.node.sourceReference).toEqual(reference);
    expect(child.value.node.parentId).toBe(source.id);
    // The source note's text is untouched by branching.
    expect(getNode(child.value.doc, source.id)?.content).toBe('Alpha beta gamma');
    expect(evaluateSourceReference(child.value.doc, child.value.node).status).toBe('valid');
  });

  it('rejects a branch from a node that does not exist', () => {
    const doc = createEmptyDocument();
    const result = createBranch(doc, { parentId: 'nope', position: { x: 0, y: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PARENT_NOT_FOUND');
  });

  it('rejects a non-finite position', () => {
    const doc = createEmptyDocument();
    const result = createBranch(doc, { parentId: doc.rootNodeId, position: { x: Number.NaN, y: 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID_POSITION');
  });
});

describe('the 50-child limit', () => {
  function docWithChildren(count: number): GraphDocument {
    let doc = createEmptyDocument();
    for (let index = 0; index < count; index += 1) {
      doc = addChild(doc, doc.rootNodeId, { x: 500, y: index * 300 }).doc;
    }
    return doc;
  }

  it('accepts the 50th child and rejects the 51st', () => {
    const atLimit = docWithChildren(MAX_CHILDREN_PER_NODE - 1);
    const fiftieth = createBranch(atLimit, { parentId: atLimit.rootNodeId, position: { x: 500, y: 0 } });
    expect(fiftieth.ok).toBe(true);
    if (!fiftieth.ok) return;

    expect(getChildCount(fiftieth.value.doc, fiftieth.value.doc.rootNodeId)).toBe(MAX_CHILDREN_PER_NODE);

    const fiftyFirst = createBranch(fiftieth.value.doc, {
      parentId: fiftieth.value.doc.rootNodeId,
      position: { x: 500, y: 100 },
    });
    expect(fiftyFirst.ok).toBe(false);
    if (!fiftyFirst.ok) expect(fiftyFirst.code).toBe('BRANCH_LIMIT_REACHED');
  });

  it('applies per node, not to the canvas total', () => {
    let doc = docWithChildren(MAX_CHILDREN_PER_NODE);
    const children = getChildren(doc, doc.rootNodeId);
    const exhausted = children[0];
    if (!exhausted) throw new Error('no children');

    // The exhausted child can still fill its own quota.
    for (let index = 0; index < MAX_CHILDREN_PER_NODE; index += 1) {
      doc = addChild(doc, exhausted.id, { x: 1200, y: index * 300 }).doc;
    }
    expect(getChildCount(doc, exhausted.id)).toBe(MAX_CHILDREN_PER_NODE);

    // A different child of the root is unaffected.
    const other = children[1];
    if (!other) throw new Error('no second child');
    expect(getChildCount(doc, other.id)).toBe(0);
    const branch = createBranch(doc, { parentId: other.id, position: { x: 1200, y: 0 } });
    expect(branch.ok).toBe(true);
    expect(Object.keys(doc.nodes).length + 1).toBeGreaterThan(MAX_CHILDREN_PER_NODE);
  });
});

describe('the 20,000-character limit', () => {
  it('accepts exactly the limit and rejects one character more', () => {
    const doc = createEmptyDocument();
    const atLimit = 'a'.repeat(MAX_NODE_CONTENT_LENGTH);

    const accepted = updateNodeContent(doc, doc.rootNodeId, atLimit);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(getNode(accepted.value.doc, doc.rootNodeId)?.content.length).toBe(MAX_NODE_CONTENT_LENGTH);

    const rejected = updateNodeContent(accepted.value.doc, doc.rootNodeId, `${atLimit}b`);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('CONTENT_LIMIT_EXCEEDED');
    // The rejection leaves the stored content untouched.
    expect(getNode(accepted.value.doc, doc.rootNodeId)?.content).toBe(atLimit);
  });

  it('counts per note, not per canvas', () => {
    let doc = createEmptyDocument();
    for (let index = 0; index < 3; index += 1) {
      doc = addChild(doc, doc.rootNodeId, { x: 500, y: index * 300 }).doc;
    }
    const ids = [doc.rootNodeId, ...getChildren(doc, doc.rootNodeId).map((node) => node.id)];
    for (const id of ids) {
      const result = updateNodeContent(doc, id, 'x'.repeat(MAX_NODE_CONTENT_LENGTH));
      expect(result.ok).toBe(true);
      if (result.ok) doc = result.value.doc;
    }
    const total = Object.values(doc.nodes).reduce((sum, node) => sum + node.content.length, 0);
    expect(total).toBe(MAX_NODE_CONTENT_LENGTH * 4);
  });

  it('flags over-limit content without truncating it (import path)', () => {
    expect(isOverContentLimit('a'.repeat(MAX_NODE_CONTENT_LENGTH + 25))).toBe(true);
    expect(isOverContentLimit('a'.repeat(MAX_NODE_CONTENT_LENGTH))).toBe(false);
  });

  it('bumps contentVersion only when the content actually changes', () => {
    let doc = createEmptyDocument();
    const first = updateNodeContent(doc, doc.rootNodeId, 'hello');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const version = first.value.node.contentVersion;

    const noop = updateNodeContent(first.value.doc, doc.rootNodeId, 'hello');
    expect(noop.ok).toBe(true);
    if (!noop.ok) return;
    expect(noop.value.node.contentVersion).toBe(version);
    expect(noop.value.doc).toBe(first.value.doc);
  });
});

describe('deletion semantics', () => {
  it('removes a node and its entire subtree, and only that subtree', () => {
    let doc = createEmptyDocument();
    const rootId = doc.rootNodeId;
    const branchA = addChild(doc, rootId, { x: 500, y: 0 });
    doc = branchA.doc;
    const branchB = addChild(doc, rootId, { x: 500, y: 400 });
    doc = branchB.doc;
    const grandchild = addChild(doc, branchA.node.id, { x: 1000, y: 0 });
    doc = grandchild.doc;

    const preview = previewDeletion(doc, branchA.node.id);
    expect(preview?.nodeIds.sort()).toEqual([branchA.node.id, grandchild.node.id].sort());
    expect(preview?.descendantCount).toBe(1);
    expect(preview?.isRoot).toBe(false);

    const result = deleteSubtree(doc, branchA.node.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.value.doc.nodes).sort()).toEqual([rootId, branchB.node.id].sort());
    expect(Object.keys(result.value.doc.edges)).toEqual([`e:${rootId}->${branchB.node.id}`]);
    expect(result.value.removedNodes).toHaveLength(2);
    expect(result.value.parentId).toBe(rootId);
    expect(isValidGraph(result.value.doc)).toBe(true);
  });

  it('refuses to delete the root and offers a reset instead', () => {
    let doc = createEmptyDocument();
    doc = addChild(doc, doc.rootNodeId, { x: 500, y: 0 }).doc;

    const denied = deleteSubtree(doc, doc.rootNodeId);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe('ROOT_DELETE_NOT_ALLOWED');

    const reset = resetCanvas(doc);
    expect(Object.keys(reset.doc.nodes)).toHaveLength(1);
    expect(Object.keys(reset.doc.edges)).toHaveLength(0);
    expect(reset.doc.rootNodeId).not.toBe(doc.rootNodeId);
    expect(isValidGraph(reset.doc)).toBe(true);
  });

  it('counts the characters a deletion would discard', () => {
    let doc = createEmptyDocument();
    const child = addChild(doc, doc.rootNodeId, { x: 500, y: 0 });
    doc = child.doc;
    const content = updateNodeContent(doc, child.node.id, 'some words here');
    if (!content.ok) throw new Error(content.message);
    doc = content.value.doc;

    const preview = previewDeletion(doc, child.node.id);
    expect(preview?.characterCount).toBe('some words here'.length);
  });
});

describe('source reference staleness', () => {
  function branchFrom(doc: GraphDocument, start: number, end: number): { doc: GraphDocument; nodeId: string } {
    const source = getNode(doc, doc.rootNodeId);
    if (!source) throw new Error('source missing');
    const result = createBranch(doc, {
      parentId: source.id,
      position: { x: 500, y: 0 },
      sourceReference: {
        sourceNodeId: source.id,
        selectedTextSnapshot: source.content.slice(start, end),
        startOffset: start,
        endOffset: end,
        sourceContentVersion: source.contentVersion,
      },
    });
    if (!result.ok) throw new Error(result.message);
    return { doc: result.value.doc, nodeId: result.value.node.id };
  }

  it('stays valid while the referenced range is untouched', () => {
    let doc = createEmptyDocument();
    doc = setContent(doc, doc.rootNodeId, 'Alpha beta gamma');
    const branched = branchFrom(doc, 6, 10);
    doc = branched.doc;

    // Edit far away from the referenced range.
    const edited = updateNodeContent(doc, doc.rootNodeId, 'Alpha beta gamma delta');
    if (!edited.ok) throw new Error(edited.message);
    doc = edited.value.doc;

    const node = getNode(doc, branched.nodeId);
    if (!node) throw new Error('branch missing');
    const evaluation = evaluateSourceReference(doc, node);
    expect(evaluation.status).toBe('valid');
    expect(evaluation.currentText).toBe('beta');
  });

  it('reports stale, and preserves the snapshot, when the source text changes underneath', () => {
    let doc = createEmptyDocument();
    doc = setContent(doc, doc.rootNodeId, 'Alpha beta gamma');
    const branched = branchFrom(doc, 6, 10);
    doc = branched.doc;

    const edited = updateNodeContent(doc, doc.rootNodeId, 'Alpha BETA gamma');
    if (!edited.ok) throw new Error(edited.message);
    doc = edited.value.doc;

    const node = getNode(doc, branched.nodeId);
    if (!node) throw new Error('branch missing');
    const evaluation = evaluateSourceReference(doc, node);

    expect(evaluation.status).toBe('stale');
    expect(evaluation.currentText).toBe('BETA');
    // The branch keeps its own copy of the original text.
    expect(node.sourceReference?.selectedTextSnapshot).toBe('beta');
  });

  it('reports a missing source rather than crashing on a malformed graph', () => {
    let doc = createEmptyDocument();
    doc = setContent(doc, doc.rootNodeId, 'Alpha beta');
    const branched = branchFrom(doc, 0, 5);
    doc = branched.doc;

    const node = getNode(doc, branched.nodeId);
    if (!node) throw new Error('branch missing');
    const orphaned: GraphDocument = {
      ...doc,
      nodes: { ...doc.nodes, [node.id]: { ...node, sourceReference: { ...node.sourceReference!, sourceNodeId: 'gone' } } },
    };

    expect(evaluateSourceReference(orphaned, getNode(orphaned, node.id)!).status).toBe('missing-source');
  });
});

describe('paint order', () => {
  it('puts descendants above their ancestors', () => {
    let doc = createEmptyDocument();
    const child = addChild(doc, doc.rootNodeId, { x: 0, y: 0 });
    doc = child.doc;
    const grandchild = addChild(doc, child.node.id, { x: 0, y: 0 });
    doc = grandchild.doc;

    // Windows stacked on top of each other still resolve deterministically.
    const root = getNode(doc, doc.rootNodeId);
    const leaf = getNode(doc, grandchild.node.id);
    if (!root || !leaf) throw new Error('nodes missing');

    expect(compareRenderOrder(doc, leaf, root)).toBeGreaterThan(0);
    expect(compareRenderOrder(doc, root, leaf)).toBeLessThan(0);
  });

  it('is deterministic for nodes created in the same millisecond', () => {
    const now = 1_700_000_000_000;
    let doc = createEmptyDocument('Same instant', now);
    const first = createBranch(doc, {
      parentId: doc.rootNodeId,
      position: { x: 0, y: 0 },
      now,
    });
    if (!first.ok) throw new Error(first.message);
    doc = first.value.doc;
    const second = createBranch(doc, {
      parentId: doc.rootNodeId,
      position: { x: 0, y: 0 },
      now,
    });
    if (!second.ok) throw new Error(second.message);
    doc = second.value.doc;

    const a = getNode(doc, first.value.node.id);
    const b = getNode(doc, second.value.node.id);
    if (!a || !b) throw new Error('nodes missing');
    expect(a.createdAt).toBe(b.createdAt);

    // Same depth and same timestamp: the id decides, and the answer is stable.
    expect(compareRenderOrder(doc, a, b)).toBe(compareRenderOrder(doc, a, b));
    expect(compareRenderOrder(doc, a, b)).toBe(-compareRenderOrder(doc, b, a));
  });

  it('reports depth from the root', () => {
    let doc = createEmptyDocument();
    const child = addChild(doc, doc.rootNodeId, { x: 0, y: 0 });
    doc = child.doc;
    const grandchild = addChild(doc, child.node.id, { x: 0, y: 0 });
    doc = grandchild.doc;

    expect(getDepth(doc, doc.rootNodeId)).toBe(0);
    expect(getDepth(doc, child.node.id)).toBe(1);
    expect(getDepth(doc, grandchild.node.id)).toBe(2);
  });
});

describe('reparenting (domain support for future drag-to-reattach)', () => {
  it('moves a subtree to a new parent and rewrites the edge', () => {
    let doc = createEmptyDocument();
    const a = addChild(doc, doc.rootNodeId, { x: 500, y: -200 });
    doc = a.doc;
    const b = addChild(doc, doc.rootNodeId, { x: 500, y: 300 });
    doc = b.doc;
    const leaf = addChild(doc, a.node.id, { x: 1000, y: -200 });
    doc = leaf.doc;

    const moved = reparentNode(doc, leaf.node.id, b.node.id);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    expect(getNode(moved.value, leaf.node.id)?.parentId).toBe(b.node.id);
    expect(moved.value.edges[`e:${a.node.id}->${leaf.node.id}`]).toBeUndefined();
    expect(moved.value.edges[`e:${b.node.id}->${leaf.node.id}`]).toBeDefined();
    // The old parent keeps its other relationships.
    expect(getNode(moved.value, a.node.id)?.parentId).toBe(doc.rootNodeId);
    expect(isValidGraph(moved.value)).toBe(true);
  });

  it('refuses a move that would create a cycle', () => {
    let doc = createEmptyDocument();
    const parent = addChild(doc, doc.rootNodeId, { x: 500, y: 0 });
    doc = parent.doc;
    const child = addChild(doc, parent.node.id, { x: 1000, y: 0 });
    doc = child.doc;

    // Re-parenting an ancestor under its own descendant is rejected.
    const cycle = reparentNode(doc, parent.node.id, child.node.id);
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.code).toBe('INVALID_SELECTION');

    const selfParent = reparentNode(doc, parent.node.id, parent.node.id);
    expect(selfParent.ok).toBe(false);
    expect(isValidGraph(doc)).toBe(true);
  });

  it('respects the branch limit of the destination', () => {
    let doc = createEmptyDocument();
    const target = addChild(doc, doc.rootNodeId, { x: 500, y: 0 });
    doc = target.doc;
    for (let index = 0; index < MAX_CHILDREN_PER_NODE; index += 1) {
      doc = addChild(doc, target.node.id, { x: 1000, y: index * 300 }).doc;
    }
    const spare = addChild(doc, doc.rootNodeId, { x: 500, y: 900 });
    doc = spare.doc;

    const result = reparentNode(doc, spare.node.id, target.node.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('BRANCH_LIMIT_REACHED');
  });
});

describe('movement', () => {
  it('changes position without touching relationships', () => {
    let doc = createEmptyDocument();
    const child = addChild(doc, doc.rootNodeId, { x: 500, y: 0 });
    doc = child.doc;

    const moved = moveNode(doc, child.node.id, { x: -120, y: 340 });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    expect(getNode(moved.value.doc, child.node.id)?.position).toEqual({ x: -120, y: 340 });
    expect(getNode(moved.value.doc, child.node.id)?.parentId).toBe(doc.rootNodeId);
    expect(Object.keys(moved.value.doc.edges)).toEqual(Object.keys(doc.edges));
    expect(isValidGraph(moved.value.doc)).toBe(true);
  });

  it('rejects non-finite moves', () => {
    const doc = createEmptyDocument();
    const result = moveNode(doc, doc.rootNodeId, { x: Infinity, y: 0 });
    expect(result.ok).toBe(false);
  });
});

describe('integrity under a wide and deep graph', () => {
  it('keeps every invariant after hundreds of branches', () => {
    let doc = createEmptyDocument();
    // 1 root → 20 children → 10 grandchildren each = 221 nodes.
    for (let index = 0; index < 20; index += 1) {
      const child = addChild(doc, doc.rootNodeId, { x: 500, y: index * 300 });
      doc = child.doc;
      for (let inner = 0; inner < 10; inner += 1) {
        doc = addChild(doc, child.node.id, { x: 1000, y: index * 300 + inner * 300 }).doc;
      }
    }

    expect(Object.keys(doc.nodes)).toHaveLength(221);
    expect(Object.keys(doc.edges)).toHaveLength(220);
    expect(validateGraph(doc)).toEqual([]);

    // Deleting one child removes exactly its own subtree.
    const firstChild = getChildren(doc, doc.rootNodeId)[0];
    if (!firstChild) throw new Error('no children');
    const after = deleteSubtree(doc, firstChild.id);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(Object.keys(after.value.doc.nodes)).toHaveLength(221 - 11);
    expect(validateGraph(after.value.doc)).toEqual([]);
  });
});
