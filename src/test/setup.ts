/**
 * Test environment shims.
 *
 * Node 25 defines a global `localStorage` that requires `--localstorage-file`
 * to be usable. Under Vitest's jsdom environment that stub is copied onto the
 * jsdom window as an own property, shadowing jsdom's real implementation and
 * leaving `setItem` undefined. Browsers are unaffected, but the persistence
 * tests need a working Storage, so we install a minimal in-memory one when the
 * environment's is not functional.
 */

import { TOUR_COMPLETION_KEY } from '../onboarding/tourConfig';

const STORAGE_METHODS = ['setItem', 'getItem', 'removeItem', 'clear', 'key'] as const;

function isFunctional(candidate: unknown): boolean {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    STORAGE_METHODS.every(
      (method) => typeof (candidate as Record<string, unknown>)[method] === 'function',
    )
  );
}

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(String(key), String(value)),
  };
}

/**
 * React only batches state updates inside `act` when it knows it is in a test
 * environment; without this flag every `act` call logs a warning.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom implements `getContext` as a "not implemented" error. Returning null is
 * the same value callers see in a browser without 2D support, and it is exactly
 * what the renderer and minimap already guard against — so the shim keeps test
 * output readable without changing any behaviour under test.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
}

/**
 * jsdom implements `scrollTo` only as a "not implemented" error. The onboarding
 * tour's scroll lock restores scroll position on close, which is harmless in
 * tests but would otherwise print an error on every unmount.
 */
if (typeof window !== 'undefined') {
  window.scrollTo = () => undefined;
}

/** jsdom has no ResizeObserver, which the canvas uses to track its own size. */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

/**
 * jsdom has no PointerEvent. The resize handle is driven by pointer events, so
 * provide a minimal MouseEvent-derived implementation and harmless pointer
 * capture methods. Only tests that dispatch a pointer sequence need these.
 */
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  Object.defineProperty(window, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'PointerEvent', {
    value: PointerEventPolyfill,
    configurable: true,
    writable: true,
  });
}

if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
}

if (typeof window !== 'undefined' && !isFunctional(window.localStorage)) {
  Object.defineProperty(window, 'localStorage', {
    value: createMemoryStorage(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    value: window.localStorage,
    configurable: true,
    writable: true,
  });
}

/**
 * The product tour auto-opens on first visit. Mark it complete by default so
 * existing shell/integration tests are not covered by its modal overlay;
 * `ProductTour.test.tsx` clears the flag when it exercises the tour itself.
 */
if (typeof window !== 'undefined') {
  window.localStorage.setItem(TOUR_COMPLETION_KEY, 'true');
}
