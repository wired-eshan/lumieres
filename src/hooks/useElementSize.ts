import { useEffect, useRef, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
  dpr: number;
}

/**
 * Reports an element's content size and the device pixel ratio, coalescing
 * bursts of resize events into one animation frame.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, onChange: (size: ElementSize) => void): void {
  const callback = useRef(onChange);
  callback.current = onChange;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frame: number | null = null;

    const emit = () => {
      frame = null;
      const rect = element.getBoundingClientRect();
      callback.current({
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
        dpr: Math.min(3, Math.max(1, window.devicePixelRatio || 1)),
      });
    };

    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(emit);
    };

    emit();

    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ref]);
}
