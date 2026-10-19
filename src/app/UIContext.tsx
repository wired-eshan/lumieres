/**
 * Small UI command bus.
 *
 * The floating/settings affordances live inside windows, but the modal is owned
 * by `App`. A context keeps that dependency explicit without threading props
 * through the canvas component tree (which must stay independent of graph size).
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface UICommands {
  openSettings: () => void;
}

const fallback: UICommands = { openSettings: () => undefined };

const UIContext = createContext<UICommands>(fallback);

export function UIProvider({ commands, children }: { commands: UICommands; children: ReactNode }): ReactNode {
  return <UIContext.Provider value={commands}>{children}</UIContext.Provider>;
}

export function useUI(): UICommands {
  return useContext(UIContext);
}
