/**
 * Confirmation for destructive actions.
 *
 * Deleting a window removes its entire descendant subtree, so the dialog states
 * exactly what will go: how many notes and how much text — never a generic
 * "are you sure?". Small, low-cost deletions skip the dialog entirely (see
 * `CanvasEngine.requestDelete`).
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useEngine, useEngineSnapshot } from '../../app/EngineContext';
import { formatCount } from '../../utils/misc';

export function ConfirmDialog(): ReactNode {
  const engine = useEngine();
  const pending = useEngineSnapshot((snapshot) => snapshot.pendingAction);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pending) cancelRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        engine.cancelPendingAction();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, pending]);

  if (!pending) return null;

  const isReset = pending.kind === 'reset';
  const title = isReset
    ? 'Reset this canvas?'
    : pending.nodeCount > 1
      ? `Delete ${formatCount(pending.nodeCount)} windows?`
      : 'Delete this window?';

  return (
    <div className="modal-backdrop" data-overlay="true" role="presentation">
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
      >
        <h2 className="modal__title" id="confirm-title">
          {title}
        </h2>
        <div className="modal__body" id="confirm-body">
          {isReset ? (
            <p>
              Every window on this canvas will be removed and replaced with a single empty root note.
              One undo brings the whole canvas back.
            </p>
          ) : (
            <p>
              This removes the window and everything branching from it. Nothing else on the canvas is
              affected.
            </p>
          )}
          <ul className="modal__facts">
            <li>
              <strong>{formatCount(pending.nodeCount)}</strong> window{pending.nodeCount === 1 ? '' : 's'}
            </li>
            <li>
              <strong>{formatCount(pending.characterCount)}</strong> characters of text
            </li>
            <li>Undo restores everything</li>
          </ul>
        </div>
        <div className="modal__actions">
          <button type="button" className="button" ref={cancelRef} onClick={() => engine.cancelPendingAction()}>
            Cancel
          </button>
          <button
            type="button"
            className="button is-danger"
            onClick={() => engine.confirmPendingAction()}
          >
            {isReset ? 'Reset canvas' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
