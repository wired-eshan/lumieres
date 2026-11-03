/**
 * First-run product tour.
 *
 * The tour is intentionally thin: `reactjs-onboarding` owns spotlighting,
 * placement, keyboard navigation and persistence, while this component owns the
 * two app-specific pieces the library cannot know about:
 *
 * 1. Timing — the tour must not mount until the boot sequence has restored a
 *    document, otherwise the toolbar and window targets do not exist yet.
 * 2. Window targets — the mode toggle and note body only exist while a window
 *    is open, so the root window is opened before the tour mounts. This is
 *    interaction state (selection/editor), not a graph mutation, so it neither
 *    dirties the document nor enters the undo history.
 *
 * Replaying the tour (Help → Replay tour) still has to prepare the root window
 * first, because the user may have closed every editor since the first run.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Onboarding, OnboardingItem } from 'reactjs-onboarding';
import { useEngine } from '../../app/EngineContext';
import { useGraphStore } from '../../graph/graphStore';
import { TOUR_COMPLETION_KEY, TOUR_NAME, TOUR_STEPS } from '../../onboarding/tourConfig';

export interface ProductTourHandle {
  /** Re-opens the tour from the first step, opening the root window first. */
  start: () => void;
}

export interface ProductTourProps {
  /** False while the app is still restoring the document. */
  ready: boolean;
}

export const ProductTour = forwardRef<ProductTourHandle, ProductTourProps>(
  function ProductTour({ ready }, ref): ReactNode {
    const engine = useEngine();
    const [mounted, setMounted] = useState(false);
    const preparedRef = useRef(false);

    /** Opens the root note so the window-level steps have DOM targets. */
    const prepareTargets = useCallback(() => {
      const { doc } = useGraphStore.getState();
      const root = doc.nodes[doc.rootNodeId];
      if (!root) return;
      engine.focusNode(root.id, 1);
      engine.startEditing(root.id);
    }, [engine]);

    // `reactjs-onboarding` auto-opens on mount when its completion flag is
    // absent. Prepare the window targets only in that case, so returning users
    // are not yanked to the root node on every load.
    useEffect(() => {
      if (!ready) return;
      if (!preparedRef.current) {
        preparedRef.current = true;
        const flag = localStorage.getItem(TOUR_COMPLETION_KEY);
        if (flag === null || flag === '') prepareTargets();
      }

      // Let React commit the window overlay before the tour resolves target ids.
      let cancelled = false;
      const frame = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) setMounted(true);
        });
      });
      return () => {
        cancelled = true;
        cancelAnimationFrame(frame);
      };
    }, [ready, prepareTargets]);

    useImperativeHandle(
      ref,
      () => ({
        start: () => {
          prepareTargets();
          setMounted(true);
          // Clears the completion flag and opens the mounted tour at step 1.
          Onboarding.reset();
        },
      }),
      [prepareTargets],
    );

    if (!mounted) return null;

    return (
      <Onboarding name={TOUR_NAME}>
        {TOUR_STEPS.map((step) => (
          <OnboardingItem
            key={step.targetId}
            elementID={step.targetId}
            message={step.message}
          />
        ))}
      </Onboarding>
    );
  },
);
