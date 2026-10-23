import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument } from './graphOperations';
import { useGraphStore } from './graphStore';

beforeEach(() => {
  useGraphStore
    .getState()
    .replaceDocument(createEmptyDocument('Store test'), { resetHistory: true });
});

describe('document change hints', () => {
  it('marks load/import as a replacement, but not undo or redo', () => {
    expect(useGraphStore.getState().lastChange).toMatchObject({
      full: true,
      replaced: true,
    });

    const root = useGraphStore.getState().doc.rootNodeId;
    const added = useGraphStore.getState().addBranch(root, {
      position: { x: 400, y: 0 },
    });
    expect(added.ok).toBe(true);
    expect(useGraphStore.getState().lastChange).toMatchObject({
      full: false,
      replaced: false,
    });

    useGraphStore.getState().undo();
    expect(useGraphStore.getState().lastChange).toMatchObject({
      full: true,
      replaced: false,
    });

    useGraphStore.getState().redo();
    expect(useGraphStore.getState().lastChange).toMatchObject({
      full: true,
      replaced: false,
    });
  });
});
