/**
 * The open window frame.
 *
 * One component owns the chrome shared by both window modes — title, mode
 * toggle, source-context chip, branch/focus/collapse/delete actions, footer and
 * resize handle — while the body is either a note editor or an AI conversation.
 *
 * The engine writes this element's `transform` every frame (its world position);
 * React owns its size from the document, and a resize drag writes the size
 * directly while it is in flight. That keeps resizing out of the render path and
 * makes the resize one undoable document update on release.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useController, useEngine } from '../../app/EngineContext';
import { useGraphStore } from '../../graph/graphStore';
import { evaluateSourceReference } from '../../graph/graphOperations';
import {
  MAX_NODE_HEIGHT,
  MAX_NODE_WIDTH,
  MIN_NODE_HEIGHT,
  MIN_NODE_WIDTH,
  NODE_FOOTER_HEIGHT,
  NODE_HEADER_HEIGHT,
} from '../../graph/metrics';
import { MAX_CHILDREN_PER_NODE } from '../../graph/types';
import { limitMessage, limitStatus } from '../../editor/characterLimit';
import { formatCount } from '../../utils/misc';
import { NoteEditor } from './NoteEditor';
import { AIChatPanel } from './AIChatPanel';
import { BranchIcon, ChatIcon, ExpandIcon, NoteIcon } from '../icons';

export interface NoteWindowProps {
  nodeId: string;
}

export function NoteWindow({ nodeId }: NoteWindowProps): ReactNode {
  const engine = useEngine();
  const controller = useController();
  const doc = useGraphStore((state) => state.doc);
  const node = doc.nodes[nodeId];

  const rootRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(node?.title ?? '');
  const resizeStart = useRef<{
    pointerId: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    setTitle(node?.title ?? '');
  }, [node?.title]);

  // Never leave the page in resize mode if the window disappears mid-drag.
  useEffect(
    () => () => {
      document.body.classList.remove('is-resizing-window');
    },
    [],
  );

  // The frame is the element the engine positions and the interactions layer
  // treats as the open editor.
  useEffect(() => {
    engine.registerEditingElement(rootRef.current);
    return () => engine.registerEditingElement(null);
  }, [engine]);

  const sourceEvaluation = useMemo(
    () => (node ? evaluateSourceReference(doc, node) : null),
    [doc, node],
  );

  const childCount = useMemo(
    () => Object.values(doc.nodes).filter((candidate) => candidate.parentId === nodeId).length,
    [doc.nodes, nodeId],
  );

  const handleTitleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setTitle(event.target.value);
      controller.updateTitle(nodeId, event.target.value);
    },
    [controller, nodeId],
  );

  /* -------------------------------------------------------------- */
  /* Resize                                                          */
  /* -------------------------------------------------------------- */

  const endResize = useCallback(
    (commit: boolean) => {
      const start = resizeStart.current;
      if (!start) return;
      resizeStart.current = null;
      document.body.classList.remove('is-resizing-window');
      if (commit) engine.commitDraftNodeSize(nodeId);
      else engine.cancelDraftNodeSize(nodeId);
      // The document re-render supplies the committed size. If the gesture was
      // cancelled, put the original size back immediately.
      if (!commit && rootRef.current && node) {
        rootRef.current.style.width = `${node.size.width}px`;
        rootRef.current.style.height = `${node.size.height}px`;
      }
    },
    [engine, node, nodeId],
  );

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !node) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a convenience; the drag still works without it.
      }
      resizeStart.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        width: node.size.width,
        height: node.size.height,
      };
      document.body.classList.add('is-resizing-window');
    },
    [node],
  );

  const onResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = resizeStart.current;
      if (!start || event.pointerId !== start.pointerId) return;
      // The overlay is camera-scaled, so screen pixels become world units here.
      const zoom = engine.camera.zoom || 1;
      const width = Math.round(
        clamp(start.width + (event.clientX - start.x) / zoom, MIN_NODE_WIDTH, MAX_NODE_WIDTH),
      );
      const height = Math.round(
        clamp(
          start.height + (event.clientY - start.y) / zoom,
          MIN_NODE_HEIGHT,
          MAX_NODE_HEIGHT,
        ),
      );
      if (rootRef.current) {
        rootRef.current.style.width = `${width}px`;
        rootRef.current.style.height = `${height}px`;
      }
      engine.setDraftNodeSize(nodeId, { width, height });
    },
    [engine, nodeId],
  );

  const onResizePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!resizeStart.current || event.pointerId !== resizeStart.current.pointerId) return;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Already released.
      }
      endResize(true);
    },
    [endResize],
  );

  /** Keyboard equivalent: arrows resize, Shift accelerates. */
  const onResizeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (!node) return;
      const step = event.shiftKey ? 32 : 12;
      let width = node.size.width;
      let height = node.size.height;
      switch (event.key) {
        case 'ArrowRight':
          width += step;
          break;
        case 'ArrowLeft':
          width -= step;
          break;
        case 'ArrowDown':
          height += step;
          break;
        case 'ArrowUp':
          height -= step;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      engine.setDraftNodeSize(nodeId, { width, height });
      engine.commitDraftNodeSize(nodeId);
    },
    [engine, node, nodeId],
  );

  if (!node) return null;

  const isAi = node.kind === 'ai';
  const status = limitStatus(node.content);
  const message = limitMessage(status);

  return (
    <div
      className={`note-window${isAi ? ' is-ai' : ''}`}
      data-overlay="true"
      ref={rootRef}
      style={{ width: node.size.width, height: node.size.height }}
      role="group"
      aria-label={`${isAi ? 'AI conversation' : 'Note'}: ${node.title || 'untitled'}`}
    >
      <header className="note-window__header" style={{ height: NODE_HEADER_HEIGHT }}>
        <span className={`note-window__accent${node.id === doc.rootNodeId ? ' is-root' : ''}`} />
        <div className="mode-toggle" role="group" aria-label="Window mode">
          <button
            type="button"
            className={`mode-toggle__button${!isAi ? ' is-active' : ''}`}
            aria-pressed={!isAi}
            title="Note mode"
            onClick={() => engine.setNodeKind(nodeId, 'note')}
          >
            <NoteIcon size={13} />
            <span className="visually-hidden">Note</span>
          </button>
          <button
            type="button"
            className={`mode-toggle__button${isAi ? ' is-active' : ''}`}
            aria-pressed={isAi}
            title="AI conversation mode"
            onClick={() => engine.setNodeKind(nodeId, 'ai')}
          >
            <ChatIcon size={13} />
            <span className="visually-hidden">AI conversation</span>
          </button>
        </div>
        <input
          className="note-window__title"
          value={title}
          onChange={handleTitleChange}
          placeholder={isAi ? 'Untitled conversation' : 'Untitled note'}
          aria-label={isAi ? 'Conversation title' : 'Note title'}
          spellCheck={false}
        />
        <div className="note-window__actions">
          <button
            type="button"
            className="icon-button"
            title={
              childCount >= MAX_CHILDREN_PER_NODE
                ? `Branch limit reached (${MAX_CHILDREN_PER_NODE})`
                : 'Create an empty branch from this window'
            }
            aria-label="Create a branch from this window"
            disabled={childCount >= MAX_CHILDREN_PER_NODE}
            onClick={() => engine.createBranchFromNode(nodeId)}
          >
            <BranchIcon size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={node.collapsed ? 'Expand this window' : 'Collapse this window'}
            aria-label={node.collapsed ? 'Expand this window' : 'Collapse this window'}
            onClick={() => engine.toggleCollapsed(nodeId)}
          >
            {node.collapsed ? <ExpandIcon size={15} /> : <CollapseIcon />}
          </button>
          <button
            type="button"
            className="icon-button"
            title="Focus this window"
            aria-label="Focus this window"
            onClick={() => engine.focusNode(nodeId)}
          >
            <FocusIcon />
          </button>
          <button
            type="button"
            className="icon-button is-danger"
            title="Delete this window and everything branching from it"
            aria-label="Delete this window and its branches"
            onClick={() => engine.requestDelete([nodeId])}
          >
            <TrashIcon />
          </button>
        </div>
      </header>

      <div className="note-window__main">
        {sourceEvaluation?.reference ? (
          <div
            className={`note-window__source${sourceEvaluation.status === 'stale' ? ' is-stale' : ''}`}
            title={
              sourceEvaluation.status === 'stale'
                ? 'The source changed since this branch was created. The snapshot below is preserved.'
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

        {isAi ? <AIChatPanel nodeId={nodeId} /> : <NoteEditor nodeId={nodeId} />}
      </div>

      <footer className="note-window__footer" style={{ height: NODE_FOOTER_HEIGHT }}>
        {isAi ? (
          <span className="note-window__count is-normal">
            {node.chat.length} message{node.chat.length === 1 ? '' : 's'}
          </span>
        ) : (
          <>
            <span className={`note-window__count is-${status.level}`} aria-live="polite">
              {formatCount(status.used)} / {formatCount(status.limit)}
            </span>
            {message ? <span className="note-window__count-message">{message}</span> : null}
          </>
        )}
        <span className="note-window__branches">
          {childCount >= MAX_CHILDREN_PER_NODE
            ? `branch limit · ${childCount}/${MAX_CHILDREN_PER_NODE}`
            : `${childCount}/${MAX_CHILDREN_PER_NODE} branches`}
        </span>
      </footer>

      <button
        type="button"
        className="note-window__resize"
        aria-label="Resize window"
        title="Drag to resize (arrow keys also work)"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={() => endResize(false)}
        onLostPointerCapture={() => {
          // Fallback for browsers/pointers that never deliver pointerup.
          if (resizeStart.current) endResize(true);
        }}
        onKeyDown={onResizeKeyDown}
      >
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path
            d="M11 4 4 11M11 8l-3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/* ------------------------------------------------------------------ */
/* Inline icons (kept local to avoid an icon dependency)               */
/* ------------------------------------------------------------------ */

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
