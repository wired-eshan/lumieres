/**
 * The note body editor.
 *
 * A real `<textarea>` for all the native behaviour that comes with it: caret,
 * IME, spell check, paste and accessibility. It fills the window's body region
 * via flexbox, so a resize changes its geometry with the frame, and its
 * typography comes from the shared metrics module so it lands exactly on the
 * painted preview underneath.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useEngine } from '../../app/EngineContext';
import { useGraphStore } from '../../graph/graphStore';
import { BODY_FONT_SIZE, BODY_LINE_HEIGHT, NODE_CONTENT_PADDING } from '../../graph/metrics';
import { CHARACTER_LIMIT, applyTextEdit, limitMessage, limitStatus } from '../../editor/characterLimit';
import type { BranchActionState } from '../../canvas/engine';
import { branchAnchorWorld, measureSelection, readSelection } from '../../editor/selection';
import { formatCount } from '../../utils/misc';

export interface NoteEditorProps {
  nodeId: string;
}

export function NoteEditor({ nodeId }: NoteEditorProps): ReactNode {
  const engine = useEngine();
  const storeContent = useGraphStore((state) => state.doc.nodes[nodeId]?.content ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<number | null>(null);
  const [content, setContent] = useState(storeContent);

  /**
   * The single definition of "what is selected right now". The engine asks for
   * it both to show the floating action and again at click time.
   */
  const readBranchAction = useCallback((): BranchActionState | null => {
    const textarea = textareaRef.current;
    if (!textarea) return null;
    const selection = readSelection(textarea);
    if (!selection) return null;
    const geometry = measureSelection(textarea, selection.start, selection.end);
    if (!geometry || geometry.text.trim().length === 0) return null;
    const current = engine.getNode(nodeId);
    if (!current) return null;
    return {
      nodeId,
      text: geometry.text,
      start: selection.start,
      end: selection.end,
      anchor: branchAnchorWorld(current.position, NODE_CONTENT_PADDING, geometry),
    };
  }, [engine, nodeId]);

  const syncBranchAction = useCallback(() => {
    engine.setBranchAction(readBranchAction());
  }, [engine, readBranchAction]);

  const scheduleBranchSync = useCallback(() => {
    requestAnimationFrame(syncBranchAction);
  }, [syncBranchAction]);

  // The engine re-reads the live selection through this resolver on click.
  useEffect(() => {
    engine.registerSelectionResolver(readBranchAction);
    return () => engine.registerSelectionResolver(null);
  }, [engine, readBranchAction]);

  // Focus on mount so a freshly created branch is immediately typeable.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const frame = requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      if (textarea.selectionStart !== textarea.selectionEnd) return;
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(frame);
  }, [nodeId]);

  // Adopt external changes (undo, redo, import) that did not come from here.
  useEffect(() => {
    const draft = engine.getDraft(nodeId);
    if (draft === null || draft !== storeContent) setContent(storeContent);
  }, [storeContent, engine, nodeId]);

  // Restore the caret only when this component rewrote the browser's value.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || caretRef.current === null) return;
    const caret = caretRef.current;
    caretRef.current = null;
    textarea.setSelectionRange(caret, caret);
  }, [content]);

  const handleContentChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const target = event.target;
      const next = target.value;
      // Keep the caret the browser chose for accepted edits.
      const caretInNext =
        typeof target.selectionStart === 'number' ? target.selectionStart : next.length;
      const result = applyTextEdit(content, next, CHARACTER_LIMIT, caretInNext);
      if (result.limited) {
        const status = limitStatus(result.value);
        if (result.rejected) {
          engine.notify(limitMessage(limitStatus(content)) ?? 'Character limit reached.', 'error');
        } else {
          engine.notify(
            `Trimmed ${formatCount(result.droppedCharacters)} characters to stay within the ${formatCount(status.limit)}-character limit.`,
            'info',
          );
        }
      }
      if (result.value !== next) {
        target.value = result.value;
        caretRef.current = result.caret;
      }
      setContent(result.value);
      engine.setDraft(nodeId, result.value);
      scheduleBranchSync();
    },
    [content, engine, nodeId, scheduleBranchSync],
  );

  return (
    <textarea
      ref={textareaRef}
      className="note-window__body"
      style={{
        fontSize: BODY_FONT_SIZE,
        lineHeight: `${BODY_LINE_HEIGHT}px`,
      }}
      value={content}
      onChange={handleContentChange}
      onSelect={scheduleBranchSync}
      onKeyUp={scheduleBranchSync}
      onMouseUp={scheduleBranchSync}
      onScroll={scheduleBranchSync}
      onBlur={(event) => {
        // Clicking elsewhere dismisses the action unless focus is moving to it.
        const next = event.relatedTarget;
        if (next instanceof Element && next.closest('.branch-action')) return;
        engine.clearBranchActionFor(nodeId);
      }}
      placeholder="Write, or paste something worth thinking about…"
      aria-label="Note body"
      spellCheck
    />
  );
}