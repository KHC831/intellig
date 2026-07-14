/**
 * Working-tree STATUS lane scheduler.
 *
 * A working-tree file event can only change file statuses — never refs,
 * commits, or the log — so its refresh response must be cheap and heavily
 * coalesced. This is a port of the VS Code git extension's policy for the
 * same events (extensions/git/src/repository.ts: `onFileChange` →
 * `@debounce(1000)` → wait until idle AND focused → `status()` →
 * `timeout(5000)`):
 *
 *   - trailing-edge debounce: a burst of events schedules one run after the
 *     stream pauses;
 *   - focus gate: nothing runs while the window is unfocused — the pending
 *     run waits for focus to return, and the backlog stays coalesced;
 *   - hard floor between runs: a sustained storm (a build writing output)
 *     costs at most one run of the injected refresh per floor window (in
 *     GitService that refresh is the repo-state reload — the win is the
 *     scheduling and the event routing, not a cheaper git call);
 *   - trailing coalesce: events landing during a run or its floor collapse
 *     into exactly one follow-up run.
 *
 * Pure state machine: timings, focus signal, and the refresh itself are
 * injected, so GitService owns the vscode wiring and this file owns the
 * scheduling contract.
 */

import { getLogger } from '../utils/logger';

export interface IStatusLaneDeps {
  /** Trailing-edge debounce for incoming events (VS Code uses 1000ms). */
  debounceMs: number;
  /** Minimum spacing between two runs (VS Code uses 5000ms). */
  floorMs: number;
  /** Whether the window currently has focus. */
  isFocused(): boolean;
  /** Subscribe to "focus regained"; returns a disposable. */
  onDidFocus(listener: () => void): { dispose(): void };
  /** The refresh to run. A rejection is warn-logged by the lane and never
   * wedges the schedule; the next event retries. */
  run(): Promise<void>;
}

export interface IStatusLane {
  /** Report a working-tree event. */
  poke(): void;
  /** Cancel everything pending; in-flight runs finish but schedule nothing. */
  dispose(): void;
}

export function createStatusLane(deps: IStatusLaneDeps): IStatusLane {
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** A cycle is running (focus wait + run + floor). */
  let cycleInFlight = false;
  /** An event landed during the in-flight cycle — run once more after it. */
  let trailing = false;
  /** The cycle hasn't started its run yet (still waiting for focus): events
   * arriving now are covered by the upcoming run, which reads disk state at
   * run time — they must not schedule a redundant trailing run. */
  let absorbing = false;
  let focusSubscription: { dispose(): void } | undefined;
  /** Resolvers for in-cycle waits, so dispose() can release them. */
  let releaseFocusWait: (() => void) | undefined;
  let floorTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseFloorWait: (() => void) | undefined;

  const whenFocused = (): Promise<void> => {
    if (deps.isFocused()) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      releaseFocusWait = resolve;
      focusSubscription = deps.onDidFocus(() => {
        focusSubscription?.dispose();
        focusSubscription = undefined;
        releaseFocusWait = undefined;
        resolve();
      });
    });
  };

  const floorDelay = (): Promise<void> =>
    new Promise((resolve) => {
      releaseFloorWait = resolve;
      floorTimer = setTimeout(() => {
        floorTimer = undefined;
        releaseFloorWait = undefined;
        resolve();
      }, deps.floorMs);
    });

  const cycle = async (): Promise<void> => {
    cycleInFlight = true;
    try {
      do {
        trailing = false;
        absorbing = true;
        await whenFocused();
        absorbing = false;
        if (disposed) {
          return;
        }
        try {
          await deps.run();
        } catch (err) {
          // A failed refresh must not wedge the schedule; the next event
          // retries. Waypoint-logged here because the injected run isn't
          // obligated to surface its own faults.
          getLogger()
            .child({ component: 'statusLane' })
            .warn('status refresh failed', {
              error: err instanceof Error ? err.message : String(err),
            });
        }
        await floorDelay();
      } while (trailing && !disposed);
    } finally {
      cycleInFlight = false;
      absorbing = false;
    }
  };

  return {
    poke(): void {
      if (disposed) {
        return;
      }
      if (cycleInFlight) {
        // Events before the run starts are covered by it; everything that
        // lands during the run + floor becomes one trailing run.
        if (!absorbing) {
          trailing = true;
        }
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (disposed) {
          return;
        }
        void cycle();
      }, deps.debounceMs);
    },
    dispose(): void {
      disposed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (floorTimer) {
        clearTimeout(floorTimer);
        floorTimer = undefined;
      }
      focusSubscription?.dispose();
      focusSubscription = undefined;
      // Release any in-cycle wait so the cycle promise settles (its disposed
      // checks turn the remainder into a no-op).
      releaseFocusWait?.();
      releaseFocusWait = undefined;
      releaseFloorWait?.();
      releaseFloorWait = undefined;
    },
  };
}
