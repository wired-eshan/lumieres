/**
 * Onboarding tour definition.
 *
 * Target ids live on the real controls (toolbar and window chrome) rather than
 * on wrappers created only for the tour, so the spotlight always lines up with
 * what the user will actually click. `reactjs-onboarding` persists completion
 * under `__reactjs_onboarding_<name>`; the constant is exported so the app and
 * tests can check or reset it without duplicating the library's convention.
 */

export const TOUR_NAME = 'lumieres-welcome';
export const TOUR_COMPLETION_KEY = `__reactjs_onboarding_${TOUR_NAME}`;

export interface TourStep {
  /** DOM id of the control to spotlight. */
  targetId: string;
  /** Plain-text tooltip copy (the library renders text, not JSX). */
  message: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    targetId: 'tour-canvas-title',
    message:
      'Rename this canvas anytime. The title is saved with the canvas and appears in your local library.',
  },
  {
    targetId: 'tour-history',
    message:
      'Undo and redo. Branching, moving, resizing, mode switches and text edits each become one undoable step.',
  },
  {
    targetId: 'tour-transfer',
    message:
      'Download the whole canvas as a JSON file, or upload one to restore it. Exports never include your API key.',
  },
  {
    targetId: 'tour-reset',
    message:
      'Reset canvas clears everything and starts again with a single empty root note. You are asked to confirm first.',
  },
  {
    targetId: 'tour-settings',
    message:
      'App settings are where you add your own API key, choose a provider and model, or remove the key. Keys stay in this browser only.',
  },
  {
    targetId: 'tour-mode-toggle',
    message:
      'Switch any window between a plain note and an AI conversation. Your note text and chat history are both kept when you switch modes.',
  },
  {
    targetId: 'tour-note-body',
    message:
      'Highlight a phrase in a note — or in an AI reply — and choose “Create branch”. A connected child window opens with that text as its source.',
  },
];
