/**
 * Protocol adapter registry.
 *
 * Resolution is by protocol, not by provider id: adding a provider that speaks
 * an existing protocol only needs a registry entry. A custom endpoint chooses
 * a protocol explicitly; built-ins never fall back between protocols.
 */

import { AIRequestError } from '../errors';
import type { ApiProtocol } from '../provider';
import { anthropicMessagesAdapter } from './anthropicMessages';
import { openAIChatAdapter } from './openaiChat';
import { openAIResponsesAdapter } from './openaiResponses';
import type { LLMAdapter } from './types';

const ADAPTERS: Record<ApiProtocol, LLMAdapter> = {
  'openai-responses': openAIResponsesAdapter,
  'anthropic-messages': anthropicMessagesAdapter,
  'openai-chat': openAIChatAdapter,
};

export function adapterForProtocol(protocol: ApiProtocol): LLMAdapter {
  const adapter = ADAPTERS[protocol];
  if (!adapter) {
    throw new AIRequestError(`No transport is registered for the “${protocol}” protocol.`);
  }
  return adapter;
}

export function registeredProtocols(): ApiProtocol[] {
  return Object.keys(ADAPTERS) as ApiProtocol[];
}

export { anthropicMessagesAdapter, openAIChatAdapter, openAIResponsesAdapter };
export type { LLMAdapter };
