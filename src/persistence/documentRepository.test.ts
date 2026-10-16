import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocumentRepository, createMemoryRepository, type DocumentRepository } from './documentRepository';
import { createBranch, createEmptyDocument, moveNode, updateNodeContent } from '../graph/graphOperations';
import type { GraphDocument } from '../graph/types';

function build(documentTitle: string): GraphDocument {
  let doc = createEmptyDocument(documentTitle);
  const child = createBranch(doc, { parentId: doc.rootNodeId, position: { x: 500, y: 0 }, title: 'Child' });
  if (!child.ok) throw new Error(child.message);
  doc = child.value.doc;
  const content = updateNodeContent(doc, child.value.node.id, 'text that must survive a reload');
  if (!content.ok) throw new Error(content.message);
  doc = content.value.doc;
  const moved = moveNode(content.value.doc, child.value.node.id, { x: 612, y: -40 });
  if (!moved.ok) throw new Error(moved.message);
  return moved.value.doc;
}

describe('document repository (IndexedDB)', () => {
  let repository: DocumentRepository;
  let databaseName = '';
  let databaseCounter = 0;

  beforeEach(async () => {
    // Each test gets its own database: IndexedDB blocks `deleteDatabase` while a
    // connection is open, and an isolated name keeps tests order-independent.
    databaseCounter += 1;
    databaseName = `lumieres_test_${databaseCounter}`;
    repository = await createDocumentRepository({ databaseName });
  });

  it('uses IndexedDB when it is available', () => {
    expect(repository.kind).toBe('indexeddb');
  });

  it('returns null for a document that was never stored', async () => {
    expect(await repository.load('doc_missing')).toBeNull();
  });

  it('round-trips a document with positions, contents and edges intact', async () => {
    const doc = build('Round trip');
    await repository.save({ doc, savedAt: 1234 });

    const loaded = await repository.load(doc.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.savedAt).toBe(1234);
    expect(loaded?.doc.title).toBe('Round trip');
    expect(Object.keys(loaded?.doc.nodes ?? {})).toEqual(Object.keys(doc.nodes));
    expect(Object.keys(loaded?.doc.edges ?? {})).toEqual(Object.keys(doc.edges));
    expect(loaded?.doc.rootNodeId).toBe(doc.rootNodeId);
  });

  it('persists note text and world positions exactly', async () => {
    const doc = build('Exact');
    await repository.save({ doc, savedAt: Date.now() });
    const loaded = await repository.load(doc.id);

    for (const [id, node] of Object.entries(doc.nodes)) {
      expect(loaded?.doc.nodes[id]?.content).toBe(node.content);
      expect(loaded?.doc.nodes[id]?.position).toEqual(node.position);
      expect(loaded?.doc.nodes[id]?.parentId).toBe(node.parentId);
    }
  });

  it('overwrites the previous snapshot of the same document', async () => {
    const doc = build('Versioned');
    await repository.save({ doc, savedAt: 1 });

    const edited = updateNodeContent(doc, doc.rootNodeId, 'second version');
    if (!edited.ok) throw new Error(edited.message);
    await repository.save({ doc: edited.value.doc, savedAt: 2 });

    const loaded = await repository.load(doc.id);
    expect(loaded?.savedAt).toBe(2);
    expect(loaded?.doc.nodes[doc.rootNodeId]?.content).toBe('second version');
    expect(await repository.list()).toHaveLength(1);
  });

  it('remembers which document was open last', async () => {
    repository.setLastOpenedId('doc_abc');
    expect(repository.getLastOpenedId()).toBe('doc_abc');
  });

  it('lists stored documents for a future document picker', async () => {
    const first = build('First');
    const second = build('Second');
    await repository.save({ doc: first, savedAt: 10 });
    await repository.save({ doc: second, savedAt: 20 });

    const list = await repository.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.savedAt).toBe(20);
    expect(list[0]?.nodeCount).toBe(2);
  });

  it('removes a document', async () => {
    const doc = build('Temporary');
    await repository.save({ doc, savedAt: Date.now() });
    await repository.remove(doc.id);
    expect(await repository.load(doc.id)).toBeNull();
  });

  it('falls back to the emergency mirror when the primary record is gone', async () => {
    const doc = build('Mirror');
    await repository.save({ doc, savedAt: 42 });

    // Simulate a dropped IndexedDB write (quota, unload race) by clearing the
    // object store directly and leaving only the localStorage mirror behind.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('documents', 'readwrite');
        transaction.objectStore('documents').clear();
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });

    const recovered = await repository.load(doc.id);
    expect(recovered?.doc.title).toBe('Mirror');
  });
});

describe('document repository (in-memory fallback)', () => {
  it('behaves like the real store so the app still runs when storage is blocked', async () => {
    const repository = createMemoryRepository();
    expect(repository.kind).toBe('memory');

    const doc = build('Memory');
    await repository.save({ doc, savedAt: 7 });
    const loaded = await repository.load(doc.id);

    expect(loaded?.doc.title).toBe('Memory');
    expect(loaded?.savedAt).toBe(7);
    expect(await repository.list()).toHaveLength(1);
  });
});
