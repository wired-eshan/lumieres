import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave } from './autosave';
import { createDocumentRepository, createMemoryRepository, type DocumentRepository, type StoredDocument } from './documentRepository';
import { graphController } from '../graph/graphController';
import { useGraphStore } from '../graph/graphStore';
import { createBranch, createEmptyDocument, updateNodeContent } from '../graph/graphOperations';

function resetStore(): string {
  const doc = createEmptyDocument('Autosave test');
  useGraphStore.getState().replaceDocument(doc, { resetHistory: true });
  useGraphStore.getState().setSaveStatus('idle');
  return doc.rootNodeId;
}

/** Repository that records every write so timing can be asserted. */
class RecordingRepository implements DocumentRepository {
  readonly kind = 'memory' as const;
  readonly writes: StoredDocument[] = [];
  private readonly inner = createMemoryRepository();

  async load(id: string): Promise<StoredDocument | null> {
    return this.inner.load(id);
  }

  async save(snapshot: StoredDocument): Promise<void> {
    this.writes.push(snapshot);
    await this.inner.save(snapshot);
  }

  async list() {
    return this.inner.list();
  }

  async remove(id: string) {
    return this.inner.remove(id);
  }

  getLastOpenedId() {
    return this.inner.getLastOpenedId();
  }

  setLastOpenedId(id: string) {
    this.inner.setLastOpenedId(id);
  }
}

describe('debounced autosave', () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetStore();
  });

  it('does not write on every change', async () => {
    const repository = new RecordingRepository();
    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 20 });
    autosave.start();

    const rootId = useGraphStore.getState().doc.rootNodeId;
    for (let index = 0; index < 25; index += 1) {
      graphController.updateContent(rootId, `keystroke ${index}`);
    }

    expect(repository.writes).toHaveLength(0);
    await autosave.flush();
    expect(repository.writes).toHaveLength(1);
    autosave.stop();
  });

  it('writes once after the debounce window closes', async () => {
    const repository = new RecordingRepository();
    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 10 });
    autosave.start();

    const rootId = useGraphStore.getState().doc.rootNodeId;
    graphController.updateContent(rootId, 'hello');
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(repository.writes).toHaveLength(1);
    expect(repository.writes[0]?.doc.nodes[rootId]?.content).toBe('hello');
    autosave.stop();
  });

  it('publishes save status transitions', async () => {
    const repository = new RecordingRepository();
    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 5 });
    autosave.start();

    const seen: string[] = [];
    const unsubscribe = graphController.subscribeSaveStatus((status) => seen.push(status));

    graphController.updateContent(useGraphStore.getState().doc.rootNodeId, 'text');
    await autosave.flush();

    expect(seen).toContain('dirty');
    expect(seen).toContain('saving');
    expect(seen).toContain('saved');
    expect(useGraphStore.getState().saveStatus).toBe('saved');
    expect(useGraphStore.getState().lastSavedAt).not.toBeNull();

    unsubscribe();
    autosave.stop();
  });

  it('surfaces a storage failure instead of pretending to save', async () => {
    const failing: DocumentRepository = {
      ...createMemoryRepository(),
      kind: 'memory',
      save: async () => {
        throw new Error('quota exceeded');
      },
    };
    const autosave = createAutosave({ controller: graphController, repository: failing, debounceMs: 5 });
    autosave.start();

    graphController.updateContent(useGraphStore.getState().doc.rootNodeId, 'text');
    await autosave.flush();

    expect(useGraphStore.getState().saveStatus).toBe('error');
    expect(useGraphStore.getState().saveError).toContain('quota');
    autosave.stop();
  });

  it('serialises overlapping writes rather than interleaving them', async () => {
    const repository = new RecordingRepository();
    let concurrent = 0;
    let maxConcurrent = 0;
    const originalSave = repository.save.bind(repository);
    repository.save = async (snapshot) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await originalSave(snapshot);
      concurrent -= 1;
    };

    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 1 });
    autosave.start();

    const rootId = useGraphStore.getState().doc.rootNodeId;
    graphController.updateContent(rootId, 'one');
    const first = autosave.flush();
    graphController.updateContent(rootId, 'two');
    const second = autosave.flush();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    autosave.stop();
  });
});

