/**
 * Per-node AI session state.
 *
 * State only — there is no transport, no provider and no network call anywhere
 * in this module. It exists so that the isolation rules the product requires are
 * encoded and testable *now*, rather than being discovered later:
 *
 *  1. Sessions are keyed by node id. Two windows can run at once and neither can
 *     observe the other's messages, status or streamed text.
 *  2. Every request carries an id. A response whose id is not the node's current
 *     request is dropped, so a slow answer can never overwrite a newer one.
 *  3. Cancellation is per node — cancelling one window's request leaves every
 *     other window's request untouched.
 */

import type { NodeId } from '../graph/types';
import {
  createEmptySession,
  type AIMessage,
  type AIRequestId,
  type AISessionMap,
  type AISessionStatus,
  type NodeAISession,
} from './types';
import { createId } from '../utils/id';

export interface AISessionStoreSnapshot {
  sessions: AISessionMap;
  /** Requests currently in flight, across all nodes. */
  activeRequests: number;
}

export class AISessionStore {
  private sessions = new Map<NodeId, NodeAISession>();
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private replace(nodeId: NodeId, session: NodeAISession): void {
    this.sessions.set(nodeId, { ...session, updatedAt: Date.now() });
    this.notify();
  }

  getSession(nodeId: NodeId): NodeAISession {
    return this.sessions.get(nodeId) ?? createEmptySession(nodeId);
  }

  getSnapshot(): AISessionStoreSnapshot {
    const sessions: AISessionMap = {};
    let activeRequests = 0;
    for (const [nodeId, session] of this.sessions) {
      sessions[nodeId] = session;
      if (session.status === 'running') activeRequests += 1;
    }
    return { sessions, activeRequests };
  }

  /** Number of nodes with a request in flight. */
  activeCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (session.status === 'running') count += 1;
    return count;
  }

  isActive(nodeId: NodeId, requestId: AIRequestId): boolean {
    const session = this.sessions.get(nodeId);
    return Boolean(session && session.status === 'running' && session.activeRequestId === requestId);
  }

  addUserMessage(nodeId: NodeId, content: string): AIMessage {
    const session = this.getSession(nodeId);
    const message: AIMessage = {
      id: createId('msg'),
      role: 'user',
      content,
      createdAt: Date.now(),
    };
    this.replace(nodeId, { ...session, messages: [...session.messages, message] });
    return message;
  }

  /**
   * Starts a request for one node. Any request already running for that node is
   * superseded — its future events will be dropped by the id checks below.
   */
  beginRequest(nodeId: NodeId, requestId: AIRequestId = createId('req')): AIRequestId {
    const session = this.getSession(nodeId);
    this.replace(nodeId, { ...session, status: 'running', activeRequestId: requestId, lastError: null });
    return requestId;
  }

  /** Appends streamed text. Returns false when the event is stale. */
  appendDelta(nodeId: NodeId, requestId: AIRequestId, text: string): boolean {
    const session = this.sessions.get(nodeId);
    if (!session || session.status !== 'running' || session.activeRequestId !== requestId) return false;

    const messages = session.messages.slice();
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && last.requestId === requestId) {
      messages[messages.length - 1] = { ...last, content: last.content + text };
    } else {
      messages.push({
        id: createId('msg'),
        role: 'assistant',
        content: text,
        createdAt: Date.now(),
        requestId,
      });
    }
    this.replace(nodeId, { ...session, messages });
    return true;
  }

  complete(nodeId: NodeId, requestId: AIRequestId, content?: string): boolean {
    const session = this.sessions.get(nodeId);
    if (!session || session.status !== 'running' || session.activeRequestId !== requestId) return false;

    let messages = session.messages;
    if (typeof content === 'string') {
      messages = messages.slice();
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant' && last.requestId === requestId) {
        messages[messages.length - 1] = { ...last, content };
      } else {
        messages.push({
          id: createId('msg'),
          role: 'assistant',
          content,
          createdAt: Date.now(),
          requestId,
        });
      }
    }
    this.replace(nodeId, { ...session, messages, status: 'completed', activeRequestId: null });
    return true;
  }

  fail(nodeId: NodeId, requestId: AIRequestId, message: string): boolean {
    const session = this.sessions.get(nodeId);
    if (!session || session.activeRequestId !== requestId) return false;
    this.replace(nodeId, { ...session, status: 'error', activeRequestId: null, lastError: message });
    return true;
  }

  /** Cancels this node's request only. Other nodes keep running. */
  cancel(nodeId: NodeId, requestId?: AIRequestId): boolean {
    const session = this.sessions.get(nodeId);
    if (!session || session.activeRequestId === null) return false;
    if (requestId && session.activeRequestId !== requestId) return false;
    const cancelled = session.activeRequestId;
    this.replace(nodeId, {
      ...session,
      status: 'cancelled' as AISessionStatus,
      activeRequestId: null,
      cancelledRequestIds: [...session.cancelledRequestIds, cancelled],
    });
    return true;
  }

  /** Drops a node's session entirely (window closed). */
  disposeSession(nodeId: NodeId): void {
    if (this.sessions.delete(nodeId)) this.notify();
  }

  clear(): void {
    this.sessions.clear();
    this.notify();
  }
}
