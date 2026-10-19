/**
 * Per-window AI request runtime.
 *
 * The graph document holds the *conversation*; this module owns everything that
 * exists only while a request is in flight. The split is deliberate:
 *
 *  - tokens stream into `AISessionStore` (in memory) and never touch the graph,
 *    so streaming does not schedule an autosave per token and does not rerender
 *    the canvas;
 *  - when a response finishes it is appended to that node's persisted chat in a
 *    single document update;
 *  - every request is keyed by `(nodeId, requestId)`, so two windows can stream
 *    concurrently and a late response can never overwrite newer state;
 *  - cancellation aborts exactly one request.
 *
 * No global queue: requests run independently. A small configurable cap bounds
 * total concurrency so a burst of windows cannot open unlimited connections.
 */

import type { GraphController } from '../graph/graphController';
import { graphController } from '../graph/graphController';
import { MAX_NODE_CONTENT_LENGTH, type ChatMessage, type NodeId } from '../graph/types';
import { createId } from '../utils/id';
import { truncate } from '../utils/misc';
import {
  buildChatSystemPrompt,
  selectConversationHistory,
  type ChatTurn,
} from './chatContext';
import {
  AIRequestError,
  streamChat,
  type StreamChatInput,
  type StreamChatResult,
} from './chatService';
import { aiSessionStore, type AISessionStore } from './sessionStore';
import { getAISettings, type AISettings } from './settings';

export const MAX_CONCURRENT_REQUESTS = 4;
/** Deltas are batched to this cadence before touching the session store. */
const DELTA_FLUSH_MS = 50;

export type ChatSendCode =
  | 'NO_KEY'
  | 'NOT_AI_WINDOW'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'CONCURRENCY_LIMIT'
  | 'APPEND_FAILED';

export type ChatSendOutcome =
  | { ok: true; requestId: string }
  | { ok: false; code: ChatSendCode; message: string };

interface StreamState {
  nodeId: NodeId;
  requestId: string;
  controller: AbortController;
  text: string;
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** True when the user explicitly stopped it (partial text is kept). */
  interrupted: boolean;
  /** Guards against persisting a stopped response twice. */
  partialPersisted: boolean;
}

export interface ChatRuntimeDeps {
  controller: Pick<
    GraphController,
    'getDocument' | 'appendChatMessage' | 'updateTitle' | 'flushPendingDrafts'
  >;
  sessions: AISessionStore;
  getSettings: () => AISettings;
  stream: (input: StreamChatInput) => Promise<StreamChatResult>;
  now: () => number;
  newId: (prefix: string) => string;
  /** Override the global request cap (tests, or a future settings surface). */
  maxConcurrentRequests?: number;
}

export class ChatRuntime {
  private readonly deps: ChatRuntimeDeps;
  private readonly streams = new Map<NodeId, StreamState>();
  private readonly maxConcurrent: number;

  constructor(deps: ChatRuntimeDeps) {
    this.deps = deps;
    this.maxConcurrent = Math.max(1, deps.maxConcurrentRequests ?? MAX_CONCURRENT_REQUESTS);
  }

  subscribe = (listener: () => void): (() => void) => this.deps.sessions.subscribe(listener);

