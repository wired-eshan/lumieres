import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from '../icons';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

const CANVAS_SHORTCUTS: Array<[string, string]> = [
  ['Wheel / trackpad', 'Pan the canvas'],
  [`${MOD} + wheel`, 'Zoom around the pointer'],
  ['Space + drag', 'Pan (also middle-mouse drag)'],
  ['Drag empty space', 'Marquee select'],
  ['Shift + click', 'Add to selection'],
  [`${MOD}1`, 'Fit the whole graph'],
  [`${MOD}2`, 'Fit the selection'],
  [`${MOD}0`, 'Reset zoom to 100%'],
  ['Double-click a note', 'Edit it'],
  ['Enter / F2', 'Edit the selected note'],
  ['Arrow keys', 'Move to parent, child or sibling'],
];

const NOTE_SHORTCUTS: Array<[string, string]> = [
  ['Select text', 'Reveals “Create branch” in notes and AI replies'],
  [`${MOD}↵ or ${MOD}B`, 'Branch from the selected text'],
  ['Escape', 'Dismiss the action, then leave the editor'],
  [`${MOD}Z / ⇧${MOD}Z`, 'Undo / redo (document-wide)'],
  ['Delete', 'Delete the selection (with preview)'],
  [`${MOD}S`, 'Save now'],
  [`${MOD}E / ${MOD}O`, 'Export / import a canvas'],
  [`${MOD} + Shift + ?`, 'Open this help panel'],
];

const AI_SHORTCUTS: Array<[string, string]> = [
  ['Note ⇄ AI toggle', 'Switch a window between note and conversation'],
  ['Enter', 'Send a message'],
  ['Shift + Enter', 'New line in the composer'],
  ['Stop', 'Cancel this window only; other chats keep running'],
  ['Drag the corner', 'Resize the window (arrow keys work too)'],
  ['Settings', 'Add your own API key and choose a provider, model and effort level'],
];

export interface HelpPanelProps {
  open: boolean;
  onClose: () => void;
}

export function HelpPanel({ open, onClose }: HelpPanelProps): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" data-overlay="true" onClick={onClose} role="presentation">
      <div
        className="modal is-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal__header">
          <h2 className="modal__title" id="help-title">
            How Lumières works
          </h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close help" ref={closeRef}>
            <CloseIcon />
          </button>
        </div>

        <div className="modal__body">
          <p className="help__lede">
            Every canvas starts with one root note. Select a phrase, create a branch, and keep going —
            each window can spawn up to 50 of its own, and the graph keeps the lineage of every idea.
            Any window can also switch to an AI conversation; each one keeps its own chat.
          </p>

          <div className="help__grid">
            <section>
              <h3>Canvas</h3>
              <dl>
                {CANVAS_SHORTCUTS.map(([keys, description]) => (
                  <div className="help__row" key={keys}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section>
              <h3>Notes &amp; branching</h3>
              <dl>
                {NOTE_SHORTCUTS.map(([keys, description]) => (
                  <div className="help__row" key={keys}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section>
              <h3>AI conversations</h3>
              <dl>
                {AI_SHORTCUTS.map(([keys, description]) => (
                  <div className="help__row" key={keys}>
                    <dt>
                      <kbd>{keys}</kbd>
                    </dt>
                    <dd>{description}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>

          <section className="help__limits">
            <h3>Limits &amp; privacy</h3>
            <ul>
              <li>
                <strong>20,000 characters</strong> per note and per chat message, counted in UTF-16
                code units. Pasting past the limit trims the paste rather than the existing text.
              </li>
              <li>
                <strong>50 branches</strong> per window, independently for notes and AI chats.
              </li>
              <li>
                Deleting a window removes its whole subtree, after a preview of exactly what goes.
              </li>
              <li>
                Chat requests use <strong>your own API key</strong> with any OpenAI-compatible
                provider. It is stored in this browser only and never included in canvas exports;
                requests go directly to the provider whose base URL you configure.
              </li>
              <li>
                Everything — notes, conversations, positions and sizes — is stored locally and
                restored on refresh. Export to JSON for a portable copy.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
