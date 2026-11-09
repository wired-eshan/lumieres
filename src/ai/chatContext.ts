/**
 * Back-compat shim.
 *
 * The prompt/context assembly logic now lives in `./prompt.ts` (the single
 * place to edit prompts). This file re-exports the old surface so existing
 * imports keep working unchanged (transport + adapter + continuation code
 * import `ChatTurn` from here). Prefer importing from `./prompt` directly.
 */

export {
  buildChatSystemPrompt,
  selectConversationHistory,
  DEFAULT_HISTORY_CHARACTERS,
  MAX_HISTORY_MESSAGES,
  type ChatTurn,
} from './prompt';