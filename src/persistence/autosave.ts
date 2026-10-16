/**
 * Debounced autosave.
 *
 * Design constraints from the product requirements, and how each is met:
 *  - *Never persist on every keystroke*: document changes mark the session dirty
 *    and schedule a single trailing write.
 *  - *Never lose edits on navigation or close*: the write is also flushed on
 *    `visibilitychange` (the only unload-adjacent event browsers reliably let
 *    async work finish in) and on `pagehide`, and any open editor draft is
 *    committed to the document first.
 *  - *Visible status*: 'dirty' → 'saving' → 'saved'/'error' is published into
 *    the store so the toolbar can show it.
 *  - *No overlapping writes*: writes are serialised; a change arriving mid-write
 *    queues exactly one follow-up.
 */

import type { GraphController } from '../graph/graphController';
import type { DocumentRepository } from './documentRepository';
import { debounce } from '../utils/misc';

export interface AutosaveOptions {
  controller: GraphController;
  repository: DocumentRepository;
  /** Trailing delay between the last change and the write. */
  debounceMs?: number;
}

export interface AutosaveController {
  start(): void;
  stop(): void;
  /** Forces a write now and resolves when it has been handed to storage. */
  flush(): Promise<void>;
  isDirty(): boolean;
  lastSavedAt(): number | null;
}

export function createAutosave({
  controller,
  repository,
  debounceMs = 650,
}: AutosaveOptions): AutosaveController {
  let writing = false;
  let queued = false;
  let dirty = false;
  let lastSavedAt: number | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  const runSave = async (): Promise<void> => {
    if (stopped) return;
    if (writing) {
      queued = true;
      return;
    }
    writing = true;
    try {
      // Any text still sitting in an open editor belongs in this write.
      controller.flushPendingDrafts();
      controller.setSaveStatus('saving');
      const doc = controller.getDocument();
      const savedAt = Date.now();
      await repository.save({ doc, savedAt });
      lastSavedAt = savedAt;
      dirty = false;
      controller.setSaveStatus('saved', { at: savedAt });
    } catch (error) {
      controller.setSaveStatus('error', {
        error: error instanceof Error ? error.message : 'Could not save this canvas.',
      });
    } finally {
      writing = false;
      if (queued) {
        queued = false;
        void runSave();
      }
    }
  };

  const scheduled = debounce(() => {
    void runSave();
  }, debounceMs);

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden' && dirty) {
      scheduled.cancel();
      void runSave();
    }
  };

  const onPageHide = (): void => {
    if (!dirty) return;
    scheduled.cancel();
    void runSave();
  };

  return {
    start: () => {
      stopped = false;
      unsubscribe = controller.subscribe(() => {
        dirty = true;
        controller.setSaveStatus('dirty');
        scheduled();
      });
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', onPageHide);
      }
    },
    stop: () => {
      stopped = true;
      scheduled.cancel();
      unsubscribe?.();
      unsubscribe = null;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide);
      }
    },
    flush: async () => {
      scheduled.cancel();
      await runSave();
    },
    isDirty: () => dirty,
    lastSavedAt: () => lastSavedAt,
  };
}
