/**
 * Minimal fake-timer shim.
 *
 * Replaces `setTimeout` / `clearTimeout` on `globalThis` with a deterministic
 * queue driven by {@link installFakeTimers}`.tick()`. Scoped to the current
 * test; the `uninstall()` call restores the real timers so other tests
 * aren't affected.
 *
 * This is intentionally tiny — the debounce paths under test use
 * `setTimeout(..., ms)` and `clearTimeout` only. No interval, no
 * setImmediate, no Date.now() virtualisation. If a debounce ever grows those
 * dependencies, upgrade to `@sinonjs/fake-timers` rather than extending this
 * shim.
 */

interface IFakeTimerHandle {
  id: number;
  fireAt: number;
  callback: () => void;
}

export function installFakeTimers(): {
  tick: (ms: number) => void;
  uninstall: () => void;
} {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let now = 0;
  let nextId = 1;
  const queue: IFakeTimerHandle[] = [];

  (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => unknown }).setTimeout = (
    cb: () => void,
    ms: number
  ): unknown => {
    const handle: IFakeTimerHandle = { id: nextId++, fireAt: now + (ms ?? 0), callback: cb };
    queue.push(handle);
    // Return a numeric-coerceable stand-in so code that stores the return
    // value works regardless of whether it treats it as number or object.
    return handle.id as unknown;
  };

  (globalThis as unknown as { clearTimeout: (h: unknown) => void }).clearTimeout = (
    h: unknown
  ): void => {
    const id = typeof h === 'number' ? h : (h as IFakeTimerHandle | undefined)?.id;
    if (id === undefined) {
      return;
    }
    const idx = queue.findIndex((q) => q.id === id);
    if (idx >= 0) {
      queue.splice(idx, 1);
    }
  };

  return {
    tick: (ms: number): void => {
      now += ms;
      // Fire all timers whose deadline has passed, in insertion order.
      for (;;) {
        const due = queue.findIndex((q) => q.fireAt <= now);
        if (due < 0) {
          break;
        }
        const [handle] = queue.splice(due, 1);
        handle.callback();
      }
    },
    uninstall: (): void => {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
      (globalThis as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
        realClearTimeout;
      queue.length = 0;
    },
  };
}

/**
 * Flush the pending microtask queue. Needed between `tick()` and assertions
 * because a debounce callback typically launches an async chain; each `await`
 * inside that chain yields back to the microtask queue. Schedules a macrotask
 * via the real `setImmediate` to guarantee all microtasks drain.
 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}
