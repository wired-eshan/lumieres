import { describe, expect, it } from 'vitest';
import { buildNodeContext, estimateContextCharacters } from './context';
import { createBranch, createEmptyDocument, updateNodeContent } from '../graph/graphOperations';
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

  it('orders ancestors nearest-first and records their distance', () => {
    const { doc, leafId } = chainOf(3);
    const context = buildNodeContext(doc, leafId, { budget: { maxCharacters: 5000, maxAncestors: 3 } });
    if (!context) throw new Error('context missing');

    expect(context.ancestors.map((ancestor) => ancestor.distance)).toEqual([0, 1, 2]);
    expect(context.ancestors[0]?.nodeId).toBe(doc.nodes[leafId]?.parentId);
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

  it('carries conversation history through untouched', () => {
    const doc = createEmptyDocument();
    const context = buildNodeContext(doc, doc.rootNodeId, {
      history: [{ id: 'm1', role: 'user', content: 'earlier question', createdAt: 1 }],
    });
    expect(context?.history).toHaveLength(1);
    expect(context?.history[0]?.content).toBe('earlier question');
  });
});
