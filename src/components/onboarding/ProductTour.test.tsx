/**
 * Product-tour integration.
 *
 * These tests pin down the two fragile parts of the integration: every step
 * points at a control that actually exists, and a first visit opens the root
 * window before the tour tries to resolve its window-level targets.
 *
 * jsdom has no layout engine, so the auto-start test supplies stable rectangles
 * for `reactjs-onboarding`'s spotlight instead of waiting for real layout.
 */

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { EngineProvider } from '../../app/EngineContext';
import { CanvasEngine } from '../../canvas/engine';
import { graphController } from '../../graph/graphController';
import { useGraphStore } from '../../graph/graphStore';
import { createEmptyDocument } from '../../graph/graphOperations';
import { DEFAULT_AI_SETTINGS, saveAISettings } from '../../ai/settings';
import { TOUR_COMPLETION_KEY, TOUR_STEPS } from '../../onboarding/tourConfig';

let container: HTMLDivElement;
let root: Root;
let engine: CanvasEngine;
let restoreRects: (() => void) | null = null;

beforeEach(() => {
  useGraphStore.getState().replaceDocument(createEmptyDocument('Tour'), { resetHistory: true });
  saveAISettings({ ...DEFAULT_AI_SETTINGS });
  engine = new CanvasEngine(graphController);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  restoreRects?.();
  restoreRects = null;
  engine.destroy();
  container.remove();
});

async function renderApp(): Promise<void> {
  await act(async () => {
    root.render(
      <StrictMode>
        <EngineProvider engine={engine}>
          <App />
        </EngineProvider>
      </StrictMode>,
    );
  });
  await act(async () => {});
}

/** Lets queued frames and the async boot sequence settle. */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  await act(async () => {});
}

/** jsdom reports 0×0 rects; the tour would wait for layout that never comes. */
function mockElementRects(): void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function rect(): DOMRect {
    return {
      x: 20,
      y: 20,
      left: 20,
      top: 20,
      right: 320,
      bottom: 60,
      width: 300,
      height: 40,
      toJSON: () => ({}),
    } as DOMRect;
  };
  restoreRects = () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

describe('product tour', () => {
  it('has a live DOM target for every step while a window is open', async () => {
    await renderApp();
    await waitFor(() => container.querySelector('.toolbar') !== null, 'the app shell');
    await act(async () => {
      engine.startEditing(engine.doc.rootNodeId);
    });

    for (const step of TOUR_STEPS) {
      expect(document.getElementById(step.targetId), step.targetId).not.toBeNull();
    }
  });

  it('auto-opens on a first visit and prepares the root window', async () => {
    window.localStorage.removeItem(TOUR_COMPLETION_KEY);
    mockElementRects();

    await renderApp();

    await waitFor(
      () => container.textContent?.includes('Rename this canvas') === true,
      'the first tour step',
    );
    // The window-level steps need an open editor, so the tour opens the root.
    expect(container.querySelector('.note-window')).not.toBeNull();
  });
});
