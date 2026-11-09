import { describe, expect, it } from 'vitest';
import { buildChatSystemPrompt, selectConversationHistory } from './chatContext';
import {
  createBranch,
  createEmptyDocument,
  setNodeKind,
  updateNodeContent,
} from '../graph/graphOperations';
import type { ChatMessage, GraphDocument } from '../graph/types';

function setContent(doc: GraphDocument, nodeId: string, content: string): GraphDocument {
  const result = updateNodeContent(doc, nodeId, content);
  if (!result.ok) throw new Error(result.message);
  return result.value.doc;
}

function turn(content: string, role: 'user' | 'assistant', id: string): ChatMessage {
  return { id, role, content, createdAt: 1 };
}

describe('chat history selection', () => {
  it('keeps the newest turns under the character budget', () => {
    const history = [
      turn('oldest', 'user', '1'),
      turn('middle', 'assistant', '2'),
      turn('newest', 'user', '3'),
    ];
    const selected = selectConversationHistory(history, 12);
    expect(selected.map((entry) => entry.content)).toEqual(['newest']);
  });

  it('always keeps the newest turn even when it exceeds the budget', () => {
    const history = [turn('x'.repeat(50), 'user', '1')];
    expect(selectConversationHistory(history, 10)).toHaveLength(1);
  });

  it('drops leading assistant turns so the API receives a user-first history', () => {
    const history = [
      turn('assistant-only', 'assistant', '1'),
      turn('question', 'user', '2'),
      turn('answer', 'assistant', '3'),
    ];
    expect(selectConversationHistory(history, 1000)).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ]);
  });

  it('caps the number of turns sent', () => {
    const history = Array.from({ length: 120 }, (_, index) =>
      turn(`message ${index}`, index % 2 === 0 ? 'user' : 'assistant', String(index)),
    );
    expect(selectConversationHistory(history, 100_000).length).toBeLessThanOrEqual(80);
  });
});

describe('chat system prompt', () => {
  it('includes the window note, source snapshot and clipped lineage', () => {
    let doc = createEmptyDocument('Prompt');
    const root = doc.rootNodeId;
    const parentText = 'Parent context about photosynthesis';
    const sourceStart = parentText.indexOf('photosynthesis');
    doc = setContent(doc, root, parentText);

    const child = createBranch(doc, {
      parentId: root,
      position: { x: 500, y: 0 },
      kind: 'ai',
      sourceReference: {
        sourceNodeId: root,
        selectedTextSnapshot: 'photosynthesis',
        startOffset: sourceStart,
        endOffset: sourceStart + 'photosynthesis'.length,
        sourceContentVersion: 1,
      },
    });
    if (!child.ok) throw new Error(child.message);
    doc = child.value.doc;
    doc = setContent(doc, child.value.node.id, 'My own note about light');
    const switched = setNodeKind(doc, child.value.node.id, 'ai');
    if (!switched.ok) throw new Error(switched.message);

    const prompt = buildChatSystemPrompt(switched.value.doc, child.value.node.id);
    expect(prompt).toContain('My own note about light');
    expect(prompt).toContain('photosynthesis');
    expect(prompt).toContain('Parent context about photosynthesis');
    expect(prompt).toContain('plain text');
  });

  it('grounds a clarify request in the original problem/source concept', () => {
    let doc = createEmptyDocument('Two sum');
    const root = doc.rootNodeId;
    doc = setContent(doc, root, 'Find two numbers that add up to a target.');

    const child = createBranch(doc, {
      parentId: root,
      position: { x: 500, y: 0 },
      kind: 'ai',
    });
    if (!child.ok) throw new Error(child.message);
    doc = child.value.doc;

    // A deepen-branch clarify request must surface the original problem anchor
    // and the re-grounding instruction…
    const clarify = buildChatSystemPrompt(doc, child.value.node.id, {
      query: 'can you explain this more clearly?',
    });
    expect(clarify).toContain('Original problem / source concept');
    expect(clarify).toContain('Find two numbers that add up to a target.');
    expect(clarify).toContain('Ground your answer in the original problem');

    // …while a normal query keeps the grounding instruction out.
    const normal = buildChatSystemPrompt(doc, child.value.node.id, {
      query: 'give me an example',
    });
    expect(normal).not.toContain('Ground your answer in the original problem');
    expect(normal).toContain('Original problem / source concept');
  });

  it('never concatenates another window\'s conversation', () => {
    let doc = createEmptyDocument('Isolation');
    const root = doc.rootNodeId;
    const child = createBranch(doc, {
      parentId: root,
      position: { x: 500, y: 0 },
      kind: 'ai',
    });
    if (!child.ok) throw new Error(child.message);
    doc = child.value.doc;

    const withChat = {
      ...doc,
      nodes: {
        ...doc.nodes,
        [child.value.node.id]: {
          ...doc.nodes[child.value.node.id]!,
          chat: [turn('secret other conversation', 'user', 'x')],
        },
      },
    };

    const prompt = buildChatSystemPrompt(withChat, root);
    expect(prompt).not.toContain('secret other conversation');
  });
});
