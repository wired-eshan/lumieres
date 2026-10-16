import { describe, expect, it } from 'vitest';
import { deserializeDocument, migrateDocument, serializeDocument } from './migrations';
import { createBranch, createEmptyDocument, updateNodeContent } from '../graph/graphOperations';
import { isValidGraph, validateGraph } from '../graph/graphValidation';
import { MAX_NODE_CONTENT_LENGTH, SCHEMA_VERSION, type GraphDocument } from '../graph/types';

function sampleDocument(): GraphDocument {
  let doc = createEmptyDocument('Migration sample');
  const child = createBranch(doc, {
    parentId: doc.rootNodeId,
    position: { x: 500, y: 0 },
    title: 'Child',
  });
  if (!child.ok) throw new Error(child.message);
  doc = child.value.doc;
  const withContent = updateNodeContent(doc, child.value.node.id, 'Some branch content');
  if (!withContent.ok) throw new Error(withContent.message);
  return withContent.value.doc;
}

describe('document migration', () => {
  it('round-trips a current document without changing it', () => {
    const doc = sampleDocument();
    const result = migrateDocument(JSON.parse(serializeDocument(doc)));

    expect(result.doc).not.toBeNull();
    expect(result.doc?.title).toBe(doc.title);
    expect(Object.keys(result.doc?.nodes ?? {})).toHaveLength(2);
    expect(Object.keys(result.doc?.edges ?? {})).toHaveLength(1);
    expect(validateGraph(result.doc as GraphDocument)).toEqual([]);
  });

  it('upgrades a pre-versioned document and says so', () => {
    const doc = sampleDocument();
    const raw = JSON.parse(serializeDocument(doc)) as Record<string, unknown>;
    delete raw.schemaVersion;

    const result = migrateDocument(raw);
    expect(result.doc?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.fromVersion).toBe(0);
    expect(result.notes.join(' ')).toContain('pre-versioned');
    expect(isValidGraph(result.doc as GraphDocument)).toBe(true);
  });

  it('refuses a document from a newer schema instead of guessing', () => {
    const doc = sampleDocument();
    const raw = { ...JSON.parse(serializeDocument(doc)), schemaVersion: SCHEMA_VERSION + 5 };

    const result = migrateDocument(raw);
    expect(result.doc).toBeNull();
    expect(result.issues[0]?.message).toContain('newer version');
  });

  it('defaults missing fields rather than failing', () => {
    const result = migrateDocument({
      schemaVersion: SCHEMA_VERSION,
      id: 'doc_x',
      title: 'Minimal',
      rootNodeId: 'root',
      nodes: { root: { id: 'root', parentId: null, content: 'kept' } },
      edges: {},
    });

    const root = result.doc?.nodes['root'];
    expect(root?.title).toBe('');
    expect(root?.content).toBe('kept');
    expect(root?.position).toEqual({ x: 0, y: 0 });
    expect(root?.collapsed).toBe(false);
    expect(root?.contentVersion).toBe(1);
    expect(isValidGraph(result.doc as GraphDocument)).toBe(true);
  });

  it('preserves over-limit content and reports it', () => {
    const oversized = 'x'.repeat(MAX_NODE_CONTENT_LENGTH + 240);
    const result = migrateDocument({
      schemaVersion: SCHEMA_VERSION,
      id: 'doc_big',
      title: 'Oversized',
      rootNodeId: 'root',
      nodes: { root: { id: 'root', parentId: null, content: oversized } },
      edges: {},
    });

    expect(result.doc?.nodes['root']?.content).toBe(oversized);
    expect(result.doc?.nodes['root']?.content.length).toBe(MAX_NODE_CONTENT_LENGTH + 240);
    const issues = validateGraph(result.doc as GraphDocument);
    expect(issues.some((issue) => issue.code === 'CONTENT_LIMIT_EXCEEDED')).toBe(true);
  });

  it('repairs an unreachable node instead of dropping its content', () => {
    const result = migrateDocument({
      schemaVersion: SCHEMA_VERSION,
      id: 'doc_orphan',
      title: 'Orphan',
      rootNodeId: 'root',
      nodes: {
        root: { id: 'root', parentId: null, content: 'root' },
        lost: { id: 'lost', parentId: 'missing', content: 'must survive' },
      },
      edges: {},
    });

    expect(result.doc?.nodes['lost']?.content).toBe('must survive');
    expect(result.doc?.nodes['lost']?.parentId).toBe('root');
    expect(isValidGraph(result.doc as GraphDocument)).toBe(true);
    expect(result.notes.join(' ')).toContain('Repaired');
  });

  it('rebuilds edges from parentId so imports cannot desync them', () => {
    const result = migrateDocument({
      schemaVersion: SCHEMA_VERSION,
      id: 'doc_edges',
      title: 'Edges',
      rootNodeId: 'root',
      nodes: {
        root: { id: 'root', parentId: null },
        child: { id: 'child', parentId: 'root' },
      },
      edges: { bogus: { id: 'bogus', sourceNodeId: 'child', targetNodeId: 'root' } },
    });

    const edges = Object.values(result.doc?.edges ?? {});
    expect(edges).toHaveLength(1);
    expect(edges[0]?.sourceNodeId).toBe('root');
    expect(edges[0]?.targetNodeId).toBe('child');
  });

  it('promotes a parentless node when the recorded root is missing', () => {
    const result = migrateDocument({
      schemaVersion: SCHEMA_VERSION,
      id: 'doc_noroot',
      title: 'No root',
      rootNodeId: 'gone',
      nodes: { a: { id: 'a', parentId: null, content: 'first' } },
      edges: {},
    });

    expect(result.doc?.rootNodeId).toBe('a');
    expect(isValidGraph(result.doc as GraphDocument)).toBe(true);
  });

  it('reports invalid JSON rather than throwing', () => {
    const result = deserializeDocument('{ not json');
    expect(result.doc).toBeNull();
    expect(result.issues[0]?.severity).toBe('error');
  });

  it('rejects non-object input', () => {
    expect(migrateDocument('a string').doc).toBeNull();
    expect(migrateDocument(null).doc).toBeNull();
    expect(migrateDocument([1, 2, 3]).doc).toBeNull();
  });

  it('clamps a source reference whose offsets are out of order', () => {
    const result = migrateDocument({
      schemaVersion: SCHEMA_VERSION,
      id: 'doc_src',
      title: 'Source',
      rootNodeId: 'root',
      nodes: {
        root: { id: 'root', parentId: null, content: 'abcdefghij' },
        child: {
          id: 'child',
          parentId: 'root',
          sourceReference: {
            sourceNodeId: 'root',
            selectedTextSnapshot: 'abcdefghij',
            startOffset: 8,
            endOffset: 2,
            sourceContentVersion: 1,
          },
        },
      },
      edges: {},
    });

    const reference = result.doc?.nodes['child']?.sourceReference;
    expect(reference?.startOffset).toBe(8);
    expect(reference?.endOffset).toBeGreaterThanOrEqual(8);
  });
});
