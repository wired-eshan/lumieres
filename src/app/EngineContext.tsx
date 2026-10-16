/**
 * React access to the canvas engine.
 *
 * The engine instance is created once per app and shared through context. React
 * never owns engine state — it subscribes to the engine's discrete-event
 * snapshot through `useSyncExternalStore`, which is what keeps panning and
 * dragging out of the render path.
 */

import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { CanvasEngine, type EngineSnapshot } from '../canvas/engine';
import { graphController, type GraphController } from '../graph/graphController';

const EngineContext = createContext<CanvasEngine | null>(null);

export interface EngineProviderProps {
  children: ReactNode;
  /** Injected by tests; the app lets the provider own its engine. */
  engine?: CanvasEngine;
}

/**
 * Owns the canvas engine for the lifetime of the app.
 *
 * Created here rather than at module scope so that mounting the app twice (two
 * tabs, or two tests in one process) can never share a stale engine, and so the
 * engine's lifetime is tied to the component tree that drives it.
 */
export function EngineProvider({ children, engine: injected }: EngineProviderProps): ReactNode {
  const [engine] = useState(() => injected ?? new CanvasEngine(graphController));
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

export function useEngine(): CanvasEngine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error('useEngine must be used inside <EngineProvider>');
  return engine;
}

export function useController(): GraphController {
  return graphController;
}

/**
 * Subscribes to one slice of the engine snapshot.
 *
 * The selector must return a primitive or a reference that is stable between
 * emissions (`branchAction`, `pendingAction` and `toast` are stable objects
 * because snapshots are only rebuilt on emit).
 */
export function useEngineSnapshot<T>(selector: (snapshot: EngineSnapshot) => T): T {
  const engine = useEngine();
  return useSyncExternalStore(
    engine.subscribe,
    () => selector(engine.getSnapshot()),
    () => selector(engine.getSnapshot()),
  );
}