describe('document restoration', () => {
  beforeEach(() => {
    resetStore();
  });

  it('restores a stored graph into a fresh store', async () => {
    const repository = await createDocumentRepository();

    // Build and author a graph.
    const rootId = useGraphStore.getState().doc.rootNodeId;
    graphController.updateContent(rootId, 'Root content that must come back');
    const branch = graphController.addBranch(rootId, { position: { x: 720, y: 40 }, title: 'Branch' });
    expect(branch.ok).toBe(true);
    if (!branch.ok) return;

    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 5 });
    autosave.start();
    await autosave.flush();
    autosave.stop();

    const storedId = useGraphStore.getState().doc.id;

    // Simulate a refresh: brand-new store contents with a different document.
    useGraphStore.getState().replaceDocument(createEmptyDocument('Different canvas'), { resetHistory: true });
    expect(useGraphStore.getState().doc.nodes[rootId]).toBeUndefined();

    const loaded = await repository.load(storedId);
    expect(loaded).not.toBeNull();
    if (!loaded) return;
    useGraphStore.getState().replaceDocument(loaded.doc, { resetHistory: true });

    const restored = useGraphStore.getState().doc;
    expect(restored.nodes[rootId]?.content).toBe('Root content that must come back');
    expect(restored.nodes[branch.value.node.id]?.title).toBe('Branch');
    expect(restored.nodes[branch.value.node.id]?.position).toEqual({ x: 720, y: 40 });
    expect(restored.nodes[branch.value.node.id]?.parentId).toBe(rootId);
  });

  it('restores a user-selected text range as a branch source reference', async () => {
    const repository = await createDocumentRepository();
    const rootId = useGraphStore.getState().doc.rootNodeId;
    const text = 'Photosynthesis converts light into chemical energy.';
    graphController.updateContent(rootId, text);

    const start = text.indexOf('chemical energy');
    const end = start + 'chemical energy'.length;
    const source = useGraphStore.getState().doc.nodes[rootId];
    if (!source) throw new Error('root missing');

    const branch = graphController.addBranch(rootId, {
      position: { x: 720, y: 0 },
      title: 'chemical energy',
      sourceReference: {
        sourceNodeId: rootId,
        selectedTextSnapshot: text.slice(start, end),
        startOffset: start,
        endOffset: end,
        sourceContentVersion: source.contentVersion,
      },
    });
    if (!branch.ok) throw new Error(branch.message);

    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 5 });
    autosave.start();
    await autosave.flush();
    autosave.stop();

    const loaded = await repository.load(useGraphStore.getState().doc.id);
    const reference = loaded?.doc.nodes[branch.value.node.id]?.sourceReference;
    expect(reference?.startOffset).toBe(start);
    expect(reference?.endOffset).toBe(end);
    expect(reference?.selectedTextSnapshot).toBe('chemical energy');
    // Offsets still address the same characters after a round trip.
    const restoredSource = loaded?.doc.nodes[reference?.sourceNodeId ?? ''];
    expect(restoredSource?.content.slice(reference?.startOffset, reference?.endOffset)).toBe(
      'chemical energy',
    );
  });

  it('has no ordering surprises when a branch is created then edited quickly', async () => {
    const repository = new RecordingRepository();
    const autosave = createAutosave({ controller: graphController, repository, debounceMs: 5 });
    autosave.start();

    const rootId = useGraphStore.getState().doc.rootNodeId;
    const branch = createBranch(useGraphStore.getState().doc, {
      parentId: rootId,
      position: { x: 500, y: 0 },
    });
    if (!branch.ok) throw new Error(branch.message);
    useGraphStore.getState().addBranch(rootId, { position: { x: 500, y: 0 } });
    const childId = Object.values(useGraphStore.getState().doc.nodes).find(
      (node) => node.parentId === rootId,
    )?.id;
    if (!childId) throw new Error('child missing');
    updateNodeContent(useGraphStore.getState().doc, childId, 'child text');

    await autosave.flush();
    const last = repository.writes[repository.writes.length - 1];
    expect(last?.doc.nodes[childId]).toBeDefined();
    autosave.stop();
  });
});
