/**
 * Application shell and boot sequence.
 *
 * Boot order matters: the canvas engine mounts with the tree (so it has a
 * viewport), the store→engine bridge is attached, and only then is the stored
 * document loaded. Autosave is started last, once there is something to save and
 * a real document id to save it under.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useController, useEngine, useEngineSnapshot } from './EngineContext';
import { useGraphStore } from '../graph/graphStore';
import { validateGraph, type ValidationIssue } from '../graph/graphValidation';
import { createAutosave, type AutosaveController } from '../persistence/autosave';
import { createDocumentRepository, type RepositoryKind } from '../persistence/documentRepository';
import { chatRuntime } from '../ai/chatRuntime';
import { GraphCanvas } from '../components/canvas/GraphCanvas';
import { CanvasToolbar } from '../components/canvas/CanvasToolbar';
import { ProductTour, type ProductTourHandle } from '../components/onboarding/ProductTour';
import { ConfirmDialog } from '../components/panels/ConfirmDialog';
import { HelpPanel } from '../components/panels/HelpPanel';
import { IssueBanner } from '../components/panels/IssueBanner';
import { SettingsPanel } from '../components/panels/SettingsPanel';
import { Toasts } from '../components/panels/Toasts';
import { UIProvider, type UICommands } from './UIContext';

export function App(): ReactNode {
  const engine = useEngine();
  const controller = useController();
  const doc = useGraphStore((state) => state.doc);

  const [ready, setReady] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [repositoryKind, setRepositoryKind] = useState<RepositoryKind>('memory');
  const autosaveRef = useRef<AutosaveController | null>(null);
  const tourRef = useRef<ProductTourHandle>(null);

  // --- Store → engine bridge. Every document change reaches the renderer with
  // a hint about which nodes moved, so no full-graph diffing happens per edit.
  useEffect(
    () =>
      controller.subscribe((nextDoc, change) => {
        engine.setDocument(nextDoc, change);
        // A deleted/reset window cannot finish a stream usefully; release its
        // request and per-node session instead of leaving it running invisibly.
        // A load/import replacement invalidates every session and continuation
        // id; undo/redo also sets `full` but must not abort unrelated streams.
        if (change.replaced) chatRuntime.disposeAll();
        else for (const id of change.removed) chatRuntime.dispose(id);
      }),
    [controller, engine],
  );

  // --- Boot: pick a store, restore the last document, start autosave.
  useEffect(() => {
    let disposed = false;

    const boot = async (): Promise<void> => {
      const repository = await createDocumentRepository();
      if (disposed) return;

      const autosave = createAutosave({ controller, repository });
      autosaveRef.current = autosave;

      const lastOpenedId = repository.getLastOpenedId();
      const stored = lastOpenedId ? await repository.load(lastOpenedId) : null;
      if (disposed) return;

      if (stored) {
        controller.replaceDocument(stored.doc, { resetHistory: true });
        controller.setSaveStatus('saved', { at: stored.savedAt });
        const found = validateGraph(stored.doc);
        if (found.length > 0) setIssues(found);
        repository.setLastOpenedId(stored.doc.id);
        // Wait for the first paint so the viewport size is known.
        requestAnimationFrame(() => engine.fitToView());
      } else {
        const fresh = controller.getDocument();
        repository.setLastOpenedId(fresh.id);
        controller.setSaveStatus('idle');
      }

      controller.setDraftFlusher(() => engine.flushDraft());
      controller.setWriteFlusher(() => autosave.flush());
      autosave.start();
      setRepositoryKind(repository.kind);
      setReady(true);
    };

    void boot();

    return () => {
      disposed = true;
      autosaveRef.current?.stop();
      autosaveRef.current = null;
      controller.setDraftFlusher(null);
      controller.setWriteFlusher(null);
    };
  }, [controller, engine]);

  // --- Warn before losing unsaved work on a hard close. Best-effort only:
  // modern browsers decide whether to show it.
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (autosaveRef.current?.isDirty()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  const handleIssues = useCallback((next: ValidationIssue[], nextNotes: string[]) => {
    setIssues(next);
    setNotes(nextNotes);
  }, []);

  const dismissIssues = useCallback(() => {
    setIssues([]);
    setNotes([]);
  }, []);

  const replayTour = useCallback(() => {
    setHelpOpen(false);
    tourRef.current?.start();
  }, []);

  const focusNode = useCallback(
    (nodeId: string) => {
      engine.setSelection([nodeId]);
      engine.focusNode(nodeId);
    },
    [engine],
  );

  const isEmptyCanvas = useMemo(() => {
    const nodes = Object.values(doc.nodes);
    return (
      nodes.length === 1 &&
      nodes[0]?.parentId === null &&
      nodes[0]?.content.trim().length === 0 &&
      nodes[0]?.chat.length === 0
    );
  }, [doc]);

  const uiCommands = useMemo<UICommands>(
    () => ({ openSettings: () => setSettingsOpen(true) }),
    [],
  );

  return (
    <UIProvider commands={uiCommands}>
      <div className="app">
        <CanvasToolbar
          onIssues={handleIssues}
          onHelp={() => setHelpOpen(true)}
          onSettings={() => setSettingsOpen(true)}
        />
        <GraphCanvas onHelpRequested={() => setHelpOpen(true)}>
          {isEmptyCanvas ? <FirstRunHint /> : null}
          <CanvasReadout />
        </GraphCanvas>

        {issues.length > 0 || notes.length > 0 ? (
          <IssueBanner
            issues={issues}
            notes={notes}
            onDismiss={dismissIssues}
            onFocusNode={focusNode}
          />
        ) : null}

        <Toasts />
        <ConfirmDialog />
        <HelpPanel
          open={helpOpen}
          onClose={() => setHelpOpen(false)}
          onReplayTour={replayTour}
        />
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <ProductTour ref={tourRef} ready={ready} />

        {!ready ? (
          <div className="boot-overlay" role="status" aria-live="polite">
            <span className="boot-overlay__spinner" aria-hidden="true" />
            Restoring your canvas…
          </div>
        ) : null}

        {repositoryKind === 'memory' && ready ? (
          <div className="storage-warning" role="status">
            Local storage is unavailable in this browser, so this canvas will not survive a refresh.
            Export it to keep your work.
          </div>
        ) : null}
      </div>
    </UIProvider>
  );
}

function FirstRunHint(): ReactNode {
  return (
    <div className="first-run-hint" data-overlay="true">
      <strong>Start here</strong>
      <span>
        Type in the root note, then <em>select a phrase</em> and choose <em>Create branch</em> to grow
        the graph. Switch any window to <em>AI</em> to chat with your own key.
      </span>
    </div>
  );
}

/** Live readout of what the renderer is actually drawing (dev-facing, unobtrusive). */
function CanvasReadout(): ReactNode {
  const selectedCount = useEngineSnapshot((snapshot) => snapshot.selectedIds.length);
  const nodeCount = useEngineSnapshot((snapshot) => snapshot.nodeCount);
  if (nodeCount < 2) return null;
  return (
    <div className="canvas-readout" data-overlay="true" aria-hidden="true">
      {nodeCount} {nodeCount === 1 ? 'window' : 'windows'}
      {selectedCount > 1 ? ` · ${selectedCount} selected` : ''}
    </div>
  );
}
