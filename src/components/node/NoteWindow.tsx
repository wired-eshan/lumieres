/**
 * The open note window.
 *
 * This is the one place where a note is edited, and it is a real `<textarea>`:
 * native caret handling, IME composition, spell check, paste and screen-reader
 * support all come for free. Everything else about a note — its frame, preview
 * text, edges — is painted on the canvas underneath.
 *
 * The window is positioned by the engine (which writes `transform` every frame)
 * rather than by React, so panning and zooming never re-render it. Its typography
 * is specified in world units from the shared metrics module, so the editor lines
 * up exactly with the canvas preview it replaces.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useController, useEngine } from '../../app/EngineContext';
import { useGraphStore } from '../../graph/graphStore';
import { evaluateSourceReference } from '../../graph/graphOperations';
import {
  BODY_FONT_SIZE,
  BODY_LINE_HEIGHT,
  NODE_CONTENT_PADDING,
  NODE_FOOTER_HEIGHT,
  NODE_HEADER_HEIGHT,
  NODE_HEIGHT,
  NODE_WIDTH,
  bodyTopOffset,
} from '../../graph/metrics';
import { MAX_CHILDREN_PER_NODE } from '../../graph/types';
import { CHARACTER_LIMIT, applyTextEdit, limitMessage, limitStatus } from '../../editor/characterLimit';
import type { BranchActionState } from '../../canvas/engine';
import { branchAnchorWorld, measureSelection, readSelection } from '../../editor/selection';
import { formatCount } from '../../utils/misc';

export interface NoteWindowProps {
  nodeId: string;
}

export function NoteWindow({ nodeId }: NoteWindowProps): ReactNode {
  const engine = useEngine();
  const controller = useController();
  const doc = useGraphStore((state) => state.doc);
  const node = doc.nodes[nodeId];

  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<number | null>(null);
  const [content, setContent] = useState(node?.content ?? '');
  const [title, setTitle] = useState(node?.title ?? '');

  const hasSourceChip = Boolean(node?.sourceReference);
  const bodyTop = bodyTopOffset(hasSourceChip);
  const bodyHeight = NODE_HEIGHT - NODE_FOOTER_HEIGHT - bodyTop - 6;
  const contentWidth = NODE_WIDTH - NODE_CONTENT_PADDING * 2;

  const storeContent = node?.content ?? '';
  const childCount = useMemo(
    () => Object.values(doc.nodes).filter((candidate) => candidate.parentId === nodeId).length,
    [doc.nodes, nodeId],
  );
  const sourceEvaluation = useMemo(
    () => (node ? evaluateSourceReference(doc, node) : null),
    [doc, node],
  );

  /* -------------------------------------------------------------- */
  /* Selection → branch action                                       */
  /* -------------------------------------------------------------- */

  /**
   * Reads the live selection out of the open editor, as a branch action.
   *
   * This is the single definition of "what is selected right now": the engine
   * uses it to show the floating action, and asks for it again when the action
   * is clicked — so a click always branches from what the user can see selected,
   * never from a stale copy of it.
   */
  const readBranchAction = useCallback((): BranchActionState | null => {
    const textarea = textareaRef.current;
    if (!textarea) return null;
    const selection = readSelection(textarea);
    if (!selection) return null;
    const geometry = measureSelection(textarea, selection.start, selection.end);
    if (!geometry || geometry.text.trim().length === 0) return null;
    const current = engine.getNode(nodeId);
    if (!current) return null;
    return {
      nodeId,
      text: geometry.text,
      start: selection.start,
      end: selection.end,
      // The textarea sits at this origin inside the window; the engine converts
      // world → screen each frame, so the button tracks the camera and hangs the
      // control off the window's top edge.
      anchor: branchAnchorWorld(current.position, NODE_CONTENT_PADDING, geometry),
    };
  }, [engine, nodeId]);

  const syncBranchAction = useCallback(() => {
    engine.setBranchAction(readBranchAction());
  }, [engine, readBranchAction]);

  const scheduleBranchSync = useCallback(() => {
    requestAnimationFrame(syncBranchAction);
  }, [syncBranchAction]);

  /* -------------------------------------------------------------- */
  /* Engine wiring                                                   */
  /* -------------------------------------------------------------- */

  useEffect(() => {
    engine.registerEditingElement(rootRef.current);
    return () => {
      engine.registerEditingElement(null);
      engine.clearBranchActionFor(nodeId);
    };
  }, [engine, nodeId]);

  // The engine re-reads the selection through this resolver when a branch is
  // created, so the branch reflects the live selection rather than a cached copy.
  useEffect(() => {
    engine.registerSelectionResolver(readBranchAction);
    return () => engine.registerSelectionResolver(null);
  }, [engine, readBranchAction]);

  // Focus on mount so a freshly created branch is immediately typeable.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const frame = requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      // This frame can land after the user has already started selecting — the
      // canvas may have kept the browser busy for longer than a frame. Placing
      // the caret then would collapse the selection they just made, which also
      // dismisses the branch action it was about to offer.
      if (textarea.selectionStart !== textarea.selectionEnd) return;
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(frame);
  }, [nodeId]);

  // Adopt external content changes (undo, redo, import) that did not come from
  // this editor. Local edits are already in `content`, so this is a no-op then.
  useEffect(() => {
    const draft = engine.getDraft(nodeId);
    if (draft === null || draft !== storeContent) setContent(storeContent);
  }, [storeContent, engine, nodeId]);

  useEffect(() => {
    setTitle(node?.title ?? '');
  }, [node?.title]);

  // Restore the caret, but only when the value we committed differs from what the
  // browser produced (a trimmed or refused edit). Any other edit leaves the
  // native caret alone.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || caretRef.current === null) return;
    const caret = caretRef.current;
    caretRef.current = null;
    textarea.setSelectionRange(caret, caret);
  }, [content]);

  /* -------------------------------------------------------------- */
  /* Editing                                                         */
  /* -------------------------------------------------------------- */

  const handleContentChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const target = event.target;
      const next = target.value;
      // The browser has already applied the edit and placed the caret where the
      // user expects it (including mid-text typing and backspace). Keep it.
      const caretInNext =
        typeof target.selectionStart === 'number' ? target.selectionStart : next.length;
      const result = applyTextEdit(content, next, CHARACTER_LIMIT, caretInNext);
      if (result.limited) {
        const status = limitStatus(result.value);
        if (result.rejected) {
          engine.notify(limitMessage(limitStatus(content)) ?? 'Character limit reached.', 'error');
        } else {
          engine.notify(
            `Trimmed ${formatCount(result.droppedCharacters)} characters to stay within the ${formatCount(status.limit)}-character limit.`,
            'info',
          );
        }
      }
      if (result.value !== next) {
        // We replaced what the browser produced, so the caret has to be restored:
        // assigning `value` parks it at the end of the field.
        target.value = result.value;
        caretRef.current = result.caret;
      }
      setContent(result.value);
      engine.setDraft(nodeId, result.value);
      scheduleBranchSync();
    },
    [content, engine, nodeId, scheduleBranchSync],
  );

  const handleTitleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setTitle(event.target.value);
      controller.updateTitle(nodeId, event.target.value);
    },
    [controller, nodeId],
  );

  const status = limitStatus(content);
  const message = limitMessage(status);

  if (!node) return null;

  return (
    <div
      className="note-window"
      data-overlay="true"
      ref={rootRef}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      role="group"
      aria-label={`Note: ${node.title || 'untitled'}`}
    >
      <header className="note-window__header" style={{ height: NODE_HEADER_HEIGHT }}>
        <span className={`note-window__accent${node.id === doc.rootNodeId ? ' is-root' : ''}`} />
        <input
          className="note-window__title"
          value={title}
          onChange={handleTitleChange}
          placeholder="Untitled note"
          aria-label="Note title"
          spellCheck={false}
        />
        <div className="note-window__actions">
          <button
            type="button"
            className="icon-button"
            title={
              childCount >= MAX_CHILDREN_PER_NODE
                ? `Branch limit reached (${MAX_CHILDREN_PER_NODE})`
                : 'Create a branch from this note'
            }
            aria-label="Create a branch from this note"
            disabled={childCount >= MAX_CHILDREN_PER_NODE}
            onClick={() => engine.createBranchFromNode(nodeId)}
          >
            <BranchIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Collapse this note"
            aria-label="Collapse this note"
            onClick={() => engine.toggleCollapsed(nodeId)}
          >
            <CollapseIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Focus this note"
            aria-label="Focus this note"
            onClick={() => engine.focusNode(nodeId)}
          >
            <FocusIcon />
          </button>
          <button
            type="button"
            className="icon-button is-danger"
            title="Delete this note and everything branching from it"
            aria-label="Delete this note and its branches"
            onClick={() => engine.requestDelete([nodeId])}
          >
            <TrashIcon />
          </button>
        </div>
      </header>

      {sourceEvaluation?.reference ? (
        <div
          className={`note-window__source${sourceEvaluation.status === 'stale' ? ' is-stale' : ''}`}
          style={{ top: NODE_HEADER_HEIGHT + NODE_CONTENT_PADDING * 0.5, left: NODE_CONTENT_PADDING, width: contentWidth }}
          title={
            sourceEvaluation.status === 'stale'
              ? 'The source note changed since this branch was created. The snapshot below is preserved.'
              : 'Text this branch was created from'
          }
        >
          <span className="note-window__source-snippet">
            “{sourceEvaluation.reference.selectedTextSnapshot}”
          </span>
          {sourceEvaluation.status === 'stale' ? (
            <span className="note-window__source-flag">source changed</span>
          ) : null}
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        className="note-window__body"
        style={{
          top: bodyTop,
          left: NODE_CONTENT_PADDING,
          width: contentWidth,
          height: bodyHeight,
          fontSize: BODY_FONT_SIZE,
          lineHeight: `${BODY_LINE_HEIGHT}px`,
        }}
        value={content}
        onChange={handleContentChange}
        onSelect={scheduleBranchSync}
        onKeyUp={scheduleBranchSync}
        onMouseUp={scheduleBranchSync}
        onScroll={scheduleBranchSync}
        onBlur={(event) => {
          // Clicking elsewhere dismisses the contextual action — unless focus is
          // moving to the action itself (keyboard users tabbing to it).
          const next = event.relatedTarget;
          if (next instanceof Element && next.closest('.branch-action')) return;
          engine.clearBranchActionFor(nodeId);
        }}
        placeholder="Write, or paste something worth thinking about…"
        aria-label="Note body"
        spellCheck
      />

      <footer className="note-window__footer" style={{ height: NODE_FOOTER_HEIGHT }}>
        <span className={`note-window__count is-${status.level}`} aria-live="polite">
          {formatCount(status.used)} / {formatCount(status.limit)}
        </span>
        {message ? <span className="note-window__count-message">{message}</span> : null}
        <span className="note-window__branches">
          {childCount >= MAX_CHILDREN_PER_NODE
            ? `branch limit · ${childCount}/${MAX_CHILDREN_PER_NODE}`
            : `${childCount}/${MAX_CHILDREN_PER_NODE} branches`}
        </span>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inline icons (kept local to avoid an icon dependency)               */
/* ------------------------------------------------------------------ */

function BranchIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M4 2v6.5A2.5 2.5 0 0 0 6.5 11H11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="4" cy="2.4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12.4" cy="11" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function CollapseIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 3h8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function FocusIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M2.5 6V3.5A1 1 0 0 1 3.5 2.5H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashIcon(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M3.5 5h9M6.5 5V3.6h3V5M5 5l.6 8h4.8L11 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
