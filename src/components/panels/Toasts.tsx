import { type ReactNode } from 'react';
import { useEngine, useEngineSnapshot } from '../../app/EngineContext';
import { CloseIcon } from '../icons';

/** Transient feedback: limit warnings, save confirmations, engine errors. */
export function Toasts(): ReactNode {
  const engine = useEngine();
  const toast = useEngineSnapshot((snapshot) => snapshot.toast);
  if (!toast) return null;

  return (
    <div className="toast-stack" data-overlay="true" aria-live="polite">
      <div className={`toast is-${toast.tone}`}>
        <span className="toast__message">{toast.message}</span>
        <button
          type="button"
          className="icon-button is-small"
          onClick={() => engine.dismissToast()}
          aria-label="Dismiss message"
        >
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  );
}
