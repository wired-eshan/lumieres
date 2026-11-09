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

import {
  DELTA_FLUSH_MS,
  MAX_CONCURRENT_REQUESTS,
  MAX_NODE_CONTENT_LENGTH,
} from '../config';
import type { GraphController } from '../graph/graphController';
import { graphController } from '../graph/graphController';
import type { ChatMessage, NodeId } from '../graph/types';
import { createId } from '../utils/id';
import { truncate } from '../utils/misc';
import {
  buildChatSystemPrompt,
  selectConversationHistory,
  type ChatTurn,
} from './chatContext';
import {
  streamChat,
  type StreamChatInput,
  type StreamChatResult,
} from './chatService';
import { ContinuationStore } from './continuationStore';
import { describeError } from './errors';
import { lineageSummarizer, type LineageSummarizer } from './summarizer';
import { validateProviderConfig, type ResolvedProviderConfig } from './provider';
import { aiSessionStore, type AISessionStore } from './sessionStore';
import { getAISettings, resolveAISettings, type AISettings } from './settings';

/**
 * Global request cap, owned by `src/config.ts`. Re-exported for callers that
 * treat the runtime as the source of its operating limits.
 */
export { MAX_CONCURRENT_REQUESTS };

export type ChatSendCode =
  | 'NO_KEY'
  | 'INVALID_CONFIG'
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
  config: ResolvedProviderConfig;
  /** Full normalized history this response will cover, for continuation. */
  history: ChatTurn[];
  /** The user's latest message, used to prioritise relevant ancestor context. */
  query: string;
  /** True when this request is riding a provider continuation id. */
  usedContinuation: boolean;
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
  /** In-memory provider-continuation ids; separate from the document. */
  continuations?: ContinuationStore;
  /**
   * Fire-and-forget lineage-summary warmer. When present it is called (never
   * awaited) after a send so the *next* clarify request can carry an abstractive
   * summary. Defaults to the app-wide `lineageSummarizer`.
   */
  summarizer?: LineageSummarizer;
  now: () => number;
  newId: (prefix: string) => string;
  /** Override the global request cap (tests, or a future settings surface). */
  maxConcurrentRequests?: number;
}

export class ChatRuntime {
  private readonly deps: ChatRuntimeDeps;
  private readonly streams = new Map<NodeId, StreamState>();
  private readonly continuations: ContinuationStore;
  private readonly maxConcurrent: number;

  constructor(deps: ChatRuntimeDeps) {
    this.deps = deps;
    this.continuations = deps.continuations ?? new ContinuationStore(deps.now);
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
    const config = resolveAISettings(this.deps.getSettings());
    if (config.apiKey.length === 0) {
      return {
        ok: false,
        code: 'NO_KEY',
        message: `Add a ${config.definition.label} API key in Settings to start chatting.`,
      };
    }
    const configIssue = validateProviderConfig(config).find(
      (issue) => issue.code !== 'missing_api_key',
    );
    if (configIssue) {
      return { ok: false, code: 'INVALID_CONFIG', message: configIssue.message };
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
    // Warm the ancestor summary for the next request; never awaited, so an
    // interactive send stays instant whether or not a key is configured.
    (this.deps.summarizer ?? lineageSummarizer).warm(nodeId, current, text);
    return this.start(nodeId, history, config, text);
  }

  /** Re-sends the latest user turn without appending a duplicate. */
  retry(nodeId: NodeId): ChatSendOutcome {
    const config = resolveAISettings(this.deps.getSettings());
    if (config.apiKey.length === 0) {
      return {
        ok: false,
        code: 'NO_KEY',
        message: `Add a ${config.definition.label} API key in Settings to retry.`,
      };
    }
    const configIssue = validateProviderConfig(config).find(
      (issue) => issue.code !== 'missing_api_key',
    );
    if (configIssue) {
      return { ok: false, code: 'INVALID_CONFIG', message: configIssue.message };
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
    const retryQuery = node.chat[lastUserIndex]?.content ?? '';
    const current = this.deps.controller.getDocument();
    (this.deps.summarizer ?? lineageSummarizer).warm(nodeId, current, retryQuery);
    return this.start(nodeId, history, config, retryQuery);
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
    this.continuations.clear(nodeId);
  }

  /** Aborts every in-flight request (document replaced by an import). */
  disposeAll(): void {
    for (const nodeId of [...this.streams.keys()]) this.dispose(nodeId);
    this.deps.sessions.clear();
    this.continuations.clearAll();
  }

  private start(
    nodeId: NodeId,
    history: ChatTurn[],
    config: ResolvedProviderConfig,
    query: string,
  ): ChatSendOutcome {
    if (history.length === 0) {
      return { ok: false, code: 'EMPTY', message: 'Type a message first.' };
    }

    // Continuation is opt-in per capability and only valid for a strict append
    // extension of the turns that produced the previous response. Otherwise the
    // complete normalized history is sent. A provider/model switch invalidates
    // the stored id (including ids that belonged to a different provider).
    let messages = history;
    let previousResponseId: string | undefined;
    let usedContinuation = false;
    if (config.continuationEnabled) {
      const match = this.continuations.resolve(
        nodeId,
        config.providerId,
        config.model,
        history,
      );
      if (match) {
        messages = match.turns;
        previousResponseId = match.responseId;
        usedContinuation = true;
      }
    } else {
      this.continuations.clear(nodeId);
    }

    const requestId = this.deps.newId('req');
    const controller = new AbortController();
    const state: StreamState = {
      nodeId,
      requestId,
      controller,
      config,
      history: history.map((turn) => ({ role: turn.role, content: turn.content })),
      query,
      usedContinuation,
      text: '',
      pending: '',
      timer: null,
      interrupted: false,
      partialPersisted: false,
    };
    this.streams.set(nodeId, state);
    this.deps.sessions.beginRequest(nodeId, requestId);

    const doc = this.deps.controller.getDocument();
    const system = buildChatSystemPrompt(doc, nodeId, { query });

    void this.execute(state, {
      config,
      system,
      messages,
      previousResponseId,
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
        if (state.usedContinuation) this.continuations.clear(state.nodeId);
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
      // The provider id is stored only in memory and only when this provider
      // supports continuation. A full-history request that returns no id leaves
      // nothing stale behind.
      if (result.responseId && state.config.continuationEnabled) {
        // The provider's continuation covers its input plus this reply, so the
        // stored history must include the assistant turn. The next request then
        // sends only the new user turn.
        this.continuations.record(
          state.nodeId,
          state.config.providerId,
          state.config.model,
          result.responseId,
          [...state.history, { role: 'assistant', content: finalText }],
        );
      } else {
        this.continuations.clear(state.nodeId);
      }
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
        // The persisted partial reply extends the document history, so the
        // previous continuation no longer describes an append-only chain.
        this.continuations.clear(state.nodeId);
        this.deps.sessions.disposeSession(state.nodeId);
        this.streams.delete(state.nodeId);
        return;
      }

      // A failed continuation must not poison the next attempt: fall back to
      // full history rather than resending the same rejected id.
      if (state.usedContinuation) this.continuations.clear(state.nodeId);

      if (this.streams.get(state.nodeId) !== state) return;
      if (!this.deps.sessions.isActive(state.nodeId, state.requestId)) {
        this.streams.delete(state.nodeId);
        return;
      }

      const message = describeError(error, {
        secrets: [state.config.apiKey],
        providerLabel: state.config.definition.label,
      });
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
