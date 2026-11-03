/**
 * The AI conversation body.
 *
 * Chat turns are persisted in the graph document; only in-flight text lives in
 * the session store. That means a streaming answer does not rewrite the document
 * (or schedule an autosave) on every token, and two windows can stream at once
 * without seeing each other's state.
 *
 * Selecting text in a reply creates a branch exactly as selecting text in a note
 * does. Offsets are taken from the DOM range and recorded against that message's
 * id, so the source reference can later tell whether it is stale.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useEngine } from '../../app/EngineContext';
import { useUI } from '../../app/UIContext';
import { useGraphStore } from '../../graph/graphStore';
import { NODE_CONTENT_PADDING } from '../../graph/metrics';
import type { BranchActionState } from '../../canvas/engine';
import { CHARACTER_LIMIT, applyTextEdit, limitMessage, limitStatus } from '../../editor/characterLimit';
import { readChatSelection } from '../../editor/chatSelection';
import { aiSessionStore } from '../../ai/sessionStore';
import { chatRuntime } from '../../ai/chatRuntime';
import { mapEffortForRequest } from '../../ai/effort';
import { getProviderDefinition } from '../../ai/provider';
import { isAIConfigured, resolveAISettings } from '../../ai/settings';
import { useAISettings } from '../../hooks/useAISettings';
import { formatCount } from '../../utils/misc';
import { ChatIcon, SendIcon, SettingsIcon, StopIcon } from '../icons';

export interface AIChatPanelProps {
  nodeId: string;
}

/**
 * Unsent composer text, kept for the lifetime of the page. Closing a window or
 * toggling it to note mode unmounts this component; the draft should be waiting
 * when the user comes back. It is not document state and is never persisted.
 */
const composerDrafts = new Map<string, string>();

