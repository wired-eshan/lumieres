/**
 * Back-compat shim.
 *
 * The prompt/context assembly logic now lives in `./prompt.ts` (the single
 * place to edit prompts). This file re-exports the old surface so existing
 * imports keep working unchanged. Prefer importing from `./prompt` directly;
 * this shim exists only to avoid touching every consumer in one pass.
 */

export {
  buildNodeContext,
  estimateContextCharacters,
  type BuildContextOptions,
} from './prompt';