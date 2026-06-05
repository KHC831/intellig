/**
 * Unit tests for `createCoalescedLoader` — the single-flight + trailing-edge
 * coalesce wrapper around `loadAllPanelData`.
 *
 * Why it exists: many mutation handlers fire BOTH
 * `reloadRepository` (which fires `onDidChangeRepository`) AND
 * `provider.refresh()` (which fires `onDidRequestRefresh`). Both
 * events are wired to `loadAllPanelData` in `activate`, producing
 * two un-debounced `git log` invocations in parallel. Post-squash,
 * fresh committerDate values can give the two fetches slightly
 * different orderings; whichever finishes last wins, producing the
 * "linear after squash" / flicker symptoms users have reported.
 *
 * Contract being pinned:
 *  - First trigger call: starts the load immediately.
 *  - N concurrent calls during the in-flight window: collapse into
 *    AT MOST one trailing-edge re-fire (not N — that would defeat
 *    the purpose).
 *  - Trailing-edge re-fire runs AFTER the current load resolves.
 *  - Errors in `load()` are swallowed — the trigger is fire-and-forget.
 *  - After both loads finish and there's no further pending work,
 *    the next trigger call starts a fresh load (no stuck state).
 */

import '../../setup';
import * as assert from 'assert';
import { createCoalescedLoader } from '../../../extension';

/**
 * Build a controllable async function. Returns the trigger plus a
 * controller object so tests can resolve / reject the in-flight
 * promise on demand.
 */
function makeControlledLoader(): {
  loadCallCount: number;
  trigger: () => void;
  resolveCurrent: () => void;
  rejectCurrent: (err: Error) => void;
  pendingCount: number;
} {
  const state = {
    loadCallCount: 0,
    pendingCount: 0,
    pendingResolve: undefined as (() => void) | undefined,
    pendingReject: undefined as ((err: Error) => void) | undefined,
  };
  const load = (): Promise<void> => {
    state.loadCallCount += 1;
    state.pendingCount += 1;
    return new Promise<void>((resolve, reject) => {
      state.pendingResolve = resolve;
      state.pendingReject = reject;
    });
  };
  const trigger = createCoalescedLoader(load);
  return {
    get loadCallCount() {
      return state.loadCallCount;
    },
    get pendingCount() {
      return state.pendingCount;
    },
    trigger,
    resolveCurrent: () => {
      const resolve = state.pendingResolve;
      assert.ok(resolve, 'expected an in-flight load to resolve');
      state.pendingResolve = undefined;
      state.pendingReject = undefined;
      state.pendingCount -= 1;
      resolve();
    },
    rejectCurrent: (err: Error) => {
      const reject = state.pendingReject;
      assert.ok(reject, 'expected an in-flight load to reject');
      state.pendingResolve = undefined;
      state.pendingReject = undefined;
      state.pendingCount -= 1;
      reject(err);
    },
  };
}

/**
 * Yield the microtask queue. The coalesce machinery runs in async
 * continuations, so tests need to flush microtasks between
 * trigger / resolve / re-fire.
 */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

describe('createCoalescedLoader', () => {
  it('first trigger call starts the load immediately', async () => {
    const harness = makeControlledLoader();
    assert.strictEqual(harness.loadCallCount, 0);

    harness.trigger();
    // The trigger calls load() synchronously inside the IIFE.
    assert.strictEqual(harness.loadCallCount, 1);
    harness.resolveCurrent();
    await flushMicrotasks();
  });

  it('collapses multiple concurrent triggers into a single trailing-edge re-fire', async () => {
    // The "post-squash double-fire" scenario: reloadRepository fires
    // onDidChangeRepository AND provider.refresh() fires
    // onDidRequestRefresh, both within the same tick. Without the
    // coalesce, that's 2 git log invocations. With it, that's 1
    // active load + 1 pending re-fire — still 2 loads total, but
    // serialized so the second one always sees the post-mutation
    // state.
    const harness = makeControlledLoader();

    harness.trigger();
    assert.strictEqual(harness.loadCallCount, 1, 'load 1 starts immediately');

    // Fire several more triggers during the in-flight window.
    harness.trigger();
    harness.trigger();
    harness.trigger();
    assert.strictEqual(
      harness.loadCallCount,
      1,
      'concurrent triggers must NOT spawn parallel loads'
    );

    // Resolve the in-flight load. The trailing-edge re-fire kicks in.
    harness.resolveCurrent();
    await flushMicrotasks();
    await flushMicrotasks(); // re-fire is one microtask deep

    assert.strictEqual(
      harness.loadCallCount,
      2,
      'exactly ONE trailing-edge re-fire — N concurrent triggers must collapse to 1, not N'
    );
    harness.resolveCurrent();
    await flushMicrotasks();
  });

  it('after a load + trailing-edge re-fire both settle, the next trigger starts fresh', async () => {
    // This is the "no stuck state" guarantee. If pending wasn't
    // cleared after the trailing-edge re-fire, a future trigger
    // would silently chain forever.
    const harness = makeControlledLoader();

    harness.trigger();
    harness.trigger(); // queues trailing-edge
    harness.resolveCurrent();
    await flushMicrotasks();
    await flushMicrotasks();
    harness.resolveCurrent(); // settle the trailing-edge load
    await flushMicrotasks();
    assert.strictEqual(harness.loadCallCount, 2);
    assert.strictEqual(harness.pendingCount, 0, 'no in-flight load remains');

    // Fresh trigger — should start a NEW load, not be a no-op.
    harness.trigger();
    assert.strictEqual(harness.loadCallCount, 3, 'next trigger must start a fresh load');
    harness.resolveCurrent();
    await flushMicrotasks();
  });

  it('a rejected load does not strand the trigger — subsequent triggers still work', async () => {
    // Errors thrown by `load()` must NOT poison the coalesce. If the
    // catch was missing, an in-flight rejection would propagate up
    // through the IIFE and `inFlight` would never be cleared,
    // blocking every future trigger.
    const harness = makeControlledLoader();

    harness.trigger();
    assert.strictEqual(harness.loadCallCount, 1);
    harness.rejectCurrent(new Error('git log timed out'));
    await flushMicrotasks();
    await flushMicrotasks();

    // Should be back to clean state — next trigger starts fresh.
    harness.trigger();
    assert.strictEqual(
      harness.loadCallCount,
      2,
      'a rejected load must not strand the coalesce; next trigger must run'
    );
    harness.resolveCurrent();
    await flushMicrotasks();
  });

  it('rejected in-flight load still honors the trailing-edge re-fire', async () => {
    // Even if the first load fails, a trigger that arrived during
    // the in-flight window must still re-fire — the failure may be
    // transient (lock file, file watcher hiccup), and we don't want
    // to drop the user's request silently.
    const harness = makeControlledLoader();

    harness.trigger();
    harness.trigger(); // queues trailing-edge
    harness.rejectCurrent(new Error('transient'));
    await flushMicrotasks();
    await flushMicrotasks();

    assert.strictEqual(
      harness.loadCallCount,
      2,
      'trailing-edge re-fire must still happen even if the in-flight load rejected'
    );
    harness.resolveCurrent();
    await flushMicrotasks();
  });
});
