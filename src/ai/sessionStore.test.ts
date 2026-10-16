/**
 * These tests cover *state isolation only*. There is no provider, no network
 * call and no mock response anywhere in the AI layer — the point is to prove
 * that the per-node session model behaves correctly before any of that exists.
 */

import { describe, expect, it } from 'vitest';
import { AISessionStore } from './sessionStore';
import { createEmptySession } from './types';
import { getAIService, isAIEnabled, registerAIService } from './serviceInterface';

describe('per-node AI session isolation', () => {
  it('keeps messages separate per node', () => {
    const store = new AISessionStore();
    store.addUserMessage('node-a', 'question for A');
    store.addUserMessage('node-b', 'question for B');

    expect(store.getSession('node-a').messages.map((message) => message.content)).toEqual([
      'question for A',
    ]);
    expect(store.getSession('node-b').messages.map((message) => message.content)).toEqual([
      'question for B',
    ]);
  });

  it('runs concurrent requests on different nodes without interference', () => {
    const store = new AISessionStore();
    const requestA = store.beginRequest('node-a');
    const requestB = store.beginRequest('node-b');

    expect(store.isActive('node-a', requestA)).toBe(true);
    expect(store.isActive('node-b', requestB)).toBe(true);
    expect(store.activeCount()).toBe(2);

    // Interleaved streaming deltas land on the right node.
    store.appendDelta('node-a', requestA, 'alpha ');
    store.appendDelta('node-b', requestB, 'beta ');
    store.appendDelta('node-a', requestA, 'one');

    const sessionA = store.getSession('node-a');
    expect(sessionA.messages[0]?.content).toBe('alpha one');
    expect(sessionA.messages[0]?.requestId).toBe(requestA);
    expect(store.getSession('node-b').messages[0]?.content).toBe('beta ');
  });

  it('scopes status to the node, never globally', () => {
    const store = new AISessionStore();
    const requestA = store.beginRequest('node-a');
    store.complete('node-a', requestA, 'done');

    expect(store.getSession('node-a').status).toBe('completed');
    expect(store.getSession('node-b').status).toBe('idle');
    expect(store.getSession('node-b').messages).toHaveLength(0);
  });

  it('drops a late response that belongs to a superseded request', () => {
    const store = new AISessionStore();
    const first = store.beginRequest('node-a');
    store.appendDelta('node-a', first, 'old partial');

    // A second request supersedes the first on the same node.
    const second = store.beginRequest('node-a');

    // The first request's stream is still in flight; its events must be ignored.
    expect(store.appendDelta('node-a', first, 'stale text')).toBe(false);
    expect(store.complete('node-a', first, 'stale completion')).toBe(false);

    expect(store.getSession('node-a').messages.map((message) => message.content)).toEqual([
      'old partial',
    ]);
    expect(store.getSession('node-a').activeRequestId).toBe(second);
    expect(store.getSession('node-a').status).toBe('running');
  });

  it('cancels only the requesting node', () => {
    const store = new AISessionStore();
    const requestA = store.beginRequest('node-a');
    const requestB = store.beginRequest('node-b');

    expect(store.cancel('node-a', requestA)).toBe(true);

    expect(store.getSession('node-a').status).toBe('cancelled');
    expect(store.getSession('node-a').activeRequestId).toBeNull();
    expect(store.getSession('node-a').cancelledRequestIds).toEqual([requestA]);

    // Unrelated work is untouched.
    expect(store.isActive('node-b', requestB)).toBe(true);
    expect(store.getSession('node-b').status).toBe('running');
    expect(store.activeCount()).toBe(1);
  });

  it('ignores a cancel for a request id that is no longer active', () => {
    const store = new AISessionStore();
    const first = store.beginRequest('node-a');
    const second = store.beginRequest('node-a');
    expect(store.cancel('node-a', first)).toBe(false);
    expect(store.getSession('node-a').activeRequestId).toBe(second);
  });

  it('scopes errors to the node that failed', () => {
    const store = new AISessionStore();
    const requestA = store.beginRequest('node-a');
    store.beginRequest('node-b');

    store.fail('node-a', requestA, 'rate limited');

    expect(store.getSession('node-a').status).toBe('error');
    expect(store.getSession('node-a').lastError).toBe('rate limited');
    expect(store.getSession('node-b').status).toBe('running');
    expect(store.getSession('node-b').lastError).toBeNull();
  });

  it('clears an error when a retry starts on the same node only', () => {
    const store = new AISessionStore();
    const requestA = store.beginRequest('node-a');
    store.fail('node-a', requestA, 'boom');
    store.beginRequest('node-a');

    expect(store.getSession('node-a').lastError).toBeNull();
    expect(store.getSession('node-a').status).toBe('running');
  });

  it('disposes a single node session and leaves the rest intact', () => {
    const store = new AISessionStore();
    store.addUserMessage('node-a', 'a');
    store.addUserMessage('node-b', 'b');

    store.disposeSession('node-a');

    expect(store.getSession('node-a').messages).toHaveLength(0);
    expect(store.getSession('node-b').messages).toHaveLength(1);
  });

  it('notifies subscribers on change', () => {
    const store = new AISessionStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.addUserMessage('node-a', 'hello');
    store.disposeSession('node-a');
    unsubscribe();
    store.addUserMessage('node-b', 'ignored');

    expect(notifications).toBe(2);
  });

  it('starts every node from an independent empty session', () => {
    const store = new AISessionStore();
    const session = store.getSession('fresh');
    expect(session).toEqual(createEmptySession('fresh', session.updatedAt));
    expect(session.status).toBe('idle');
    expect(session.activeRequestId).toBeNull();
  });
});

describe('AI service boundary', () => {
  it('is absent by default, so no AI affordance is shown', () => {
    expect(getAIService()).toBeNull();
    expect(isAIEnabled()).toBe(false);
  });

  it('can be registered and removed without touching the graph layer', () => {
    const service = {
      autocomplete: () => (async function* () {})() as AsyncIterable<string>,
      ask: async () => ({ requestId: 'r', nodeId: 'n', content: 'not called' }),
      cancel: () => undefined,
    };
    registerAIService(service);
    expect(isAIEnabled()).toBe(true);
    registerAIService(null);
    expect(getAIService()).toBeNull();
  });
});
