/**
 * What to call a window when its stored title is empty.
 *
 * This is a zero-cost, deterministic fallback — deliberately *not* an AI call:
 *
 *  1. **A3 — the conversation names itself.** If the window has chat, its first
 *     user turn is almost always the clearest label it will ever have, and it
 *     was already paid for. The assistant's replies are ignored: they answer the
 *     question, they do not name it.
 *  2. **A1 — extractive title from the note body.** First heading-like line,
 *     else the first sentence, else the most frequent content words. Cheap,
 *     local, and works with no API key configured.
 *
 * Only the *display* is derived. The stored `title` is never rewritten, so a
 * user who types a title always wins, and an empty title stays empty in the
 * document (exports, undo history and the editor field are unaffected).
 *
 * Results are memoised on node identity. Graph operations are immutable, so a
 * node object changes exactly when its title, body or chat does — which is
 * precisely when the derived title can change. The renderer calls this per
 * visible window per frame, so the cache is what keeps A1 off the frame path.
 */

import type { ChatMessage, NoteNode } from './types';
import { truncate } from '../utils/misc';

/** Matches the branch-title convention used by `deriveTitleFromSelection`. */
export const DISPLAY_TITLE_MAX_LENGTH = 60;

/**
 * Only the leading slice of a note can contribute to its title, so a 20,000
 * character body never costs more than this to inspect.
 */
const INSPECT_CHARACTERS = 2_000;

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'although', 'among', 'and',
  'another', 'any', 'are', 'because', 'been', 'before', 'being', 'between',
  'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'down', 'during',
  'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
  'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'into',
  'its', 'itself', 'just', 'more', 'most', 'much', 'must', 'myself', 'not',
  'now', 'off', 'once', 'only', 'other', 'our', 'ours', 'ourselves', 'out',
  'over', 'own', 'same', 'she', 'should', 'some', 'such', 'than', 'that',
  'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'too', 'under', 'until', 'very', 'was',
  'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why',
  'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/**
 * A heading-like line is short and does not end like prose. Markdown hashes are
 * stripped; a line that survives with them removed is a heading by construction.
 */
function isHeadingLike(line: string): boolean {
  if (/^#{1,6}\s+/.test(line)) return true;
  if (line.length > DISPLAY_TITLE_MAX_LENGTH) return false;
  return !/[.!?…;:]$/.test(line);
}

/** Text up to the first sentence terminator, or '' when the text is one clause. */
function firstSentence(text: string): string {
  const match = /[.!?…](?:\s|$)/.exec(text);
  if (!match) return '';
  return text.slice(0, match.index).replace(/[.!?…;:]+$/, '').trim();
}

/**
 * Last resort for text with no line break and no sentence break: the most
 * frequent non-stopword terms, in first-appearance order. Three words read as a
 * label ("signal pattern context"); one word rarely does.
 */
function salientPhrase(text: string): string {
  const words = text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [];
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const word of words) {
    if (STOPWORDS.has(word)) continue;
    if (!counts.has(word)) order.push(word);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return order
    .map((word, index) => ({ word, index, count: counts.get(word) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .slice(0, 3)
    .map((entry) => entry.word)
    .join(' ');
}

/** A1: deterministic, extractive title from note text. */
export function extractTitleFromContent(content: string): string {
  const text = content.slice(0, INSPECT_CHARACTERS).trim();
  if (text.length === 0) return '';

  const first = firstNonEmptyLine(text);
  const unhashed = first.replace(/^#{1,6}\s+/, '');
  if (unhashed !== first || isHeadingLike(first)) {
    return truncate(flatten(unhashed), DISPLAY_TITLE_MAX_LENGTH);
  }

  const sentence = firstSentence(text);
  if (sentence.length > 0) return truncate(flatten(sentence), DISPLAY_TITLE_MAX_LENGTH);

  return truncate(salientPhrase(text) || flatten(first), DISPLAY_TITLE_MAX_LENGTH);
}

/** A3: a conversation's first user turn, flattened to one line. */
export function deriveChatTitle(chat: readonly ChatMessage[]): string {
  for (const message of chat) {
    if (message.role !== 'user') continue;
    const title = truncate(flatten(message.content), DISPLAY_TITLE_MAX_LENGTH);
    if (title.length > 0) return title;
  }
  return '';
}

function computeDisplayTitle(node: Pick<NoteNode, 'title' | 'content' | 'chat'>): string {
  const explicit = node.title.trim();
  if (explicit.length > 0) return explicit;
  const fromChat = deriveChatTitle(node.chat);
  if (fromChat.length > 0) return fromChat;
  return extractTitleFromContent(node.content);
}

const memo = new WeakMap<object, string>();

/** The label to show for a window; empty only when it has nothing to draw from. */
export function displayTitle(node: Pick<NoteNode, 'title' | 'content' | 'chat'>): string {
  const key = node as object;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  const computed = computeDisplayTitle(node);
  memo.set(key, computed);
  return computed;
}
