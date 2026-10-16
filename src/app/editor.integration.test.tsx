/**
 * The note editor and the branch-from-selection flow, driven through the real
 * component tree and real DOM events.
 *
 * jsdom has no layout engine, so text *geometry* is not observable here (the
 * canvas draws it, and the smoke test covers mount behaviour). What is
 * observable — and what these tests pin down — is caret behaviour and the state
 * machine behind the floating "Create branch" action: when it appears, what it
 * acts on, and that selecting text again in the same window always branches.
 */

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { EngineProvider } from './EngineContext';
import { CanvasEngine } from '../canvas/engine';
import { graphController } from '../graph/graphController';
import { useGraphStore } from '../graph/graphStore';
import { createEmptyDocument, getNode } from '../graph/graphOperations';
import type { NoteNode } from '../graph/types';

const NOTE_TEXT = 'Photosynthesis converts light into chemical energy stored in glucose.';

let container: HTMLDivElement;
let root: Root;
let engine: CanvasEngine;

beforeEach(() => {
  useGraphStore.getState().replaceDocument(createEmptyDocument('Editor'), { resetHistory: true });
  engine = new CanvasEngine(graphController);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  engine.destroy();
  container.remove();
});

/** Lets queued frames (focus, branch sync) run, then flushes React. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
  await act(async () => {});
}

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

/** React tracks the value setter, so a plain assignment is not a real edit. */
function setFieldValue(field: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(field, value);
}

function editor(): HTMLTextAreaElement {
  const textarea = container.querySelector<HTMLTextAreaElement>('.note-window__body');
  if (!textarea) throw new Error('the note editor is not open');
  return textarea;
}

/** Opens the editor on a node and types initial content into it. */
async function editNode(nodeId: string, text: string): Promise<HTMLTextAreaElement> {
  await act(async () => {
    engine.startEditing(nodeId);
  });
  await frame();
  const textarea = editor();
  await act(async () => {
    setFieldValue(textarea, text);
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    engine.flushDraft({ immediate: true });
  });
  return textarea;
}

/**
 * Simulates an edit the way a browser performs it: the value changes, the caret
 * moves, and only then does the `input` event reach the page.
 */
