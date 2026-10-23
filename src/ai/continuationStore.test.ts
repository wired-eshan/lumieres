import { describe, expect, it } from 'vitest';
import { ContinuationStore } from './continuationStore';
import type { ChatTurn } from './chatContext';

const TURNS: ChatTurn[] = [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'first answer' },
];

describe('continuation store', () => {
  it('resolves only when the history is a strict append extension', () => {
    const store = new ContinuationStore(() => 100);
    store.record('node', 'openai', 'gpt-5.2', 'resp_1', TURNS);

    expect(store.resolve('node', 'openai', 'gpt-5.2', [
      ...TURNS,
      { role: 'user', content: 'second' },
    ])).toEqual({
      responseId: 'resp_1',
      turns: [{ role: 'user', content: 'second' }],
    });
  });

  it('rejects an unchanged or shorter history and clears the state', () => {
    const store = new ContinuationStore(() => 100);
    store.record('node', 'openai', 'gpt-5.2', 'resp_1', TURNS);

    expect(store.resolve('node', 'openai', 'gpt-5.2', TURNS)).toBeNull();
    expect(store.get('node')).toBeUndefined();
  });

  it('rejects edited history even when the length matches', () => {
    const store = new ContinuationStore(() => 100);
    store.record('node', 'openai', 'gpt-5.2', 'resp_1', TURNS);

    expect(
      store.resolve('node', 'openai', 'gpt-5.2', [
        { role: 'user', content: 'edited' },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second' },
      ]),
    ).toBeNull();
  });

  it('invalidates on provider or model change and never leaks an id across them', () => {
    const store = new ContinuationStore(() => 100);
    store.record('node', 'openai', 'gpt-5.2', 'resp_1', TURNS);
    expect(
      store.resolve('node', 'anthropic', 'gpt-5.2', [
        ...TURNS,
        { role: 'user', content: 'second' },
      ]),
    ).toBeNull();
    expect(store.get('node')).toBeUndefined();

    store.record('node', 'openai', 'gpt-5.2', 'resp_2', TURNS);
    expect(
      store.resolve('node', 'openai', 'gpt-5', [
        ...TURNS,
        { role: 'user', content: 'second' },
      ]),
    ).toBeNull();
  });

  it('copies the recorded history so later mutation cannot alter it', () => {
    const store = new ContinuationStore(() => 100);
    const history: ChatTurn[] = TURNS.map((turn) => ({ ...turn }));
    store.record('node', 'openai', 'gpt-5.2', 'resp_1', history);
    history[0] = { role: 'user', content: 'mutated' };

    expect(
      store.resolve('node', 'openai', 'gpt-5.2', [
        ...TURNS,
        { role: 'user', content: 'second' },
      ]),
    ).not.toBeNull();
  });

  it('ignores an empty response id and can clear one node or all', () => {
    const store = new ContinuationStore(() => 100);
    store.record('a', 'openai', 'm', '', TURNS);
    expect(store.size).toBe(0);

    store.record('a', 'openai', 'm', 'resp_a', TURNS);
    store.record('b', 'openai', 'm', 'resp_b', TURNS);
    expect(store.size).toBe(2);
    store.clear('a');
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBeDefined();
    store.clearAll();
    expect(store.size).toBe(0);
  });
});
