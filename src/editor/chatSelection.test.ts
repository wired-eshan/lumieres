import { afterEach, describe, expect, it } from 'vitest';
import { readChatSelection } from './chatSelection';

function buildTranscript(): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = `
    <article data-chat-message-id="m1">
      <span>Assistant</span>
      <div data-chat-message-content>Alpha beta gamma</div>
    </article>
    <article data-chat-message-id="m2">
      <span>You</span>
      <div data-chat-message-content>Second message text</div>
    </article>
  `;
  document.body.appendChild(container);
  return container;
}

function select(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): void {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
});

describe('chat selection offsets', () => {
  it('records offsets relative to the selected message', () => {
    const container = buildTranscript();
    const content = container.querySelector<HTMLElement>('[data-chat-message-id="m1"] [data-chat-message-content]');
    if (!content?.firstChild) throw new Error('content missing');

    select(content.firstChild, 6, content.firstChild, 10);
    const selection = readChatSelection(container);
    expect(selection).not.toBeNull();
    expect(selection?.messageId).toBe('m1');
    expect(selection?.text).toBe('beta');
    expect(selection?.start).toBe(6);
    expect(selection?.end).toBe(10);
  });

  it('rejects a selection that spans two turns', () => {
    const container = buildTranscript();
    const first = container.querySelector<HTMLElement>('[data-chat-message-id="m1"] [data-chat-message-content]');
    const second = container.querySelector<HTMLElement>('[data-chat-message-id="m2"] [data-chat-message-content]');
    if (!first?.firstChild || !second?.firstChild) throw new Error('content missing');

    select(first.firstChild, 3, second.firstChild, 6);
    expect(readChatSelection(container)).toBeNull();
  });

  it('rejects an empty selection', () => {
    const container = buildTranscript();
    const content = container.querySelector<HTMLElement>('[data-chat-message-id="m1"] [data-chat-message-content]');
    if (!content?.firstChild) throw new Error('content missing');
    select(content.firstChild, 4, content.firstChild, 4);
    expect(readChatSelection(container)).toBeNull();
  });

  it('ignores selections outside the transcript', () => {
    const container = buildTranscript();
    const outside = document.createElement('p');
    outside.textContent = 'elsewhere';
    document.body.appendChild(outside);
    select(outside.firstChild as Node, 0, outside.firstChild as Node, 4);
    expect(readChatSelection(container)).toBeNull();
  });
});
