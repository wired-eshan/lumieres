import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBranch,
  createEmptyDocument,
  getAncestorIds,
  updateNodeContent,
} from '../graph/graphOperations';
import type { GraphDocument, NodeId } from '../graph/types';
import { LineageSummaryStore, lineageFingerprint } from './lineageSummaryStore';
import { makeProviderProfile, createDefaultAISettings, type AISettings } from './settings';
import { LineageSummarizer, type LineageSummarizerDeps } from './summarizer';

function settingsWithKey(key: string): AISettings {
  const settings = createDefaultAISettings();
  settings.profiles[settings.providerId] = makeProviderProfile(settings.providerId, {
    apiKey: key,
  });
  return settings;
}

function chain(): { doc: GraphDocument; leafId: NodeId } {
  let doc = createEmptyDocument('Two sum');
  const root = doc.rootNodeId;
  const withContent = updateNodeContent(
    doc,
    root,
    'Find two numbers that add up to a target using a hash map. O(n) time.',
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

function makeSummarizer(overrides: Partial<LineageSummarizerDeps> = {}): {
  summarizer: LineageSummarizer;
  store: LineageSummaryStore;
  generate: ReturnType<typeof vi.fn>;
} {
  const store = new LineageSummaryStore(8);
  const generate = vi.fn(async () => ({ text: 'A condensed lineage summary.' }));
  const summarizer = new LineageSummarizer({
    store,
    getSettings: () => settingsWithKey('sk-test'),
    generate,
    newId: () => 'sum1',
    now: () => 0,
    maxConcurrent: 1,
    targetCharacters: 200,
    maxSummaryCharacters: 800,
    ...overrides,
  });
  return { summarizer, store, generate };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LineageSummaryStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('round-trips a summary and is LRU-touch aware', () => {
    const store = new LineageSummaryStore(3);
    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    expect(store.get('b')).toBe('2');
    // Touching b makes it most-recent; a is now oldest and evicted next.
    store.set('d', '4');
    expect(store.has('a')).toBe(false);
    expect(store.has('b')).toBe(true);
  });

  it('changes the fingerprint when an ancestor content version changes', () => {
    const { doc, leafId } = chain();
    const items = (document: GraphDocument, id: NodeId) =>
      getAncestorIds(document, id).map((nid) => ({
        id: nid,
        contentVersion: document.nodes[nid]?.contentVersion ?? 0,
      }));
    const before = lineageFingerprint(doc.rootNodeId, items(doc, leafId));
    const edited = updateNodeContent(doc, doc.rootNodeId, 'Changed root content.');
    if (!edited.ok) throw new Error(edited.message);
    const after = lineageFingerprint(doc.rootNodeId, items(edited.value.doc, leafId));
    expect(after).not.toBe(before);
  });
});

describe('LineageSummarizer.warm', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('makes no provider call and caches nothing when no key is configured', () => {
    const { summarizer, store, generate } = makeSummarizer({
      getSettings: () => settingsWithKey(''),
    });
    const { doc, leafId } = chain();
    summarizer.warm(leafId, doc, 'explain this more clearly');
    expect(generate).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('is a no-op when the node has no lineage (the root node)', () => {
    const { summarizer, generate } = makeSummarizer();
    const doc = createEmptyDocument('Solo');
    summarizer.warm(doc.rootNodeId, doc, 'anything');
    expect(generate).not.toHaveBeenCalled();
  });

  it('calls the provider once, caches the result, and does not call again for the same chain', async () => {
    const { summarizer, store, generate } = makeSummarizer();
    const { doc, leafId } = chain();

    summarizer.warm(leafId, doc, 'explain this more clearly');
    expect(generate).toHaveBeenCalledTimes(1); // invoked synchronously before the await
    await flush();
    expect(store.size).toBe(1);

    // Warming the same (unchanged) chain hits the cache.
    summarizer.warm(leafId, doc, 'again');
    await flush();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(1);
  });

  it('respects the dedicated concurrency gate', () => {
    const { summarizer, generate } = makeSummarizer({ maxConcurrent: 0 });
    const { doc, leafId } = chain();
    summarizer.warm(leafId, doc, 'explain');
    expect(generate).not.toHaveBeenCalled();
  });
});