/**
 * The only permanent chrome: document identity and essential actions.
 *
 * It subscribes to narrow store slices (title, revision, save status) so typing
 * in a note does not re-render it, and it owns no graph logic — every action
 * goes through the controller or the engine.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useController, useEngine } from '../../app/EngineContext';
import { useGraphStore } from '../../graph/graphStore';
import { computeStats, type ValidationIssue } from '../../graph/graphValidation';
import { downloadDocument, importFromFile } from '../../persistence/importExport';
import { chatRuntime } from '../../ai/chatRuntime';
import { formatCount, truncate } from '../../utils/misc';
import {
  BranchIcon,
  DownloadIcon,
  HelpIcon,
  RedoIcon,
  ResetIcon,
  SettingsIcon,
  UndoIcon,
  UploadIcon,
} from '../icons';

export interface CanvasToolbarProps {
  onIssues: (issues: ValidationIssue[], notes: string[]) => void;
  onHelp: () => void;
  onSettings: () => void;
}

export function CanvasToolbar({ onIssues, onHelp, onSettings }: CanvasToolbarProps): ReactNode {
  const engine = useEngine();
  const controller = useController();
  const doc = useGraphStore((state) => state.doc);
  const canUndo = useGraphStore((state) => state.history.past.length > 0);
  const canRedo = useGraphStore((state) => state.history.future.length > 0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(doc.title);

  useEffect(() => setTitle(doc.title), [doc.title]);

  const commitTitle = (): void => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setTitle(doc.title);
      engine.notify('A canvas needs a title.', 'error');
      return;
    }
    if (trimmed !== doc.title) controller.setDocumentTitle(trimmed);
  };

  const stats = computeStats(doc);

  const handleImport = async (file: File): Promise<void> => {
    const outcome = await importFromFile(file);
    if (!outcome.doc) {
      onIssues(outcome.issues, outcome.notes);
      return;
    }
    engine.stopEditing({ commit: false });
    chatRuntime.disposeAll();
    controller.replaceDocument(outcome.doc, { resetHistory: true });
    engine.fitToView();
    onIssues(outcome.issues, outcome.notes);
    engine.notify(
      `Imported “${truncate(outcome.doc.title, 32)}” — ${formatCount(Object.keys(outcome.doc.nodes).length)} notes`,
      'success',
    );
  };

  return (
    <header className="toolbar" data-overlay="true">
      <div className="toolbar__left">
        <span className="toolbar__mark" aria-hidden="true">
          <BranchIcon size={15} />
        </span>
        <input
          className="toolbar__title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              setTitle(doc.title);
              event.currentTarget.blur();
            }
          }}
          aria-label="Canvas title"
          spellCheck={false}
        />
        <span className="toolbar__stats" title="Notes · branches per node · depth">
          {formatCount(stats.nodeCount)} {stats.nodeCount === 1 ? 'window' : 'windows'} · max{' '}
          {stats.maxChildren}/50 branches · depth {stats.maxDepth}
        </span>
      </div>

      <div className="toolbar__right">
        <SaveIndicator />

        <span className="toolbar__divider" />

        <button
          type="button"
          className="icon-button"
          onClick={() => engine.undo()}
          disabled={!canUndo}
          title="Undo (⌘Z)"
          aria-label="Undo"
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => engine.redo()}
          disabled={!canRedo}
          title="Redo (⇧⌘Z)"
          aria-label="Redo"
        >
          <RedoIcon />
        </button>

        <span className="toolbar__divider" />

        <button
          type="button"
          className="icon-button"
          onClick={() => downloadDocument(doc)}
          title="Export this canvas as JSON (⌘E)"
          aria-label="Export canvas"
        >
          <DownloadIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => fileInputRef.current?.click()}
          title="Import a canvas from JSON (⌘O)"
          aria-label="Import canvas"
        >
          <UploadIcon />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleImport(file);
          }}
        />

        <button
          type="button"
          className="icon-button is-danger"
          onClick={() => engine.requestReset()}
          title="Reset the canvas — removes every note"
          aria-label="Reset canvas"
        >
          <ResetIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onSettings}
          title="AI settings — provider, API key, model and effort"
          aria-label="AI settings"
        >
          <SettingsIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={onHelp}
          title="Keyboard shortcuts and help (⌘⇧? / Ctrl+Shift+?)"
          aria-label="Help"
        >
          <HelpIcon />
        </button>
      </div>
    </header>
  );
}

function SaveIndicator(): ReactNode {
  const status = useGraphStore((state) => state.saveStatus);
  const lastSavedAt = useGraphStore((state) => state.lastSavedAt);
  const error = useGraphStore((state) => state.saveError);

  const label =
    status === 'saving'
      ? 'Saving…'
      : status === 'dirty'
        ? 'Unsaved changes'
        : status === 'error'
          ? 'Save failed'
          : lastSavedAt
            ? `Saved ${formatRelative(lastSavedAt)}`
            : 'Autosave on';

  return (
    <span
      className={`save-indicator is-${status}`}
      role="status"
      aria-live="polite"
      title={error ?? 'Your canvas is stored locally in this browser'}
    >
      <span className="save-indicator__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function formatRelative(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
