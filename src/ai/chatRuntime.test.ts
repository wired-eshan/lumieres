import { describe, expect, it } from 'vitest';
import {
  appendChatMessage,
  createBranch,
  createEmptyDocument,
  getNode,
  setNodeKind,
  updateNodeTitle,
} from '../graph/graphOperations';
import type { GraphDocument, WindowKind } from '../graph/types';
import { AISessionStore } from './sessionStore';
import {
  ChatRuntime,
  MAX_CONCURRENT_REQUESTS,
  type ChatRuntimeDeps,
} from './chatRuntime';
import type { StreamChatInput, StreamChatResult } from './chatService';
import type { AISettings } from './settings';

interface Harness {
  runtime: ChatRuntime;
  sessions: AISessionStore;
  doc(): GraphDocument;
  requests: StreamChatInput[];
  addNode(kind: WindowKind): string;
  setKind(nodeId: string, kind: WindowKind): void;
  resolve(index: number, result?: StreamChatResult): void;
  reject(index: number, message: string): void;
  settings: AISettings;
}

function createHarness(options: { apiKey?: string } = {}): Harness {
  let doc = createEmptyDocument('AI');
  const root = doc.rootNodeId;
  const switched = setNodeKind(doc, root, 'ai');
  if (!switched.ok) throw new Error(switched.message);
  doc = switched.value.doc;

  const firstChild = createBranch(doc, {
    parentId: root,
    position: { x: 500, y: 0 },
    kind: 'ai',
  });
  if (!firstChild.ok) throw new Error(firstChild.message);
  doc = firstChild.value.doc;

  const sessions = new AISessionStore();
  const requests: StreamChatInput[] = [];
  const pending: Array<{
    resolve: (result: StreamChatResult) => void;
    reject: (error: unknown) => void;
  }> = [];

  let counter = 0;
  const settings: AISettings = {
    apiKey: options.apiKey ?? 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    reasoningEffort: '',
  };

  const deps: ChatRuntimeDeps = {
    controller: {
      getDocument: () => doc,
      appendChatMessage: (nodeId, message) => {
        const result = appendChatMessage(doc, nodeId, message);
        if (result.ok) doc = result.value.doc;
        return result;
      },
      updateTitle: (nodeId, title) => {
        const result = updateNodeTitle(doc, nodeId, title);
        if (result.ok) doc = result.value.doc;
        return result;
      },
      flushPendingDrafts: () => undefined,
    },
    sessions,
    getSettings: () => settings,
    stream: (input) => {
      requests.push(input);
      return new Promise<StreamChatResult>((resolve, reject) => {
        pending.push({ resolve, reject });
        input.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
    now: () => 10_000 + pending.length,
    newId: (prefix) => `${prefix}-${(counter += 1)}`,
  };

  return {
    runtime: new ChatRuntime(deps),
    sessions,
    doc: () => doc,
    requests,
    addNode: (kind) => {
      const branch = createBranch(doc, {
        parentId: root,
        position: { x: 500, y: Object.keys(doc.nodes).length * 300 },
        kind,
      });
      if (!branch.ok) throw new Error(branch.message);
      doc = branch.value.doc;
      return branch.value.node.id;
    },
    setKind: (nodeId, kind) => {
      const result = setNodeKind(doc, nodeId, kind);
      if (result.ok) doc = result.value.doc;
    },
    resolve: (index, result = { text: `answer ${index}`, stopReason: 'end_turn' }) => {
      pending[index]?.resolve(result);
    },
    reject: (index, message) => {
      const error = new Error(message);
      pending[index]?.reject(error);
    },
    settings,
  };
}

function lastChat(harness: Harness, nodeId: string) {
  return getNode(harness.doc(), nodeId)?.chat ?? [];
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 70));
}

describe('AI chat runtime', () => {
  it('persists the user turn immediately and the assistant turn on completion', async () => {
    const harness = createHarness();
    const root = harness.doc().rootNodeId;

    const outcome = harness.runtime.send(root, 'What is a branch?');
    expect(outcome.ok).toBe(true);
    expect(lastChat(harness, root).map((message) => message.content)).toEqual(['What is a branch?']);
    // The document's root already has a title, so it is left alone.
    expect(getNode(harness.doc(), root)?.title).toBe('Root note');

    harness.resolve(0, { text: 'A linked thought.', stopReason: 'end_turn' });
    await settle();

    expect(lastChat(harness, root).map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(lastChat(harness, root)[1]?.content).toBe('A linked thought.');
    expect(harness.sessions.getSession(root).status).toBe('idle');
  });

  it('streams deltas into this node only', async () => {
    const harness = createHarness();
    const root = harness.doc().rootNodeId;
    const [child] = Object.values(harness.doc().nodes).filter((node) => node.id !== root);
    if (!child) throw new Error('child missing');

    harness.runtime.send(root, 'question A');
    harness.runtime.send(child.id, 'question B');
    expect(harness.requests).toHaveLength(2);

    // Requests identify their window by the question they carry, not by global state.
    const rootRequest = harness.requests.findIndex((request) =>
      request.messages.at(-1)?.content.includes('question A'),
    );
    const childRequest = harness.requests.findIndex((request) =>
      request.messages.at(-1)?.content.includes('question B'),
    );
    expect(rootRequest).toBeGreaterThanOrEqual(0);
    expect(childRequest).toBeGreaterThanOrEqual(0);
    harness.requests[rootRequest]?.onText('alpha', 'alpha');
    harness.requests[childRequest]?.onText('beta', 'beta');
    await waitForFlush();

    expect(harness.runtime.getStreamingText(root)).toBe('alpha');
    expect(harness.runtime.getStreamingText(child.id)).toBe('beta');
  });

  it('drops a late response from a superseded request', async () => {
    const harness = createHarness();
    const root = harness.doc().rootNodeId;

    expect(harness.runtime.send(root, 'first question').ok).toBe(true);
    expect(harness.runtime.send(root, 'second question').ok).toBe(true);

    harness.resolve(0, { text: 'stale answer', stopReason: 'end_turn' });
    await settle();
    expect(lastChat(harness, root).map((message) => message.content)).toEqual([
      'first question',
      'second question',
    ]);

    harness.resolve(1, { text: 'fresh answer', stopReason: 'end_turn' });
    await settle();
    expect(lastChat(harness, root).map((message) => message.content)).toEqual([
      'first question',
      'second question',
      'fresh answer',
    ]);
  });

  it('cancels one window without touching another', async () => {
    const harness = createHarness();
    const root = harness.doc().rootNodeId;
    const child = Object.values(harness.doc().nodes).find((node) => node.id !== root);
    if (!child) throw new Error('child missing');

    harness.runtime.send(root, 'A');
    harness.runtime.send(child.id, 'B');
    harness.requests[0]?.onText('partial answer', 'partial answer');

    harness.runtime.cancel(root);
    await settle();

    // The partial answer the user saw is kept and marked interrupted.
    const rootChat = lastChat(harness, root);
    expect(rootChat.at(-1)?.role).toBe('assistant');
    expect(rootChat.at(-1)?.content).toBe('partial answer');
    expect(rootChat.at(-1)?.interrupted).toBe(true);
    expect(harness.runtime.isRunning(child.id)).toBe(true);

    harness.resolve(1, { text: 'B answer', stopReason: 'end_turn' });
    await settle();
    expect(lastChat(harness, child.id).at(-1)?.content).toBe('B answer');
  });

  it('scopes failures to the node and retries without duplicating the question', async () => {
    const harness = createHarness();
    const root = harness.doc().rootNodeId;

    harness.runtime.send(root, 'will fail');
    harness.reject(0, 'rate limited');
    await settle();

    expect(harness.sessions.getSession(root).status).toBe('error');
    expect(harness.sessions.getSession(root).lastError).toBe('rate limited');
    expect(lastChat(harness, root)).toHaveLength(1);

    const retry = harness.runtime.retry(root);
    expect(retry.ok).toBe(true);
    harness.resolve(1, { text: 'worked', stopReason: 'end_turn' });
    await settle();

    expect(lastChat(harness, root).map((message) => message.content)).toEqual([
      'will fail',
      'worked',
    ]);
  });

  it('passes the configured endpoint, model and effort to the transport', () => {
    const harness = createHarness();
    harness.settings.baseUrl = 'https://openrouter.ai/api/v1';
    harness.settings.model = 'openai/gpt-5';
    harness.settings.reasoningEffort = 'high';
    const root = harness.doc().rootNodeId;

    expect(harness.runtime.send(root, 'hello').ok).toBe(true);
    expect(harness.requests[0]).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    });
  });

  it('refuses to send without a key, leaving the conversation untouched', () => {
    const harness = createHarness({ apiKey: '' });
    const root = harness.doc().rootNodeId;
    const outcome = harness.runtime.send(root, 'hello');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NO_KEY');
    expect(lastChat(harness, root)).toHaveLength(0);
  });

  it('enforces a bounded number of concurrent conversations', () => {
    const harness = createHarness();
    const root = harness.doc().rootNodeId;
    const ids = [root];
    for (let index = 0; index < MAX_CONCURRENT_REQUESTS + 1; index += 1) {
      ids.push(harness.addNode('ai'));
    }

    let accepted = 0;
    let limited = 0;
    for (const id of ids) {
      const outcome = harness.runtime.send(id, `hi from ${id}`);
      if (outcome.ok) accepted += 1;
      else if (outcome.code === 'CONCURRENCY_LIMIT') limited += 1;
    }

    expect(accepted).toBe(MAX_CONCURRENT_REQUESTS);
    expect(limited).toBe(ids.length - MAX_CONCURRENT_REQUESTS);
  });

  it('does not send from a window that is in note mode', () => {
    const harness = createHarness();
    const noteId = harness.addNode('note');
    const outcome = harness.runtime.send(noteId, 'hello');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NOT_AI_WINDOW');
  });
});
