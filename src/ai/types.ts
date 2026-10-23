/**
 * AI session types.
 *
 * Chat conversations are implemented: `chatRuntime.ts` drives requests and
 * `sessionStore.ts` holds their per-node runtime state. The types here also keep
 * the shape needed for the not-yet-built autocomplete and one-shot Q&A surfaces.
 *
 * Key properties the types preserve:
 *  - sessions are keyed by node id, so every window owns an independent session
 *  - each request carries its own id, so a late response can be discarded
 *  - status, messages and cancellation are per node, never global
 */

import { AI_CONTEXT_BUDGET } from '../config';
import type { NodeId } from '../graph/types';

export type AIRequestId = string;

export type AISessionStatus = 'idle' | 'running' | 'completed' | 'error' | 'cancelled';

export interface AIMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  createdAt: number;
  /** Set on assistant messages so streamed output can be attributed to a request. */
  requestId?: AIRequestId;
}

export interface NodeAISession {
  nodeId: NodeId;
  messages: AIMessage[];
  status: AISessionStatus;
  /** Only the newest request may write to this session. */
  activeRequestId: AIRequestId | null;
  /** Requests this node has issued and cancelled, for diagnostics. */
  cancelledRequestIds: AIRequestId[];
  lastError: string | null;
  updatedAt: number;
}

export function createEmptySession(nodeId: NodeId, now = Date.now()): NodeAISession {
  return {
    nodeId,
    messages: [],
    status: 'idle',
    activeRequestId: null,
    cancelledRequestIds: [],
    lastError: null,
    updatedAt: now,
  };
}

/**
 * Per-node session map. Deliberately `Record<NodeId, NodeAISession>` rather than
 * a single conversation: a shared global session is the one shape that would
 * make concurrent, independent windows impossible.
 */
export type AISessionMap = Record<NodeId, NodeAISession>;

/* ------------------------------------------------------------------ */
/* Context assembly                                                    */
/* ------------------------------------------------------------------ */

/**
 * Context handed to a future model call. Note what is *not* here: no
 * concatenation of every ancestor's full content. Ancestors are supplied as
 * summaries that the caller selects under an explicit budget.
 */
export interface AIContextBudget {
  /** Hard cap on characters of assembled context. */
  maxCharacters: number;
  /** How many ancestors may contribute, nearest first. */
  maxAncestors: number;
  /**
   * Smallest useful contribution from a single ancestor. When the remaining
   * budget cannot fund this, assembly stops rather than handing the model a
   * dozen meaningless fragments.
   */
  minAncestorCharacters: number;
}

export interface AIContextAncestor {
  nodeId: NodeId;
  title: string;
  /** Possibly truncated excerpt chosen by the caller. */
  excerpt: string;
  distance: number;
}

export interface AINodeContext {
  nodeId: NodeId;
  title: string;
  content: string;
  sourceReference: {
    sourceNodeId: NodeId;
    selectedTextSnapshot: string;
    startOffset: number;
    endOffset: number;
    stale: boolean;
  } | null;
  ancestors: AIContextAncestor[];
  /** Free-form context the user attached to this node. */
  userContext: string[];
  history: AIMessage[];
  budget: AIContextBudget;
}

/** Character budget defaults; values are owned by `src/config.ts`. */
export const DEFAULT_CONTEXT_BUDGET: AIContextBudget = { ...AI_CONTEXT_BUDGET };

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export interface AutocompleteInput {
  nodeId: NodeId;
  /** Text before the caret. */
  prefix: string;
  /** Text after the caret. */
  suffix: string;
  context: AINodeContext;
  requestId: AIRequestId;
}

export interface AskInput {
  nodeId: NodeId;
  question: string;
  context: AINodeContext;
  requestId: AIRequestId;
}

export interface AskResult {
  requestId: AIRequestId;
  nodeId: NodeId;
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type AIStreamEvent =
  | { type: 'start'; requestId: AIRequestId; nodeId: NodeId }
  | { type: 'delta'; requestId: AIRequestId; nodeId: NodeId; text: string }
  | { type: 'done'; requestId: AIRequestId; nodeId: NodeId; content: string }
  | { type: 'error'; requestId: AIRequestId; nodeId: NodeId; message: string }
  | { type: 'cancelled'; requestId: AIRequestId; nodeId: NodeId };
