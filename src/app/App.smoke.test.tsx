/**
 * Browser-level smoke test: mounts the real component tree and drives the note
 * editor through a genuine input event.
 *
 * jsdom has no canvas rasteriser or layout engine, so this cannot verify what
 * the canvas *looks like* — it verifies that the app mounts, that the editor
 * overlay appears over the selected window, and that typing flows through the
 * character-limit logic into the document. Visual/pixel behaviour is checked
 * manually (see README).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { EngineProvider } from './EngineContext';
import { CanvasEngine } from '../canvas/engine';
import { graphController } from '../graph/graphController';
import { useGraphStore } from '../graph/graphStore';
import { createEmptyDocument } from '../graph/graphOperations';
import { DEFAULT_AI_SETTINGS, saveAISettings } from '../ai/settings';

let container: HTMLDivElement;
let root: Root;
let engine: CanvasEngine;

/** React tracks the value setter, so a plain assignment is not a real edit. */
function typeIntoField(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  useGraphStore.getState().replaceDocument(createEmptyDocument('Smoke'), { resetHistory: true });
  saveAISettings({ ...DEFAULT_AI_SETTINGS });
  engine = new CanvasEngine(graphController);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root.unmount());
  engine.destroy();
  container.remove();
});

function renderApp(): void {
  root = createRoot(container);
  act(() => {
    root.render(
      <EngineProvider engine={engine}>
        <App />
      </EngineProvider>,
    );
  });
}

describe('application shell', () => {
  it('mounts the toolbar, canvas and first-run guidance', async () => {
    renderApp();
    await act(async () => {});

    expect(container.querySelector('.toolbar')).not.toBeNull();
    expect(container.querySelector('.canvas-surface')).not.toBeNull();
    expect(container.querySelector('.overlay-layer')).not.toBeNull();
    expect(container.querySelector('.minimap')).not.toBeNull();
    expect(container.querySelector('.zoom-controls')).not.toBeNull();
    expect(container.textContent).toContain('Start here');

    const title = container.querySelector<HTMLInputElement>('.toolbar__title');
    expect(title?.value).toBe('Smoke');
  });

  it('opens the editor over the selected note and commits typed text', async () => {
    renderApp();
    await act(async () => {});

    const rootId = engine.doc.rootNodeId;

    await act(async () => {
      engine.startEditing(rootId);
    });

    const noteWindow = container.querySelector('.note-window');
    expect(noteWindow).not.toBeNull();
    const textarea = noteWindow?.querySelector<HTMLTextAreaElement>('.note-window__body');
    expect(textarea).not.toBeNull();
    if (!textarea) return;

    await act(async () => {
      typeIntoField(textarea, 'Branching notes on an infinite canvas');
    });
    await act(async () => {
      engine.flushDraft();
    });

    expect(useGraphStore.getState().doc.nodes[rootId]?.content).toBe(
      'Branching notes on an infinite canvas',
    );
    expect(container.querySelector('.note-window__count')?.textContent).toBe('37 / 20,000');
  });

  it('shows a branch-limit indicator once a note reaches 50 children', async () => {
    renderApp();
    await act(async () => {});

    const rootId = engine.doc.rootNodeId;

    await act(async () => {
      for (let index = 0; index < 50; index += 1) engine.createBranchFromNode(rootId);
      // Selecting the root closes the editor on the last-created child.
      engine.setSelection([rootId]);
    });

    const toolbar = container.querySelector('.node-toolbar');
    const branchButton = toolbar?.querySelector<HTMLButtonElement>('button[aria-label="Create a branch from this window"]');
    expect(branchButton?.disabled).toBe(true);
    expect(branchButton?.title).toContain('Branch limit reached');
  });

  it('toggles an open window between note and AI without losing its content', async () => {
    renderApp();
    await act(async () => {});
    const rootId = engine.doc.rootNodeId;

    await act(async () => {
      engine.startEditing(rootId);
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('.note-window__body');
    if (!textarea) throw new Error('note editor missing');
    await act(async () => {
      typeIntoField(textarea, 'Context kept across modes');
    });
    await act(async () => {
      engine.flushDraft({ immediate: true });
    });

    const aiToggle = container.querySelector<HTMLButtonElement>('button[title="AI conversation mode"]');
    if (!aiToggle) throw new Error('AI mode toggle missing');
    await act(async () => {
      aiToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(useGraphStore.getState().doc.nodes[rootId]?.kind).toBe('ai');
    expect(useGraphStore.getState().doc.nodes[rootId]?.content).toBe('Context kept across modes');
    expect(container.querySelector('.ai-chat')).not.toBeNull();
    expect(container.querySelector('.note-window__body')).toBeNull();
    // With no key configured, the window explains the state and refuses to send.
    expect(container.querySelector('.ai-chat__notice')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.ai-chat__send')?.disabled).toBe(true);

    const noteToggle = container.querySelector<HTMLButtonElement>('button[title="Note mode"]');
    if (!noteToggle) throw new Error('note mode toggle missing');
    await act(async () => {
      noteToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useGraphStore.getState().doc.nodes[rootId]?.kind).toBe('note');
    expect(container.querySelector<HTMLTextAreaElement>('.note-window__body')?.value).toBe(
      'Context kept across modes',
    );
  });

  it('resizes a window by dragging its corner and commits one document change', async () => {
    renderApp();
    await act(async () => {});
    const rootId = engine.doc.rootNodeId;
    await act(async () => {
      engine.startEditing(rootId);
    });

    const handle = container.querySelector<HTMLButtonElement>('.note-window__resize');
    if (!handle) throw new Error('resize handle missing');
    const before = useGraphStore.getState().doc.nodes[rootId]?.size;
    if (!before) throw new Error('node missing');

    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: 100 }));
      handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 180, clientY: 160 }));
      handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 180, clientY: 160 }));
    });

    const after = useGraphStore.getState().doc.nodes[rootId]?.size;
    expect(after?.width).toBe(before.width + 80);
    expect(after?.height).toBe(before.height + 60);
  });

  it('opens AI settings and stores a key locally', async () => {
    renderApp();
    await act(async () => {});

    const settingsButton = container.querySelector<HTMLButtonElement>('button[aria-label="AI settings"]');
    if (!settingsButton) throw new Error('settings button missing');
    await act(async () => {
      settingsButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const keyInput = container.querySelector<HTMLInputElement>('.settings__input[type="password"]');
    if (!keyInput) throw new Error('key field missing');
    await act(async () => {
      typeIntoField(keyInput, 'sk-ant-test-key');
      container.querySelector<HTMLFormElement>('form.settings')?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(window.localStorage.getItem('lumieres:ai-settings')).toContain('sk-ant-test-key');
  });
});
