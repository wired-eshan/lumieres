import { describe, expect, it } from 'vitest';
import { buildNodeContext, estimateContextCharacters } from './context';
import {
  createBranch,
  createEmptyDocument,
  getAncestorIds,
  updateNodeContent,
  updateNodeTitle,
} from '../graph/graphOperations';
import {
  lineageFingerprint,
  LineageSummaryStore,
  type LineageChainItem,
} from './lineageSummaryStore';
import { MAX_NODE_CONTENT_LENGTH, type GraphDocument } from '../graph/types';

function chainOf(length: number, contentPerNode = 'x'): { doc: GraphDocument; leafId: string } {
  let doc = createEmptyDocument();
  let parentId = doc.rootNodeId;
  const filled = updateNodeContent(doc, parentId, contentPerNode.repeat(1000));
  if (filled.ok) doc = filled.value.doc;

  for (let index = 0; index < length; index += 1) {
    const branch = createBranch(doc, { parentId, position: { x: index * 500, y: 0 } });
    if (!branch.ok) throw new Error(branch.message);
    doc = branch.value.doc;
    const withContent = updateNodeContent(doc, branch.value.node.id, contentPerNode.repeat(1000));
    if (withContent.ok) doc = withContent.value.doc;
    parentId = branch.value.node.id;
  }
  return { doc, leafId: parentId };
}

