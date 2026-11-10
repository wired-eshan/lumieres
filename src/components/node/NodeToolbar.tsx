/**
 * Floating controls for the selected window.
 *
 * Rendered in the untransformed screen layer and positioned by the engine every
 * frame, so it stays glued to its window while panning or zooming without React
 * re-rendering. It doubles as the accessible path to actions that are also
 * available from the keyboard (see `useKeyboardShortcuts`).
 */

import { useCallback, type ReactNode } from 'react';
import { useEngine, useEngineSnapshot } from '../../app/EngineContext';
import { useGraphStore } from '../../graph/graphStore';
import { displayTitle } from '../../graph/displayTitle';
import { MAX_CHILDREN_PER_NODE } from '../../config';
import { truncate } from '../../utils/misc';
import { BranchIcon, CollapseIcon, ExpandIcon, FitIcon, ParentIcon, TargetIcon, TrashIcon } from '../icons';

export function NodeToolbar(): ReactNode {
  const engine = useEngine();
  const selectedIds = useEngineSnapshot((snapshot) => snapshot.selectedIds);
  const editingNodeId = useEngineSnapshot((snapshot) => snapshot.editingNodeId);
  const doc = useGraphStore((state) => state.doc);

  const registerRef = useCallback(
    (element: HTMLDivElement | null) => {
      engine.registerToolbarElement(element);
    },
    [engine],
  );

  // The editor's own header carries these actions while it is open.
  const targetId =
    editingNodeId ?? (selectedIds.length === 1 ? (selectedIds[0] as string) : null);
  const node = targetId ? doc.nodes[targetId] : undefined;

  if (!node || editingNodeId === node.id) {
    return <div className="node-toolbar" ref={registerRef} style={{ display: 'none' }} />;
  }

  const childCount = Object.values(doc.nodes).filter((candidate) => candidate.parentId === node.id).length;
  const atLimit = childCount >= MAX_CHILDREN_PER_NODE;
  // A derived label (first chat turn, else extractive from the body) means a
  // window with no stored title is still identifiable in the toolbar.
  const label =
    displayTitle(node) || (node.kind === 'ai' ? 'AI conversation' : 'Untitled note');
  const editLabel = node.kind === 'ai' ? 'Open this AI conversation' : 'Edit this note';

  return (
    <div className="node-toolbar" data-overlay="true" ref={registerRef} role="toolbar" aria-label="Selected window actions">
      <button
        type="button"
        className="node-toolbar__title"
        onClick={() => engine.startEditing(node.id)}
        title={editLabel}
      >
        {truncate(label, 28)}
      </button>

      <span className="node-toolbar__divider" />

      <button
        type="button"
        className="icon-button"
        onClick={() => engine.createBranchFromNode(node.id)}
        disabled={atLimit}
        title={
          atLimit
            ? `Branch limit reached — this window already has ${MAX_CHILDREN_PER_NODE} branches`
            : 'Create a branch from this window'
        }
        aria-label="Create a branch from this window"
      >
        <BranchIcon />
        <span className="node-toolbar__badge">{childCount}</span>
      </button>

      <button
        type="button"
        className="icon-button"
        onClick={() => engine.toggleCollapsed(node.id)}
        title={node.collapsed ? 'Expand this window' : 'Collapse this window'}
        aria-label={node.collapsed ? 'Expand this window' : 'Collapse this window'}
      >
        {node.collapsed ? <ExpandIcon /> : <CollapseIcon />}
      </button>

      <button
        type="button"
        className="icon-button"
        onClick={() => engine.focusNode(node.id)}
        title="Focus this window"
        aria-label="Focus this window"
      >
        <TargetIcon />
      </button>

      <button
        type="button"
        className="icon-button"
        onClick={() => engine.fitToView([node.id])}
        title="Fit this branch into view"
        aria-label="Fit this branch into view"
      >
        <FitIcon />
      </button>

      {node.parentId ? (
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            const parentId = node.parentId;
            if (!parentId) return;
            engine.setSelection([parentId]);
            engine.revealNode(parentId);
          }}
          title="Go to the parent note"
          aria-label="Go to the parent note"
        >
          <ParentIcon />
        </button>
      ) : null}

      <span className="node-toolbar__divider" />

      <button
        type="button"
        className="icon-button is-danger"
        onClick={() => engine.requestDelete([node.id])}
        title="Delete this window and its branches"
        aria-label="Delete this window and its branches"
      >
        <TrashIcon />
      </button>
    </div>
  );
}