export function AIChatPanel({ nodeId }: AIChatPanelProps): ReactNode {
  const engine = useEngine();
  const { openSettings } = useUI();
  const node = useGraphStore((state) => state.doc.nodes[nodeId]);
  const settings = useAISettings();
  const [draft, setDraft] = useState(() => composerDrafts.get(nodeId) ?? '');
  /** Mirrors `draft` synchronously so two fast Enter presses cannot duplicate. */
  const draftRef = useRef(composerDrafts.get(nodeId) ?? '');
  const messagesRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Follow streamed text only while the reader is already at the bottom. */
  const stickToBottom = useRef(true);

  const session = useSyncExternalStore(
    aiSessionStore.subscribe,
    () => aiSessionStore.getSession(nodeId),
    () => aiSessionStore.getSession(nodeId),
  );

  const running = session.status === 'running';
  const streamingText = useMemo(() => {
    if (!running) return '';
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index];
      if (message?.role === 'assistant' && message.requestId === session.activeRequestId) {
        return message.content;
      }
    }
    return '';
  }, [running, session]);

  const configured = isAIConfigured(settings);
  const providerLabel = getProviderDefinition(settings.providerId).label;
  const resolvedConfig = resolveAISettings(settings);
  const effortResolution = mapEffortForRequest({
    providerId: resolvedConfig.providerId,
    protocol: resolvedConfig.protocol,
    modelId: resolvedConfig.model,
    requested: resolvedConfig.reasoningEffort,
    stored: resolvedConfig.effortCapability,
  });
  const effortWarning =
    resolvedConfig.reasoningEffort !== '' && !effortResolution.applied
      ? (effortResolution.note ??
        'The saved reasoning effort is not supported by this model. Requests use the provider default.')
      : null;

  /* -------------------------------------------------------------- */
  /* Selection → branch action                                      */
  /* -------------------------------------------------------------- */

  const readBranchAction = useCallback((): BranchActionState | null => {
    const container = messagesRef.current;
    if (!container) return null;
    const selection = readChatSelection(container);
    if (!selection) return null;
    const current = engine.getNode(nodeId);
    if (!current) return null;
    const zoom = engine.camera.zoom || 1;
    const x = current.position.x + NODE_CONTENT_PADDING + selection.endX / zoom;
    return {
      nodeId,
      text: selection.text,
      start: selection.start,
      end: selection.end,
      sourceMessageId: selection.messageId,
      anchor: {
        x: Math.max(current.position.x, Math.min(x, current.position.x + current.size.width)),
        y: current.position.y,
      },
    };
  }, [engine, nodeId]);

  const syncBranchAction = useCallback(() => {
    engine.setBranchAction(readBranchAction());
  }, [engine, readBranchAction]);

  useEffect(() => {
    engine.registerSelectionResolver(readBranchAction);
    return () => {
      engine.registerSelectionResolver(null);
      engine.clearBranchActionFor(nodeId);
    };
  }, [engine, nodeId, readBranchAction]);

  useEffect(() => {
    const schedule = (): void => {
      requestAnimationFrame(syncBranchAction);
    };
    document.addEventListener('selectionchange', schedule);
    return () => document.removeEventListener('selectionchange', schedule);
  }, [syncBranchAction]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [nodeId]);

  // Keep the newest turn in view. This is a coarse scroll, not per-token layout.
  useEffect(() => {
    const element = messagesRef.current;
    if (!element || !stickToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [node?.chat.length, session.status, streamingText]);

  // If the node disappears while open, release its request and runtime state.
  useEffect(
    () => () => {
      if (!useGraphStore.getState().doc.nodes[nodeId]) {
        composerDrafts.delete(nodeId);
        chatRuntime.dispose(nodeId);
      }
    },
    [nodeId],
  );

  if (!node) return null;

  const send = (): void => {
    if (running) return;
    const text = draftRef.current;
    if (text.trim().length === 0) return;
    const outcome = chatRuntime.send(nodeId, text);
    if (outcome.ok) {
      draftRef.current = '';
      composerDrafts.delete(nodeId);
      setDraft('');
      stickToBottom.current = true;
      requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
      return;
    }
    if (outcome.code === 'NO_KEY') {
      openSettings();
      return;
    }
    if (outcome.code === 'INVALID_CONFIG') {
      engine.notify(outcome.message, 'error');
      openSettings();
      return;
    }
    engine.notify(outcome.message, outcome.code === 'EMPTY' ? 'info' : 'error');
  };

  const retry = (): void => {
    const outcome = chatRuntime.retry(nodeId);
    if (outcome.ok) return;
    if (outcome.code === 'NO_KEY' || outcome.code === 'INVALID_CONFIG') {
      if (outcome.code === 'INVALID_CONFIG') engine.notify(outcome.message, 'error');
      openSettings();
    } else {
      engine.notify(outcome.message, 'error');
    }
  };

  const handleComposerChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const target = event.target;
    const next = target.value;
    const caret = typeof target.selectionStart === 'number' ? target.selectionStart : next.length;
    const result = applyTextEdit(draft, next, CHARACTER_LIMIT, caret);
    if (result.value !== next) {
      target.value = result.value;
      target.setSelectionRange(result.caret, result.caret);
    }
    draftRef.current = result.value;
    if (result.value.length > 0) composerDrafts.set(nodeId, result.value);
    else composerDrafts.delete(nodeId);
    setDraft(result.value);
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const status = limitStatus(draft);
  const countMessage = limitMessage(status);

  return (
    <div className="ai-chat">
      <div
        className="ai-chat__messages"
        ref={messagesRef}
        onMouseUp={() => requestAnimationFrame(syncBranchAction)}
        onKeyUp={() => requestAnimationFrame(syncBranchAction)}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        }}
        aria-label="Conversation"
        role="log"
      >
        {node.chat.length === 0 && !running ? (
          <div className="ai-chat__empty">
            <span className="ai-chat__empty-mark" aria-hidden="true">
              <ChatIcon size={18} />
            </span>
            <p>
              <strong>Ask this window anything.</strong>
              <br />
              Its note, source excerpt and nearby lineage are sent as context. Select a reply to
              branch it into a new window.
            </p>
            {node.content.trim().length > 0 ? (
              <span className="ai-chat__context-note">
                Using this window&apos;s note ({formatCount(node.content.length)} characters) as
                context.
              </span>
            ) : null}
          </div>
        ) : null}

        {node.chat.map((message) => (
          <article
            key={message.id}
            className={`ai-message is-${message.role}${message.interrupted ? ' is-interrupted' : ''}`}
            data-chat-message-id={message.id}
          >
            <span className="ai-message__role">
              {message.role === 'user' ? 'You' : 'Assistant'}
              {message.interrupted ? ' · stopped' : ''}
            </span>
            <div className="ai-message__content" data-chat-message-content>
              {message.content}
            </div>
          </article>
        ))}

        {running ? (
          // No message id while streaming: the text is not persisted yet, so a
          // branch reference into it could not be checked later.
          <article className="ai-message is-assistant is-streaming">
            <span className="ai-message__role">Assistant</span>
            <div className="ai-message__content">
              {streamingText || 'Thinking…'}
              <span className="ai-chat__cursor" aria-hidden="true" />
            </div>
          </article>
        ) : null}

        {session.status === 'error' && session.lastError ? (
          <div className="ai-chat__error" role="alert">
            <span>{session.lastError}</span>
            <div className="ai-chat__error-actions">
              <button type="button" className="button" onClick={retry}>
                Retry
              </button>
              <button
                type="button"
                className="button"
                onClick={openSettings}
                aria-label="Open AI settings"
              >
                <SettingsIcon size={14} /> Settings
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {!configured ? (
        <div className="ai-chat__notice" role="status">
          <span>Add your API key in Settings to start a conversation.</span>
          <button type="button" className="button" onClick={openSettings}>
            Open settings
          </button>
        </div>
      ) : effortWarning ? (
        <div className="ai-chat__notice" role="status">
          <span>{effortWarning}</span>
          <button type="button" className="button" onClick={openSettings}>
            Review settings
          </button>
        </div>
      ) : null}

      <div className="ai-chat__composer">
        <textarea
          ref={composerRef}
          className="ai-chat__input"
          value={draft}
          onChange={handleComposerChange}
          onKeyDown={handleComposerKeyDown}
          onFocus={() => engine.clearBranchActionFor(nodeId)}
          placeholder={
            configured
              ? `Message this window…  (${providerLabel}, Enter to send)`
              : 'Add a key in Settings to chat…'
          }
          aria-label="Message"
          rows={2}
          spellCheck
        />
        <div className="ai-chat__composer-bar">
          <span className={`ai-chat__count${status.level === 'normal' ? '' : ` is-${status.level}`}`}>
            {countMessage ??
              (draft.length > 0 ? `${formatCount(status.used)} / ${formatCount(status.limit)}` : 'Enter to send · Shift+Enter for a new line')}
          </span>
          {running ? (
            <button
              type="button"
              className="button ai-chat__send"
              onClick={() => chatRuntime.cancel(nodeId)}
              title="Stop this response"
              aria-label="Stop this response"
            >
              <StopIcon size={13} /> Stop
            </button>
          ) : (
            <button
              type="button"
              className="button is-primary ai-chat__send"
              onClick={send}
              disabled={!configured || draft.trim().length === 0}
              title={configured ? 'Send this message' : 'Add an API key first'}
              aria-label="Send message"
            >
              <SendIcon size={13} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