describe('AI context assembly', () => {
  it('never concatenates every ancestor in full', () => {
    // Ten ancestors each holding 1,000 characters.
    const { doc, leafId } = chainOf(10);
    const context = buildNodeContext(doc, leafId, { budget: { maxCharacters: 2000, maxAncestors: 10 } });

    expect(context).not.toBeNull();
    if (!context) return;

    // The assembled context — titles included — stays inside the budget.
    const total = estimateContextCharacters(context);
    expect(total).toBeLessThanOrEqual(2000);
    expect(context.ancestors.length).toBeLessThanOrEqual(10);
    // No ancestor contributes its full 1,000 characters.
    for (const ancestor of context.ancestors) {
      expect(ancestor.excerpt.length).toBeLessThan(1000);
    }
    expect(context.ancestors[0]?.excerpt.length).toBeLessThan(1000);
  });

  it('includes only as many ancestors as the character budget allows', () => {
    const { doc, leafId } = chainOf(10);
    const context = buildNodeContext(doc, leafId, {
      budget: { maxCharacters: 400, maxAncestors: 10 },
      maxOwnCharacters: 100,
    });
    if (!context) throw new Error('context missing');

    expect(estimateContextCharacters(context)).toBeLessThanOrEqual(400);
    // Far fewer than the ten available ancestors fit in 300 remaining characters.
    expect(context.ancestors.length).toBeLessThan(6);
  });

  it('orders non-root ancestors nearest-first and preserves the root separately', () => {
    const { doc, leafId } = chainOf(3);
    const context = buildNodeContext(doc, leafId, { budget: { maxCharacters: 5000, maxAncestors: 3 } });
    if (!context) throw new Error('context missing');

    // Distances are 1-based, so the immediate parent reads as `Parent` (1 up)
    // and each ancestor beyond it as `Ancestor (n up)`.
    expect(context.ancestors.map((ancestor) => ancestor.distance)).toEqual([1, 2]);
    expect(context.ancestors[0]?.nodeId).toBe(doc.nodes[leafId]?.parentId);
    // The root / original concept is always preserved as its own anchor.
    expect(context.rootAncestor?.nodeId).toBe(doc.rootNodeId);
  });

  it('keeps the root even when a deep node exceeds maxAncestors', () => {
    // A node several hops deep where `maxAncestors` is small: the nearest
    // lineage is sliced to the cap, but the original problem must not be lost.
    const { doc, leafId } = chainOf(6);
    const context = buildNodeContext(doc, leafId, { budget: { maxCharacters: 5000, maxAncestors: 2 } });
    if (!context) throw new Error('context missing');

    expect(context.ancestors).toHaveLength(2);
    expect(context.rootAncestor?.nodeId).toBe(doc.rootNodeId);
    // The root is not silently double-counted as a normal ancestor.
    const ancestorIds = new Set(context.ancestors.map((a) => a.nodeId));
    expect(ancestorIds.has(doc.rootNodeId)).toBe(false);
  });

  it('detects a clarify query and reports it as intent', () => {
    const { doc, leafId } = chainOf(3);
    const context = buildNodeContext(doc, leafId, {
      budget: { maxCharacters: 5000, maxAncestors: 3 },
      query: 'can you explain this more clearly?',
    });
    if (!context) throw new Error('context missing');
    expect(context.intent).toBe('clarify');

    const plain = buildNodeContext(doc, leafId, {
      budget: { maxCharacters: 5000, maxAncestors: 3 },
      query: 'give me an example',
    });
    expect(plain?.intent).toBe('normal');
  });

  it('honours maxAncestors even when the character budget is large', () => {
    const { doc, leafId } = chainOf(8);
    const context = buildNodeContext(doc, leafId, { budget: { maxCharacters: 100_000, maxAncestors: 2 } });
    expect(context?.ancestors).toHaveLength(2);
  });

  it('includes the node’s own content and source reference', () => {
    let doc = createEmptyDocument();
    const text = 'The mitochondria is the powerhouse of the cell.';
    const withContent = updateNodeContent(doc, doc.rootNodeId, text);
    if (!withContent.ok) throw new Error(withContent.message);
    doc = withContent.value.doc;

    const start = text.indexOf('powerhouse');
    const source = doc.nodes[doc.rootNodeId];
    if (!source) throw new Error('root missing');

    const branch = createBranch(doc, {
      parentId: source.id,
      position: { x: 500, y: 0 },
      sourceReference: {
        sourceNodeId: source.id,
        selectedTextSnapshot: 'powerhouse',
        startOffset: start,
        endOffset: start + 'powerhouse'.length,
        sourceContentVersion: source.contentVersion,
      },
    });
    if (!branch.ok) throw new Error(branch.message);
    doc = branch.value.doc;

    const context = buildNodeContext(doc, branch.value.node.id);
    expect(context?.sourceReference?.selectedTextSnapshot).toBe('powerhouse');
    expect(context?.sourceReference?.stale).toBe(false);
  });

  it('marks a source reference stale when the source has moved on', () => {
    let doc = createEmptyDocument();
    const withContent = updateNodeContent(doc, doc.rootNodeId, 'alpha beta gamma');
    if (!withContent.ok) throw new Error(withContent.message);
    doc = withContent.value.doc;
    const source = doc.nodes[doc.rootNodeId];
    if (!source) throw new Error('root missing');

    const branch = createBranch(doc, {
      parentId: source.id,
      position: { x: 500, y: 0 },
      sourceReference: {
        sourceNodeId: source.id,
        selectedTextSnapshot: 'beta',
        startOffset: 6,
        endOffset: 10,
        sourceContentVersion: source.contentVersion,
      },
    });
    if (!branch.ok) throw new Error(branch.message);
    const edited = updateNodeContent(branch.value.doc, source.id, 'alpha BETA gamma');
    if (!edited.ok) throw new Error(edited.message);

    const context = buildNodeContext(edited.value.doc, branch.value.node.id);
    expect(context?.sourceReference?.stale).toBe(true);
  });

  it('caps a single 20,000-character note rather than passing it through whole', () => {
    const doc = createEmptyDocument();
    const huge = 'y'.repeat(MAX_NODE_CONTENT_LENGTH);
    const withContent = updateNodeContent(doc, doc.rootNodeId, huge);
    if (!withContent.ok) throw new Error(withContent.message);

    const context = buildNodeContext(withContent.value.doc, doc.rootNodeId);
    expect(context?.content.length).toBeLessThan(MAX_NODE_CONTENT_LENGTH);
    expect(context?.content.endsWith('…')).toBe(true);
  });

  it('returns null for a node that is not in the document', () => {
    expect(buildNodeContext(createEmptyDocument(), 'missing')).toBeNull();
  });

  it('prioritises the ancestor relevant to the query over an unrelated longer one', () => {
    // Build a branch leaf <- n4 <- n3 <- n2 <- n1 <- root, then make n2 carry
    // the concept the query targets while n1 (further out) is an unrelated,
    // much longer note.
    const { doc: base, leafId } = chainOf(5);
    let doc = base;
    const chain = getAncestorIds(doc, leafId); // parent-first: [n4, n3, n2, n1, root]
    const relevantId = chain[2]!;
    const unrelatedId = chain[3]!;

    const relevant = updateNodeContent(doc, relevantId, 'Detailed notes about binary tree traversal using recursion.');
    if (relevant.ok) doc = relevant.value.doc;
    const unrelated = updateNodeContent(doc, unrelatedId, 'x'.repeat(2000)); // long but irrelevant
    if (unrelated.ok) doc = unrelated.value.doc;

    const context = buildNodeContext(doc, leafId, {
      budget: { maxCharacters: 10_000, maxAncestors: 3 },
      query: 'binary tree traversal',
    });
    if (!context) throw new Error('context missing');

    const ancestorIds = context.ancestors.map((a) => a.nodeId);
    // The relevant ancestor is kept even though it is not the nearest…
    expect(ancestorIds).toContain(relevantId);
    // …and the unrelated longer one (closer to the fill budget) is dropped.
    expect(ancestorIds).not.toContain(unrelatedId);
    // It is scored relevant; the unrelated note is not.
    expect(context.ancestorRelevance?.get(relevantId) ?? 0).toBeGreaterThan(0);
    expect(context.ancestorRelevance?.get(unrelatedId) ?? 0).toBe(0);
  });

  it('carries conversation history through untouched', () => {
    const doc = createEmptyDocument();
    const context = buildNodeContext(doc, doc.rootNodeId, {
      history: [{ id: 'm1', role: 'user', content: 'earlier question', createdAt: 1 }],
    });
    expect(context?.history).toHaveLength(1);
    expect(context?.history[0]?.content).toBe('earlier question');
  });
});

