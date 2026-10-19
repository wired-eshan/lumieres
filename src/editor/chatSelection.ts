/**
 * Reads a text selection out of the chat transcript.
 *
 * Chat replies are ordinary DOM text (not a textarea), so offsets are recovered
 * from the DOM range. A branch reference must index a single message, so a
 * selection that spans two turns is rejected rather than producing offsets that
 * mean something different when the reference is checked later.
 */

export interface ChatSelection {
  messageId: string;
  /** UTF-16 offsets into the message content. */
  start: number;
  end: number;
  text: string;
  /** Horizontal screen position of the selection end, relative to `container`. */
  endX: number;
}

const MESSAGE_SELECTOR = '[data-chat-message-id]';
const CONTENT_SELECTOR = '[data-chat-message-content]';

export function readChatSelection(container: HTMLElement): ChatSelection | null {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const startMessage = closestElement(range.startContainer, MESSAGE_SELECTOR);
  const endMessage = closestElement(range.endContainer, MESSAGE_SELECTOR);
  if (!startMessage || !endMessage) return null;
  if (!container.contains(startMessage) || !container.contains(endMessage)) return null;
  if (startMessage !== endMessage) return null;

  const content = startMessage.querySelector<HTMLElement>(CONTENT_SELECTOR);
  if (!content) return null;
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;

  const start = offsetWithin(content, range.startContainer, range.startOffset);
  const end = offsetWithin(content, range.endContainer, range.endOffset);
  const text = range.toString();
  if (end <= start || text.trim().length === 0) return null;

  const endRect = selectionEndRect(range);
  const containerRect = container.getBoundingClientRect();
  return {
    messageId: startMessage.getAttribute('data-chat-message-id') ?? '',
    start,
    end,
    text,
    endX: endRect ? endRect.right - containerRect.left : 0,
  };
}

function closestElement(node: Node | null, selector: string): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(selector) ?? null;
}

/** UTF-16 offset of a DOM point within an element's text content. */
function offsetWithin(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

function selectionEndRect(range: Range): DOMRect | null {
  // jsdom implements Range selection offsets but not geometry.
  const rects =
    typeof range.getClientRects === 'function' ? range.getClientRects() : null;
  const last = rects && rects.length > 0 ? rects[rects.length - 1] : null;
  if (last) return last;
  if (typeof range.getBoundingClientRect !== 'function') return null;
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? rect : null;
}
