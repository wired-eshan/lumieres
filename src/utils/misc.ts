export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Trailing-edge debounce. `flush()` runs the pending call immediately. */
export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs: number,
): { (...args: A): void; flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const wrapped = (...args: A) => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args2 = lastArgs;
      lastArgs = null;
      if (args2) fn(...args2);
    }, waitMs);
  };

  wrapped.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };

  wrapped.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  return wrapped;
}

/** Formats a byte-ish character count for display: 1234 -> "1,234". */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