  /** Streaming text for this window; empty unless a request is running. */
  getStreamingText(nodeId: NodeId): string {
    const session = this.deps.sessions.getSession(nodeId);
    if (session.status !== 'running') return '';
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index];
      if (message?.role === 'assistant' && message.requestId === session.activeRequestId) {
        return message.content;
      }
    }
    return '';
  }

  isRunning(nodeId: NodeId): boolean {
    return this.deps.sessions.getSession(nodeId).status === 'running';
  }

  /** Appends the user turn, then starts one independent request for this node. */
  send(nodeId: NodeId, rawText: string): ChatSendOutcome {
    const settings = this.deps.getSettings();
    if (settings.apiKey.trim().length === 0) {
      return {
        ok: false,
        code: 'NO_KEY',
        message: 'Add an API key in Settings to start chatting.',
      };
    }

    const doc = this.deps.controller.getDocument();
    const node = doc.nodes[nodeId];
    if (!node || node.kind !== 'ai') {
      return { ok: false, code: 'NOT_AI_WINDOW', message: 'This window is not an AI conversation.' };
    }

    const text = rawText.trim();
    if (text.length === 0) {
      return { ok: false, code: 'EMPTY', message: 'Type a message first.' };
    }
    if (text.length > MAX_NODE_CONTENT_LENGTH) {
      return {
        ok: false,
        code: 'TOO_LONG',
        message: `A message can hold at most ${MAX_NODE_CONTENT_LENGTH.toLocaleString('en-US')} characters.`,
      };
    }

    // A second send supersedes this node's own request; it never touches others.
    this.abortNode(nodeId, false);

    if (this.deps.sessions.activeCount() >= this.maxConcurrent) {
      return {
        ok: false,
        code: 'CONCURRENCY_LIMIT',
        message: `Up to ${this.maxConcurrent} conversations can run at once. Stop one and try again.`,
      };
    }

    const now = this.deps.now();
    const userMessage: ChatMessage = {
      id: this.deps.newId('msg'),
      role: 'user',
      content: text,
      createdAt: now,
    };
    const appended = this.deps.controller.appendChatMessage(nodeId, userMessage);
    if (!appended.ok) {
      return { ok: false, code: 'APPEND_FAILED', message: appended.message };
    }

    // A conversation window with no title takes its first question as a title,
    // so it is identifiable on a large canvas.
    if (node.title.trim().length === 0) {
      this.deps.controller.updateTitle(nodeId, truncate(firstLine(text), 60));
    }

    const current = this.deps.controller.getDocument();
    const history = selectConversationHistory(current.nodes[nodeId]?.chat ?? []);
    return this.start(nodeId, history, settings);
  }

  /** Re-sends the latest user turn without appending a duplicate. */
  retry(nodeId: NodeId): ChatSendOutcome {
    const settings = this.deps.getSettings();
    if (settings.apiKey.trim().length === 0) {
      return { ok: false, code: 'NO_KEY', message: 'Add an API key in Settings to retry.' };
    }

    const node = this.deps.controller.getDocument().nodes[nodeId];
    if (!node || node.kind !== 'ai') {
      return { ok: false, code: 'NOT_AI_WINDOW', message: 'This window is not an AI conversation.' };
    }

    let lastUserIndex = -1;
    for (let index = node.chat.length - 1; index >= 0; index -= 1) {
      if (node.chat[index]?.role === 'user') {
        lastUserIndex = index;
        break;
      }
    }
    if (lastUserIndex === -1) {
      return { ok: false, code: 'EMPTY', message: 'There is no message to retry.' };
    }

    this.abortNode(nodeId, false);
    if (this.deps.sessions.activeCount() >= this.maxConcurrent) {
      return {
        ok: false,
        code: 'CONCURRENCY_LIMIT',
        message: `Up to ${this.maxConcurrent} conversations can run at once. Stop one and try again.`,
      };
    }
    const history = selectConversationHistory(node.chat.slice(0, lastUserIndex + 1));
    return this.start(nodeId, history, settings);
  }

  /** Stops this node's request and keeps any partial response. */
  cancel(nodeId: NodeId): void {
    this.abortNode(nodeId, true);
  }

  /** Aborts and forgets a node's runtime state (window deleted or reset). */
  dispose(nodeId: NodeId): void {
    const state = this.streams.get(nodeId);
    if (state) {
      this.clearTimer(state);
      this.streams.delete(nodeId);
      state.controller.abort();
    }
    this.deps.sessions.disposeSession(nodeId);
  }

  /** Aborts every in-flight request (document replaced by an import). */
  disposeAll(): void {
    for (const nodeId of [...this.streams.keys()]) this.dispose(nodeId);
    this.deps.sessions.clear();
  }

  private start(
    nodeId: NodeId,
    history: ChatTurn[],
    settings: AISettings,
  ): ChatSendOutcome {
    if (history.length === 0) {
      return { ok: false, code: 'EMPTY', message: 'Type a message first.' };
    }

    const requestId = this.deps.newId('req');
    const controller = new AbortController();
    const state: StreamState = {
      nodeId,
      requestId,
      controller,
      text: '',
      pending: '',
      timer: null,
      interrupted: false,
      partialPersisted: false,
    };
    this.streams.set(nodeId, state);
    this.deps.sessions.beginRequest(nodeId, requestId);

    const doc = this.deps.controller.getDocument();
    const system = buildChatSystemPrompt(doc, nodeId);

    void this.execute(state, {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      system,
      messages: history,
      signal: controller.signal,
      onText: (delta) => this.onDelta(state, delta),
    });

    return { ok: true, requestId };
  }

  private onDelta(state: StreamState, delta: string): void {
    if (this.streams.get(state.nodeId) !== state) return;
    state.text += delta;
    state.pending += delta;
    if (state.timer !== null) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      this.flushDelta(state);
    }, DELTA_FLUSH_MS);
  }

  private flushDelta(state: StreamState): void {
    if (state.pending.length === 0) return;
    const chunk = state.pending;
    state.pending = '';
    this.deps.sessions.appendDelta(state.nodeId, state.requestId, chunk);
  }

  private clearTimer(state: StreamState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private async execute(state: StreamState, input: StreamChatInput): Promise<void> {
    try {
      const result = await this.deps.stream(input);
      this.clearTimer(state);
      this.flushDelta(state);
      if (this.streams.get(state.nodeId) !== state) return;

      const finalText = result.text.trim().length > 0 ? result.text : state.text;
      if (!this.deps.sessions.isActive(state.nodeId, state.requestId)) return;
      if (finalText.trim().length === 0) {
        this.deps.sessions.fail(state.nodeId, state.requestId, 'The model returned an empty response.');
        this.streams.delete(state.nodeId);
        return;
      }

      this.deps.controller.appendChatMessage(state.nodeId, {
        id: this.deps.newId('msg'),
        role: 'assistant',
        content: finalText,
        createdAt: this.deps.now(),
      });
      this.deps.sessions.complete(state.nodeId, state.requestId, finalText);
      // The persisted document now owns the text; drop the streaming buffer.
      this.deps.sessions.disposeSession(state.nodeId);
      this.streams.delete(state.nodeId);
    } catch (error) {
      this.clearTimer(state);

      // A user-initiated stop keeps what had already streamed, even if the
      // transport has not rejected yet. Persisting here makes the UI immediate;
      // the flag stops the rejection handler from appending it twice.
      if (state.interrupted) {
        this.persistPartialOnce(state);
        this.deps.sessions.disposeSession(state.nodeId);
        this.streams.delete(state.nodeId);
        return;
      }

      if (this.streams.get(state.nodeId) !== state) return;
      if (!this.deps.sessions.isActive(state.nodeId, state.requestId)) {
        this.streams.delete(state.nodeId);
        return;
      }

      const message =
        error instanceof AIRequestError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'The request failed.';
      this.deps.sessions.fail(state.nodeId, state.requestId, message);
      this.streams.delete(state.nodeId);
    }
  }

  /** Keeps what the user already read when they press Stop. */
  private persistPartialOnce(state: StreamState): void {
    if (state.partialPersisted) return;
    state.partialPersisted = true;
    const text = state.text.trim().length > 0 ? state.text : null;
    if (!text) return;
    this.deps.controller.appendChatMessage(state.nodeId, {
      id: this.deps.newId('msg'),
      role: 'assistant',
      content: text,
      createdAt: this.deps.now(),
      interrupted: true,
    });
  }

  private abortNode(nodeId: NodeId, interrupted: boolean): void {
    const state = this.streams.get(nodeId);
    if (!state) return;
    state.interrupted = interrupted;
    this.clearTimer(state);
    this.flushDelta(state);
    // Cancel the session in both cases: a superseded request must stop counting
    // toward the concurrency limit, and a stopped one is recorded as cancelled.
    // Disposing also discards the old streaming buffer, so a new request starts
    // from a clean slate rather than accumulating superseded text.
    this.deps.sessions.cancel(nodeId, state.requestId);
    this.deps.sessions.disposeSession(nodeId);
    this.streams.delete(nodeId);
    if (interrupted) {
      // Keep the partial answer now rather than waiting for the transport to
      // reject, so Stop is reflected in the document immediately.
      this.persistPartialOnce(state);
    }
    state.controller.abort();
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.trim();
}

export const chatRuntime = new ChatRuntime({
  controller: graphController,
  sessions: aiSessionStore,
  getSettings: getAISettings,
  stream: streamChat,
  now: () => Date.now(),
  newId: createId,
});