async function editAtCaret(
  textarea: HTMLTextAreaElement,
  nextValue: string,
  nextCaret: number,
): Promise<void> {
  await act(async () => {
    setFieldValue(textarea, nextValue);
    textarea.setSelectionRange(nextCaret, nextCaret);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await frame();
  await act(async () => {
    engine.flushDraft({ immediate: true });
  });
}

/** Selects a phrase in the open editor and lets the floating action appear. */
async function selectPhrase(textarea: HTMLTextAreaElement, phrase: string): Promise<void> {
  const start = textarea.value.indexOf(phrase);
  if (start === -1) throw new Error(`"${phrase}" is not in the editor`);
  await act(async () => {
    textarea.setSelectionRange(start, start + phrase.length);
    textarea.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await frame();
}

function branchButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.branch-action__button');
  if (!button) throw new Error('the floating branch action is not shown');
  return button;
}

async function clickBranchAction(): Promise<void> {
  const action = container.querySelector<HTMLDivElement>('.branch-action');
  if (!action) throw new Error('the floating branch action is not shown');
  await act(async () => {
    action.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    branchButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await frame();
}

function childrenOf(nodeId: string): NoteNode[] {
  const doc = useGraphStore.getState().doc;
  return Object.values(doc.nodes).filter((node) => node.parentId === nodeId);
}

describe('the note editor', () => {
  it('keeps the caret where it is when a character is deleted mid-text', async () => {
    await renderApp();
    const rootId = engine.doc.rootNodeId;
    const textarea = await editNode(rootId, NOTE_TEXT);

    const caret = NOTE_TEXT.indexOf('chemical');
    await editAtCaret(textarea, NOTE_TEXT.slice(0, caret - 1) + NOTE_TEXT.slice(caret), caret - 1);

    // The bug this pins down: the caret used to jump to the end of the note.
    expect(textarea.selectionStart).toBe(caret - 1);
    expect(textarea.selectionEnd).toBe(caret - 1);
    expect(getNode(useGraphStore.getState().doc, rootId)?.content).toBe(
      NOTE_TEXT.slice(0, caret - 1) + NOTE_TEXT.slice(caret),
    );
  });

  it('keeps the caret where it is when typing mid-text', async () => {
    await renderApp();
    const rootId = engine.doc.rootNodeId;
    const textarea = await editNode(rootId, 'one two');

    await editAtCaret(textarea, 'one XXtwo', 6);
    expect(textarea.selectionStart).toBe(6);
  });

  it('still parks the caret correctly when an edit is trimmed by the limit', async () => {
    await renderApp();
    const rootId = engine.doc.rootNodeId;
    const textarea = await editNode(rootId, 'a'.repeat(19_990));

    // A paste that overflows is trimmed to the space left, and the caret lands
    // after the text that was kept rather than at the end of the field.
    const before = 'a'.repeat(19_990);
    await editAtCaret(textarea, `${before}${'b'.repeat(50)}`, 20_040);

    const textareaAfter = editor();
    expect(textareaAfter.value.length).toBe(20_000);
    expect(textareaAfter.value.endsWith('b')).toBe(true);
    expect(textareaAfter.selectionStart).toBe(20_000);
  });
});

describe('branching from a selection', () => {
  it('creates a second branch from the same window after the first one', async () => {
    await renderApp();
    const rootId = engine.doc.rootNodeId;
    const textarea = await editNode(rootId, NOTE_TEXT);

    await selectPhrase(textarea, 'chemical energy');
    await clickBranchAction();
    expect(childrenOf(rootId)).toHaveLength(1);

    // The branch moved the editor to the child; go back to the source window the
    // way a user does — reopening it and highlighting another phrase.
    await act(async () => {
      engine.startEditing(rootId);
    });
    await frame();

    await selectPhrase(editor(), 'stored in glucose');
    await clickBranchAction();

    const children = childrenOf(rootId);
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.sourceReference?.selectedTextSnapshot).sort()).toEqual([
      'chemical energy',
      'stored in glucose',
    ]);
  });

  it('branches from a selection made while the editor was still opening', async () => {
    await renderApp();
    const rootId = engine.doc.rootNodeId;
    await act(async () => {
      engine.startEditing(rootId);
    });
    const textarea = editor();
    await act(async () => {
      setFieldValue(textarea, NOTE_TEXT);
      textarea.setSelectionRange(NOTE_TEXT.length, NOTE_TEXT.length);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // The editor focuses itself a frame after it mounts. Selecting inside that
    // window used to be undone by that focus, which silently dropped the action.
    await act(async () => {
      textarea.setSelectionRange(0, 'Photosynthesis'.length);
      textarea.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await frame();

    expect(engine.getSnapshot().branchAction?.text).toBe('Photosynthesis');
    await clickBranchAction();
    expect(childrenOf(rootId)).toHaveLength(1);
  });

  it('acts on what is selected now, even if the floating action was dismissed', async () => {
    await renderApp();
    const rootId = engine.doc.rootNodeId;
    const textarea = await editNode(rootId, NOTE_TEXT);

    await selectPhrase(textarea, 'chemical energy');
    expect(engine.getSnapshot().branchAction).not.toBeNull();

    // Moving focus out of the editor clears the cached action, but the selection
    // is still highlighted: the keyboard shortcut must still branch from it.
    await act(async () => {
      textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(engine.getSnapshot().branchAction).toBeNull();

    await act(async () => {
      engine.createBranchFromSelection();
    });

    const children = childrenOf(rootId);
    expect(children).toHaveLength(1);
    expect(children[0]?.sourceReference?.selectedTextSnapshot).toBe('chemical energy');
  });

  it('does not create two branches from one click', async () => {
    await renderApp();
    const rootId = engine.doc.rootNodeId;
    const textarea = await editNode(rootId, NOTE_TEXT);

    await selectPhrase(textarea, 'chemical energy');
    const button = branchButton();
    await act(async () => {
      // A double click: two clicks dispatched before React can remove the button.
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await frame();

    expect(childrenOf(rootId)).toHaveLength(1);
  });

  it('branches again from the same phrase after re-selecting it', async () => {
    await renderApp();
    const rootId = engine.doc.rootNodeId;
    const textarea = await editNode(rootId, NOTE_TEXT);

    await selectPhrase(textarea, 'glucose');
    await clickBranchAction();

    await act(async () => {
      engine.startEditing(rootId);
    });
    await frame();
    await selectPhrase(editor(), 'glucose');
    await clickBranchAction();

    expect(childrenOf(rootId)).toHaveLength(2);
  });
});
