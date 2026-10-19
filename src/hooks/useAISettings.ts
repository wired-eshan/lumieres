import { useSyncExternalStore } from 'react';
import { getAISettings, subscribeAISettings, type AISettings } from '../ai/settings';

/** Subscribes a component to the user's local AI configuration. */
export function useAISettings(): AISettings {
  return useSyncExternalStore(subscribeAISettings, getAISettings, getAISettings);
}
