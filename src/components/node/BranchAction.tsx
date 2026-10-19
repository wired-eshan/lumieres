/**
 * The contextual "Create branch" action.
 *
 * Appears while text is selected in the open note, and is anchored to a *world*
 * point on the note window, so it follows the window while the camera moves. It
 * is deliberately a DOM button rather than a canvas hit region: it is keyboard
 * reachable (⌘/Ctrl + Enter is the shortcut), readable and focusable.
 *
 * The engine owns the placement (it hangs the action off the window's top edge
 * at a fixed screen distance, clamped over the window); this component only
 * reports how big it turned out, because only the DOM knows that.
 *
 * Duplicate protection lives in the engine: the action is cleared the moment a
 * branch is created, so a double click cannot produce two children.
 */

import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useEngine, useEngineSnapshot } from '../../app/EngineContext';
import { useGraphStore } from '../../graph/graphStore';
import { truncate } from '../../utils/misc';
import { BranchIcon } from '../icons';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function BranchAction(): ReactNode {
  const engine = useEngine();
  const action = useEngineSnapshot((snapshot) => snapshot.branchAction);
  const doc = useGraphStore((state) => state.doc);
  const rootRef = useRef<HTMLDivElement>(null);

  const registerRef = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      engine.registerBranchElement(element);
    },
    [engine],
  );

  const sourceNode = action ? doc.nodes[action.nodeId] : undefined;
  const childCount = sourceNode
    ? Object.values(doc.nodes).filter((candidate) => candidate.parentId === sourceNode.id).length
    : 0;
  const atLimit = childCount >= 50;

  // The preview line and the limit warning change the action's width and height;
  // measuring after a commit keeps that read out of the engine's frame loop.
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    engine.setBranchSize({ width: element.offsetWidth, height: element.offsetHeight });
  });

  if (!action || !sourceNode) {
    return <div className="branch-action" ref={registerRef} style={{ display: 'none' }} />;
  }

  return (
    <div
      className="branch-action"
      data-overlay="true"
      ref={registerRef}
      // The whole action is the control: the button, the preview label under it
      // and the gap between them. Clicking any of them creates the branch, and
      // none of them may move focus out of the editor — a blur would dismiss the
      // action (and the selection's highlight) before the click landed.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => engine.createBranchFromSelection()}
    >
      <button
        type="button"
        className="branch-action__button"
        disabled={atLimit}
        title={
          atLimit
            ? 'Branch limit reached — this window already has 50 branches'
            : 'Create a new window branching from the selected text'
        }
      >
        <BranchIcon size={14} />
        <span>Create branch</span>
        <kbd>{IS_MAC ? '⌘' : 'Ctrl'}↵</kbd>
      </button>
      <span className="branch-action__preview">“{truncate(action.text.trim(), 46)}”</span>
      {atLimit ? <span className="branch-action__limit">limit reached</span> : null}
    </div>
  );
}
