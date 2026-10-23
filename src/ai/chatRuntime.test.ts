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
import { mapEffortForRequest } from './effort';
import { PROVIDERS } from './provider';
import {
  createDefaultAISettings,
  makeProviderProfile,
  type AISettings,
} from './settings';

interface Harness {
  runtime: ChatRuntime;
  sessions: AISessionStore;
  doc(): GraphDocument;
  requests: StreamChatInput[];
  addNode(kind: WindowKind): string;
  setKind(nodeId: string, kind: WindowKind): void;
  resolve(index: number, result?: Partial<StreamChatResult>): void;
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
  const settings: AISettings = createDefaultAISettings();
  settings.providerId = 'openrouter';
  settings.profiles.openrouter = makeProviderProfile('openrouter', {
    apiKey: options.apiKey ?? 'sk-test',
    model: PROVIDERS.openrouter.defaultModel,
  });
  const emptyEffort = mapEffortForRequest({
    providerId: 'openrouter',
    protocol: 'openai-responses',
    modelId: PROVIDERS.openrouter.defaultModel,
    requested: '',
  });

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
    resolve: (
      index,
      result: Partial<StreamChatResult> = {},
    ) => {
      pending[index]?.resolve({
        text: `answer ${index}`,
        stopReason: 'end_turn',
        responseId: null,
        effort: emptyEffort,
        ...result,
      });
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

  it('passes the resolved provider, endpoint, model and effort to the transport', () => {
    const harness = createHarness();
    harness.settings.profiles.openrouter = makeProviderProfile('openrouter', {
      apiKey: 'sk-test',
      model: 'openai/gpt-5',
      reasoningEffort: 'high',
    });
    const root = harness.doc().rootNodeId;

    expect(harness.runtime.send(root, 'hello').ok).toBe(true);
    expect(harness.requests[0]?.config).toMatchObject({
      providerId: 'openrouter',
      protocol: 'openai-responses',
      baseUrl: PROVIDERS.openrouter.defaultBaseUrl,
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

  it('reports an invalid custom-provider configuration instead of sending', () => {
    const harness = createHarness();
    harness.settings.providerId = 'custom';
    harness.settings.customProtocol = 'openai-responses';
    harness.settings.profiles.custom = makeProviderProfile('custom', {
      apiKey: 'sk-test',
      baseUrl: '',
      model: 'my-model',
    });
    const root = harness.doc().rootNodeId;

    const outcome = harness.runtime.send(root, 'hello');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('INVALID_CONFIG');
    expect(harness.requests).toHaveLength(0);
  });

  it('uses an OpenAI continuation id only for an append-only history on the same provider and model', async () => {
    const harness = createHarness();
    harness.settings.providerId = 'openai';
    harness.settings.profiles.openai = makeProviderProfile('openai', {
      apiKey: 'sk-test',
      model: 'gpt-5.2',
    });
    const root = harness.doc().rootNodeId;

    harness.runtime.send(root, 'first');
    expect(harness.requests[0]?.previousResponseId).toBeUndefined();
    expect(harness.requests[0]?.messages.map((turn) => turn.content)).toEqual(['first']);
    harness.resolve(0, { text: 'first answer', responseId: 'resp_1' });
    await settle();

    harness.runtime.send(root, 'second');
    expect(harness.requests[1]?.previousResponseId).toBe('resp_1');
    // Only the new turn is sent; the provider already has the first exchange.
    expect(harness.requests[1]?.messages.map((turn) => turn.content)).toEqual(['second']);
    harness.resolve(1, { text: 'second answer', responseId: 'resp_2' });
    await settle();

    // A model change invalidates the continuation; the full history is rebuilt.
    harness.settings.profiles.openai = makeProviderProfile('openai', {
      apiKey: 'sk-test',
      model: 'gpt-5',
    });
    harness.runtime.send(root, 'third');
    expect(harness.requests[2]?.previousResponseId).toBeUndefined();
    expect(harness.requests[2]?.messages.map((turn) => turn.content)).toEqual([
      'first',
      'first answer',
      'second',
      'second answer',
      'third',
    ]);
  });

  it('never sends a continuation id across a provider switch', async () => {
    const harness = createHarness();
    harness.settings.providerId = 'openai';
    harness.settings.profiles.openai = makeProviderProfile('openai', {
      apiKey: 'sk-test',
      model: 'gpt-5.2',
    });
    const root = harness.doc().rootNodeId;

    harness.runtime.send(root, 'one');
    harness.resolve(0, { text: 'one answer', responseId: 'resp_openai' });
    await settle();

    harness.settings.providerId = 'anthropic';
    harness.settings.profiles.anthropic = makeProviderProfile('anthropic', {
      apiKey: 'sk-ant',
      model: 'claude-opus-5-5',
    });
    harness.runtime.send(root, 'two');
    expect(harness.requests[1]?.previousResponseId).toBeUndefined();
    expect(harness.requests[1]?.config.protocol).toBe('anthropic-messages');
    expect(harness.requests[1]?.messages.map((turn) => turn.content)).toEqual([
      'one',
      'one answer',
      'two',
    ]);
  });

  it('invalidates a rejected continuation so Retry rebuilds the full history', async () => {
    const harness = createHarness();
    harness.settings.providerId = 'openai';
    harness.settings.profiles.openai = makeProviderProfile('openai', {
      apiKey: 'sk-test',
      model: 'gpt-5.2',
    });
    const root = harness.doc().rootNodeId;

    harness.runtime.send(root, 'one');
    harness.resolve(0, { text: 'one answer', responseId: 'resp_1' });
    await settle();

    harness.runtime.send(root, 'two');
    expect(harness.requests[1]?.previousResponseId).toBe('resp_1');
    harness.reject(1, 'previous_response_not_found');
    await settle();
    expect(harness.sessions.getSession(root).status).toBe('error');

    const retry = harness.runtime.retry(root);
    expect(retry.ok).toBe(true);
    expect(harness.requests[2]?.previousResponseId).toBeUndefined();
    expect(harness.requests[2]?.messages.map((turn) => turn.content)).toEqual([
      'one',
      'one answer',
      'two',
    ]);
  });

  it('clears a continuation when Stop persists a partial reply', async () => {
    const harness = createHarness();
    harness.settings.providerId = 'openai';
    harness.settings.profiles.openai = makeProviderProfile('openai', {
      apiKey: 'sk-test',
      model: 'gpt-5.2',
    });
    const root = harness.doc().rootNodeId;

    harness.runtime.send(root, 'one');
    harness.resolve(0, { text: 'one answer', responseId: 'resp_1' });
    await settle();

    harness.runtime.send(root, 'two');
    harness.requests[1]?.onText('partial', 'partial');
    harness.runtime.cancel(root);
    await settle();

    expect(lastChat(harness, root).at(-1)).toMatchObject({
      role: 'assistant',
      content: 'partial',
      interrupted: true,
    });

    const retry = harness.runtime.retry(root);
    expect(retry.ok).toBe(true);
    expect(harness.requests[2]?.previousResponseId).toBeUndefined();
    expect(harness.requests[2]?.messages.map((turn) => turn.content)).toEqual([
      'one',
      'one answer',
      'two',
    ]);
  });

  it('ignores continuation ids for stateless providers such as DeepSeek', async () => {
    const harness = createHarness();
    harness.settings.providerId = 'deepseek';
    harness.settings.profiles.deepseek = makeProviderProfile('deepseek', {
      apiKey: 'sk-test',
      model: 'deepseek-flash',
    });
    const root = harness.doc().rootNodeId;

    harness.runtime.send(root, 'one');
    // Even if a provider returns an id, a capability that says stateless wins.
    harness.resolve(0, { text: 'one answer', responseId: 'resp_unused' });
    await settle();

    harness.runtime.send(root, 'two');
    expect(harness.requests[1]?.previousResponseId).toBeUndefined();
    expect(harness.requests[1]?.messages.map((turn) => turn.content)).toEqual([
      'one',
      'one answer',
      'two',
    ]);
  });
});
