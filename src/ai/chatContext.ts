/**
 * Context construction for an AI conversation window.
 *
 * Two budgets are enforced independently:
 *  - the document/lineage context uses the tested `buildNodeContext` projection
 *    (nearest ancestors, clipped under a character budget);
 *  - the conversation history keeps the most recent turns under its own budget.
 *
 * Nothing here sends every ancestor's full note. A long chat does not silently
 * crowd out the branch lineage either, because the two are assembled separately.
 */

import { AI_HISTORY_BUDGET } from '../config';
import { buildNodeContext } from './context';
import type { ChatMessage, GraphDocument, NodeId } from '../graph/types';

/** Characters of conversation history sent with a request (owned by config). */
export const DEFAULT_HISTORY_CHARACTERS = AI_HISTORY_BUDGET.maxCharacters;
/** Most turns considered, regardless of size (owned by config). */
export const MAX_HISTORY_MESSAGES = AI_HISTORY_BUDGET.maxMessages;

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function selectConversationHistory(
  messages: readonly ChatMessage[],
  maxCharacters: number = DEFAULT_HISTORY_CHARACTERS,
): ChatTurn[] {
  const usable = messages.filter((message) => message.content.trim().length > 0);
  const selected: ChatMessage[] = [];
  let used = 0;

  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const message = usable[index];
    if (!message) continue;
    if (selected.length >= MAX_HISTORY_MESSAGES) break;
    const cost = message.content.length;
    // Always keep at least the newest turn; otherwise stop before the budget.
    if (selected.length > 0 && used + cost > maxCharacters) break;
    selected.push(message);
    used += cost;
  }

  selected.reverse();
  // The Messages API expects a user turn first. Trim leading assistant turns
  // that were only kept because the window happened to start mid-conversation.
  while (selected.length > 0 && selected[0]?.role !== 'user') selected.shift();
  return selected.map((message) => ({ role: message.role, content: message.content }));
}

/**
 * A compact operator prompt. Note what it does *not* contain: other windows'
 * conversations or the whole subtree. Only this window, its captured source,
 * and a clipped nearest-ancestor lineage.
 */
export function buildChatSystemPrompt(doc: GraphDocument, nodeId: NodeId): string {
  const node = doc.nodes[nodeId];
  if (!node) return 'You are a helpful assistant.';

  const context = buildNodeContext(doc, nodeId);
  const sections: string[] = [
    'You are the AI collaborator inside one window of Lumières, a graph-structured thinking canvas. Every window is a node in a tree; the user can select any of your replies and branch it into a new window.',
    'Answer the conversation in this window only. Be direct and useful. Reply in plain text with short paragraphs; Markdown is shown literally in this window, so avoid decorative syntax and avoid tables.',
  ];

  sections.push(`Window title: ${node.title.trim() || '(untitled)'}`);

  if (context && context.content.trim().length > 0) {
    sections.push(
      `The user keeps this note in the same window as context for the conversation:\n"""\n${context.content}\n"""`,
    );
  }

  if (context?.sourceReference) {
    const stale = context.sourceReference.stale ? ' (the source has changed since this branch was made)' : '';
    sections.push(
      `This branch was created from selected text${stale}:\n"""\n${context.sourceReference.selectedTextSnapshot}\n"""`,
    );
  }

  if (context && context.ancestors.length > 0) {
    const lineage = context.ancestors
      .map(
        (ancestor) =>
          `- ${ancestor.distance === 1 ? 'Parent' : `Ancestor (${ancestor.distance} up)`}: ${ancestor.title || '(untitled)'}${ancestor.excerpt ? ` — ${ancestor.excerpt}` : ''}`,
      )
      .join('\n');
    sections.push(`Nearby lineage, nearest first (excerpts only):\n${lineage}`);
  }

  sections.push('The conversation history below belongs to this window alone. Do not assume access to any other window\'s chat.');
  return sections.join('\n\n');
}
