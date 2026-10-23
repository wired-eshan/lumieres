/**
 * Chat transport dispatcher.
 *
 * The graph, editor and canvas layers import nothing from here; `chatRuntime`
 * is their boundary. This module owns the one decision they must not make:
 * which protocol adapter executes a conversation request. All provider
 * transport details live in `ai/adapters/`; provider metadata lives in
 * `ai/provider.ts`; effort mapping lives in `ai/effort.ts`.
 *
 * The API key travels only in the resolved config for the selected provider and
 * is never logged here. Error messages pass through `ai/errors.ts`, which
 * redacts keys and authorization headers.
 */

import { CHAT_MAX_TOKENS } from '../config';
import { adapterForProtocol } from './adapters';
import type { AdapterResult } from './adapters/types';
import type { ChatTurn } from './chatContext';
import { mapEffortForRequest, type EffortResolution } from './effort';
import {
  AIRequestError,
  describeError,
  isAbortError,
  isRetryable,
  redactSecrets,
} from './errors';
import {
  validateProviderConfig,
  type ResolvedProviderConfig,
} from './provider';

export { AIRequestError, CHAT_MAX_TOKENS, describeError };

export interface StreamChatInput {
  /** The active provider's fully resolved configuration. */
  config: ResolvedProviderConfig;
  system: string;
  messages: ChatTurn[];
  /** Only used when the provider supports it and the runtime verified the history. */
  previousResponseId?: string;
  signal: AbortSignal;
  /** Called for every text delta, with the text received so far. */
  onText: (delta: string, snapshot: string) => void;
}

export interface StreamChatResult extends AdapterResult {
  /** What happened to the requested reasoning effort, for tests and diagnostics. */
  effort: EffortResolution;
}

export interface GenerateChatInput {
  config: ResolvedProviderConfig;
  system: string;
  messages: ChatTurn[];
  previousResponseId?: string;
  signal?: AbortSignal;
}

export interface GenerateChatResult extends AdapterResult {
  effort: EffortResolution;
}

function assertSendable(config: ResolvedProviderConfig): void {
  const issues = validateProviderConfig(config);
  const missingKey = issues.find((issue) => issue.code === 'missing_api_key');
  const other = issues.find((issue) => issue.code !== 'missing_api_key');
  if (other) throw new AIRequestError(other.message);
  if (missingKey) throw new AIRequestError(missingKey.message);
}

function resolveEffort(config: ResolvedProviderConfig): EffortResolution {
  return mapEffortForRequest({
    providerId: config.providerId,
    protocol: config.protocol,
    modelId: config.model,
    requested: config.reasoningEffort,
    stored: config.effortCapability,
  });
}

function continuationFor(
  config: ResolvedProviderConfig,
  previousResponseId: string | undefined,
): string | undefined {
  // Defence in depth: even if a caller supplies an id, it is never sent to a
  // provider that does not advertise continuation support.
  return config.continuationEnabled ? previousResponseId : undefined;
}

/** Adapters translate provider errors, but this boundary is the final guarantee. */
function safeRequestError(
  error: AIRequestError,
  config: ResolvedProviderConfig,
): AIRequestError {
  const message = redactSecrets(error.message, [config.apiKey]);
  return message === error.message
    ? error
    : new AIRequestError(message, error.retryable);
}

export async function streamChat(input: StreamChatInput): Promise<StreamChatResult> {
  assertSendable(input.config);
  const effort = resolveEffort(input.config);
  const adapter = adapterForProtocol(input.config.protocol);

  try {
    const result = await adapter.stream({
      config: input.config,
      effort,
      system: input.system,
      messages: input.messages,
      previousResponseId: continuationFor(input.config, input.previousResponseId),
      signal: input.signal,
      onText: input.onText,
    });
    return { ...result, effort };
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) {
      throw new AIRequestError('Request stopped.', false);
    }
    if (error instanceof AIRequestError) throw safeRequestError(error, input.config);
    throw new AIRequestError(
      describeError(error, {
        secrets: [input.config.apiKey],
        providerLabel: input.config.definition.label,
      }),
      isRetryable(error),
    );
  }
}

/**
 * Non-streaming path. Kept as a real implementation (not a stub) for a future
 * one-shot Q&A surface; the chat UI does not call it.
 */
export async function generateChat(input: GenerateChatInput): Promise<GenerateChatResult> {
  assertSendable(input.config);
  const effort = resolveEffort(input.config);
  const adapter = adapterForProtocol(input.config.protocol);

  try {
    const result = await adapter.generate({
      config: input.config,
      effort,
      system: input.system,
      messages: input.messages,
      previousResponseId: continuationFor(input.config, input.previousResponseId),
      signal: input.signal,
    });
    return { ...result, effort };
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      throw new AIRequestError('Request stopped.', false);
    }
    if (error instanceof AIRequestError) throw safeRequestError(error, input.config);
    throw new AIRequestError(
      describeError(error, {
        secrets: [input.config.apiKey],
        providerLabel: input.config.definition.label,
      }),
      isRetryable(error),
    );
  }
}