describe('hybrid lineage summarization', () => {
  function chainWithRootNote(): { doc: GraphDocument; leafId: string } {
    let doc = createEmptyDocument('Two sum');
    const root = doc.rootNodeId;
    const withContent = updateNodeContent(
      doc,
      root,
      'We need to find two numbers that sum to the target. ' +
        'A hash map gives O(n) time. Sorting and two pointers also works for a sorted input.',
    );
    if (withContent.ok) doc = withContent.value.doc;
    let parentId = root;
    for (let index = 0; index < 2; index += 1) {
      const branch = createBranch(doc, { parentId, position: { x: index * 100, y: 0 } });
      if (!branch.ok) throw new Error(branch.message);
      doc = branch.value.doc;
      parentId = branch.value.node.id;
    }
    return { doc, leafId: parentId };
  }

  function fingerprintOf(doc: GraphDocument, leafId: string): string {
    const items: LineageChainItem[] = [];
    for (const ancestorId of getAncestorIds(doc, leafId)) {
      const node = doc.nodes[ancestorId];
      if (node) items.push({ id: node.id, contentVersion: node.contentVersion });
    }
    const rootId = items[items.length - 1]?.id ?? 'none';
    return lineageFingerprint(rootId, items);
  }

  it('uses the deterministic extractive default and flags that an LLM summary would help', () => {
    const { doc, leafId } = chainWithRootNote();
    const context = buildNodeContext(doc, leafId, {
      budget: { maxCharacters: 8000, maxAncestors: 4 },
      query: 'hash map time complexity explain this more clearly',
    });
    if (!context) throw new Error('context missing');

    expect(context.lineageSummary).toBeUndefined();
    expect(context.lineageSummaryNeeded).toBe(true);
    // The relevant sentence wins the budget for the root anchor.
    expect(context.rootAncestor?.excerpt).toContain('hash map');
    expect(estimateContextCharacters(context)).toBeLessThanOrEqual(8000);
  });

  it('uses a cached lineage summary and suppresses raw excerpts when it is fresh', () => {
    const { doc, leafId } = chainWithRootNote();
    // Give the leaf lineage a title so orientation entries are kept.
    const titled = updateNodeTitle(doc, doc.nodes[leafId]?.parentId ?? leafId, 'Detail');
    const withTitle = titled.ok ? titled.value.doc : doc;

    const store = new LineageSummaryStore(8);
    store.set(fingerprintOf(withTitle, leafId), 'A condensed lineage summary.', 0);

    const context = buildNodeContext(withTitle, leafId, {
      budget: { maxCharacters: 8000, maxAncestors: 4 },
      query: 'explain this more clearly',
      lineageStore: store,
    });
    if (!context) throw new Error('context missing');

    expect(context.lineageSummary).toBe('A condensed lineage summary.');
    expect(context.lineageSummaryNeeded).toBe(false);
    // Raw excerpts are dropped; only titles remain for orientation.
    expect(context.rootAncestor?.excerpt).toBe('');
    for (const ancestor of context.ancestors) expect(ancestor.excerpt).toBe('');
    expect(estimateContextCharacters(context)).toBeLessThanOrEqual(8000);
  });

  it('invalidates a cached summary when an ancestor content changes', () => {
    const { doc, leafId } = chainWithRootNote();
    const store = new LineageSummaryStore(8);
    const before = fingerprintOf(doc, leafId);
    store.set(before, 'Stale summary.', 0);

    // Editing the root bumps its contentVersion → the fingerprint changes.
    const root = doc.rootNodeId;
    const edited = updateNodeContent(doc, root, 'Find two numbers that add up to a target.');
    if (!edited.ok) throw new Error(edited.message);
    const after = fingerprintOf(edited.value.doc, leafId);

    expect(after).not.toBe(before);

    const context = buildNodeContext(edited.value.doc, leafId, {
      query: 'explain this more clearly',
      lineageStore: store,
    });
    if (!context) throw new Error('context missing');
    expect(context.lineageSummary).toBeUndefined();
    expect(context.lineageSummaryNeeded).toBe(true);
  });
});
