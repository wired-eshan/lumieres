/**
 * Global keyboard shortcuts.
 *
 * Text editing always wins: shortcuts that would collide with typing (undo,
 * delete, arrow keys) only fire when focus is *not* inside a text field, except
 * for undo/redo which are intercepted everywhere so that document history and
 * editor content cannot drift apart.
 */

import { useEffect } from 'react';
import type { CanvasEngine } from '../canvas/engine';
import { getNode } from '../graph/graphOperations';
import type { NodeId } from '../graph/types';

export interface ShortcutHandlers {
  onImportRequested?: () => void;
  onExportRequested?: () => void;
  onHelpRequested?: () => void;
}

export interface KeyboardBinding {
  detach(): void;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

/**
 * True for controls that already consume the key themselves. Space activates a
 * focused button, so it must not also arm the canvas pan modifier.
 */
function isActivatableControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return ['BUTTON', 'A', 'SELECT', 'SUMMARY'].includes(target.tagName);
}

/**
 * Arrow-key navigation across the graph. Children are ordered the same way they
 * are laid out (top to bottom), so "down" always moves visually downward.
 */
export function navigateFrom(engine: CanvasEngine, current: NodeId, direction: 'parent' | 'child' | 'next' | 'previous'): NodeId | null {
  const doc = engine.doc;
  const node = getNode(doc, current);
  if (!node) return null;

  if (direction === 'parent') return node.parentId;

  const childrenOf = (id: NodeId): NodeId[] =>
    Object.values(doc.nodes)
      .filter((candidate) => candidate.parentId === id)
      .sort((a, b) => a.position.y - b.position.y || a.createdAt - b.createdAt)
      .map((candidate) => candidate.id);

  if (direction === 'child') return childrenOf(current)[0] ?? null;

  if (node.parentId === null) return null;
  const siblings = childrenOf(node.parentId);
  const index = siblings.indexOf(current);
  if (index === -1) return null;
  const offset = direction === 'next' ? 1 : -1;
  return siblings[index + offset] ?? null;
}

export function useKeyboardShortcuts(
  engine: CanvasEngine,
  handlers: ShortcutHandlers = {},
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // A modal owns the keyboard while it is open (help, settings, confirm).
      // Its own Escape handler closes it; canvas shortcuts must not fire behind it.
      if (document.querySelector('.modal-backdrop')) return;

      const mod = event.metaKey || event.ctrlKey;
      const editing = engine.getEditingId() !== null;
      const inText = isTextEntry(event.target);
      // The open AI window is not a text field as a whole, but a text selection
      // inside it must still protect the window from Delete/space/arrow actions.
      const inOpenWindow =
        event.target instanceof Element && event.target.closest('.note-window') !== null;
      // The chat composer's draft is not document content, so its native text
      // undo is more useful than document undo while it has focus.
      const inChatComposer =
        event.target instanceof Element && event.target.closest('.ai-chat__input') !== null;

      // --- Undo / redo: intercepted even inside the note editor, because the
      // document (not the textarea) owns note history. The draft is flushed
      // first so the edit being undone is the most recent document state.
      if (mod && event.key.toLowerCase() === 'z' && !inChatComposer) {
        event.preventDefault();
        if (event.shiftKey) engine.redo();
        else engine.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === 'y' && !inChatComposer) {
        event.preventDefault();
        engine.redo();
        return;
      }

      if (event.key === 'Escape') {
        if (engine.getSnapshot().pendingAction) {
          event.preventDefault();
          engine.cancelPendingAction();
          return;
        }
        if (engine.getSnapshot().branchAction) {
          event.preventDefault();
          engine.setBranchAction(null);
          return;
        }
        if (editing) {
          event.preventDefault();
          engine.stopEditing({ commit: true });
          return;
        }
        if (engine.getSelectedIds().length > 0) {
          event.preventDefault();
          engine.clearSelection();
          return;
        }
        return;
      }

      // Branching from a selection works from inside the editor.
      if (mod && (event.key === 'Enter' || event.key.toLowerCase() === 'b')) {
        if (engine.getSnapshot().branchAction) {
          event.preventDefault();
          engine.createBranchFromSelection();
          return;
        }
        if (editing && event.key === 'Enter') {
          event.preventDefault();
          engine.notify('Select some text first, then branch.', 'info');
          return;
        }
      }

      if (mod && event.key.toLowerCase() === 'a' && !inText && !inOpenWindow) {
        event.preventDefault();
        engine.selectAll();
        return;
      }
      if (mod && event.key === '0') {
        event.preventDefault();
        engine.resetZoom();
        return;
      }
      if (mod && event.key === '1') {
        event.preventDefault();
        engine.fitToView();
        return;
      }
      if (mod && event.key === '2') {
        event.preventDefault();
        const selected = engine.getSelectedIds();
        engine.fitToView(selected.length > 0 ? selected : undefined);
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void engine.flushSave();
        return;
      }
      if (mod && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        handlers.onExportRequested?.();
        return;
      }
      if (mod && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        handlers.onImportRequested?.();
        return;
      }
      if (event.key === '?' || (mod && event.key === '/')) {
        event.preventDefault();
        handlers.onHelpRequested?.();
        return;
      }

      // --- Space to pan (held) — unless a control has focus, where space is
      // activation.
      if (event.code === 'Space' && !inText && !inOpenWindow && !isActivatableControl(event.target)) {
        engine.setPanModifier(true);
        return;
      }

      // --- Editing and node-level actions.
      if (event.key === 'Enter' && !editing && !inText && engine.getSelectedIds().length === 1) {
        const id = engine.getSelectedIds()[0];
        if (id) {
          event.preventDefault();
          engine.startEditing(id);
        }
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && !inText && !inOpenWindow) {
        const ids = engine.getSelectedIds();
        if (ids.length > 0) {
          event.preventDefault();
          engine.requestDelete(ids);
        }
        return;
      }

      if (event.key === 'F2' && !editing) {
        const id = engine.getSelectedIds()[0];
        if (id) {
          event.preventDefault();
          engine.startEditing(id);
        }
        return;
      }

      // --- Arrow navigation between windows.
      if (!editing && !inText && event.key.startsWith('Arrow')) {
        const ids = engine.getSelectedIds();
        const current = ids[ids.length - 1];
        if (!current) return;
        const direction =
          event.key === 'ArrowLeft'
            ? 'parent'
            : event.key === 'ArrowRight'
              ? 'child'
              : event.key === 'ArrowDown'
                ? 'next'
                : 'previous';
        const target = navigateFrom(engine, current, direction);
        if (target) {
          event.preventDefault();
          engine.setSelection([target]);
          engine.revealNode(target);
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code === 'Space') engine.setPanModifier(false);
    };

    const onBlur = (): void => engine.setPanModifier(false);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [engine, handlers.onExportRequested, handlers.onImportRequested, handlers.onHelpRequested]);
}
