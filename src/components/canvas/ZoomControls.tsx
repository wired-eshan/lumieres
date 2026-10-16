import { type ReactNode } from 'react';
import { useEngine, useEngineSnapshot } from '../../app/EngineContext';
import { FitIcon, MinusIcon, PlusIcon, TargetIcon } from '../icons';

export function ZoomControls(): ReactNode {
  const engine = useEngine();
  const zoomPercent = useEngineSnapshot((snapshot) => snapshot.zoomPercent);

  return (
    <div className="zoom-controls" data-overlay="true" role="group" aria-label="Zoom controls">
      <button
        type="button"
        className="icon-button"
        onClick={() => engine.zoomBy(1 / 1.25)}
        aria-label="Zoom out"
        title="Zoom out (⌘−)"
      >
        <MinusIcon />
      </button>
      <button
        type="button"
        className="zoom-controls__value"
        onClick={() => engine.resetZoom()}
        title="Reset zoom to 100% (⌘0)"
        aria-label={`Zoom level ${zoomPercent} percent. Click to reset.`}
      >
        {zoomPercent}%
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={() => engine.zoomBy(1.25)}
        aria-label="Zoom in"
        title="Zoom in (⌘+)"
      >
        <PlusIcon />
      </button>
      <span className="zoom-controls__divider" />
      <button
        type="button"
        className="icon-button"
        onClick={() => engine.fitToView()}
        aria-label="Fit the whole graph into view"
        title="Fit everything into view (⌘1)"
      >
        <FitIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        onClick={() => {
          const selected = engine.getSelectedIds();
          engine.fitToView(selected.length > 0 ? selected : undefined);
        }}
        aria-label="Fit the current selection into view"
        title="Fit selection into view (⌘2)"
      >
        <TargetIcon />
      </button>
    </div>
  );
}
