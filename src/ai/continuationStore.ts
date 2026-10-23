/**
 * Provider-managed continuation state, kept deliberately separate from the
 * graph document's canonical conversation history.
 *
 * Only providers that advertise `supportsPreviousResponseId` use this. The
 * runtime asks `resolve` for a continuation only when the assembled history is
 * exactly the history that produced the previous response plus one new user
 * turn. Anything else — a provider or model switch, trimmed history, a stopped
 * partial reply, an import — falls back to sending the complete normalized
 * history, so messages are never duplicated and an id from one provider is
 * never sent to another.
 *
 * This store is in memory only. A refresh loses the ids, which is safe: the
 * next request sends the full history from the document.
 */

import type { NodeId } from '../graph/types';
import type { ChatTurn } from './chatContext';
import type { ProviderId } from './provider';

export interface ContinuationState {
  nodeId: NodeId;
  providerId: ProviderId;
  model: string;
  responseId: string;
  /** The full normalized history that produced `responseId`. */
  turns: ChatTurn[];
  updatedAt: number;
}

export interface ContinuationMatch {
  responseId: string;
  /** Only the turns not already covered by `responseId`. */
  turns: ChatTurn[];
}

function sameTurn(a: ChatTurn | undefined, b: ChatTurn | undefined): boolean {
  return Boolean(a && b && a.role === b.role && a.content === b.content);
}

export class ContinuationStore {
  private readonly states = new Map<NodeId, ContinuationState>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  get(nodeId: NodeId): ContinuationState | undefined {
    return this.states.get(nodeId);
  }

  /**
   * Returns a usable continuation id and the new turns when — and only when —
   * the provider/model match and `history` is a strict append extension of the
   * turns that produced the stored response.
   *
   * A mismatch invalidates the stored state. It is cheaper to rebuild history
   * than to risk sending a provider an id whose context does not match.
   */
  resolve(
    nodeId: NodeId,
    providerId: ProviderId,
    model: string,
    history: readonly ChatTurn[],
  ): ContinuationMatch | null {
    const state = this.states.get(nodeId);
    if (!state) return null;

    if (state.providerId !== providerId || state.model !== model) {
      this.states.delete(nodeId);
      return null;
    }
    if (history.length !== state.turns.length + 1) {
      this.states.delete(nodeId);
      return null;
    }
    for (let index = 0; index < state.turns.length; index += 1) {
      if (!sameTurn(state.turns[index], history[index])) {
        this.states.delete(nodeId);
        return null;
      }
    }

    return {
      responseId: state.responseId,
      turns: history.slice(state.turns.length),
    };
  }

  /** Stores the id returned with a completed response and the history it covers. */
  record(
    nodeId: NodeId,
    providerId: ProviderId,
    model: string,
    responseId: string,
    history: readonly ChatTurn[],
  ): void {
    if (responseId.length === 0) return;
    this.states.set(nodeId, {
      nodeId,
      providerId,
      model,
      responseId,
      turns: history.map((turn) => ({ role: turn.role, content: turn.content })),
      updatedAt: this.now(),
    });
  }

  clear(nodeId: NodeId): void {
    this.states.delete(nodeId);
  }

  clearAll(): void {
    this.states.clear();
  }

  get size(): number {
    return this.states.size;
  }
}
