import { describe, expect, it } from 'vitest';
import { AIRequestError } from '../errors';
import {
  adapterForProtocol,
  anthropicMessagesAdapter,
  openAIChatAdapter,
  openAIResponsesAdapter,
  registeredProtocols,
} from './index';

describe('protocol adapter registry', () => {
  it('maps each protocol to the real adapter', () => {
    expect(adapterForProtocol('openai-responses')).toBe(openAIResponsesAdapter);
    expect(adapterForProtocol('anthropic-messages')).toBe(anthropicMessagesAdapter);
    expect(adapterForProtocol('openai-chat')).toBe(openAIChatAdapter);
    expect(registeredProtocols().sort()).toEqual(
      ['anthropic-messages', 'openai-chat', 'openai-responses'].sort(),
    );
  });

  it('does not route Anthropic through the Responses adapter', () => {
    expect(adapterForProtocol('anthropic-messages')).not.toBe(openAIResponsesAdapter);
    expect(anthropicMessagesAdapter.protocol).toBe('anthropic-messages');
    expect(openAIResponsesAdapter.protocol).toBe('openai-responses');
  });

  it('fails loudly for an unknown protocol rather than falling back', () => {
    expect(() => adapterForProtocol('unknown-protocol' as never)).toThrow(AIRequestError);
  });
});
