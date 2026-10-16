/**
 * DOM binding for canvas interaction.
 *
 * Translates raw pointer/wheel events into gesture calls on the engine. All
 * gesture *decisions* live in the engine; this module only knows about DOM
 * details — pointer capture, coordinate mapping, and the rule that events
 * originating inside an HTML overlay (the open editor) never start a canvas
 * gesture, so text selection always wins over canvas dragging.
 */

import type { CanvasEngine } from './engine';
import type { Point } from '../graph/types';

export interface InteractionHandle {
  setPanModifier(held: boolean): void;
  isPanModifierHeld(): boolean;
  detach(): void;
}

export function attachInteractions(container: HTMLElement, engine: CanvasEngine): InteractionHandle {
  let panHeld = false;
  let activePointerId: number | null = null;

  const toLocal = (event: PointerEvent | WheelEvent | MouseEvent): Point => {
    const rect = container.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** True when the event started inside an HTML overlay rather than the canvas. */
  const isOverlayTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof Element)) return false;
    return target.closest('[data-overlay="true"]') !== null;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (isOverlayTarget(event.target)) return;
    const local = toLocal(event);
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;

    engine.pointerDown(local, {
      button: event.button,
      panModifier: panHeld || event.button === 1,
      additive,
      editingLocked: false,
    });

    if (engine.isGestureActive()) {
      activePointerId = event.pointerId;
      try {
        container.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is a nicety; gestures still work without it.
      }
      event.preventDefault();
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    const local = toLocal(event);
    engine.pointerMove(local);
    engine.refreshCursor();
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    activePointerId = null;
    try {
      container.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    engine.pointerUp();
  };

  const onPointerLeave = (): void => {
    if (engine.isGestureActive()) return;
    engine.pointerMove({ x: -1e5, y: -1e5 });
  };

  const onWheel = (event: WheelEvent): void => {
    // Never hijack scrolling inside the editor or floating controls.
    if (isOverlayTarget(event.target)) return;
    event.preventDefault();

    const local = toLocal(event);
    const zoomIntent = event.ctrlKey || event.metaKey;
    let deltaX = event.deltaX;
    let deltaY = event.deltaY;
    if (event.deltaMode === 1) {
      deltaX *= 16;
      deltaY *= 16;
    } else if (event.deltaMode === 2) {
      deltaX *= container.clientWidth;
      deltaY *= container.clientHeight;
    }
    engine.wheel(deltaX, deltaY, local, zoomIntent);
  };

  const onDoubleClick = (event: MouseEvent): void => {
    if (isOverlayTarget(event.target)) return;
    const id = engine.hitTest(toLocal(event));
    if (id) engine.startEditing(id);
  };

  const onContextMenu = (event: MouseEvent): void => {
    // A right-click on empty canvas clears the selection instead of opening the
    // browser menu; inside a window or overlay the native menu is left alone.
    if (isOverlayTarget(event.target)) return;
    if (engine.hitTest(toLocal(event))) return;
    event.preventDefault();
    engine.clearSelection();
  };

  container.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  container.addEventListener('pointerleave', onPointerLeave);
  container.addEventListener('wheel', onWheel, { passive: false });
  container.addEventListener('dblclick', onDoubleClick);
  container.addEventListener('contextmenu', onContextMenu);

  return {
    setPanModifier: (held: boolean) => {
      panHeld = held;
      container.dataset.panHeld = held ? 'true' : 'false';
    },
    isPanModifierHeld: () => panHeld,
    detach: () => {
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      container.removeEventListener('pointerleave', onPointerLeave);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('dblclick', onDoubleClick);
      container.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
