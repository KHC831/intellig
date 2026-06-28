/**
 * Generation-counter guard for concurrent async graph loads.
 *
 * When the user switches repos or changes a filter quickly, multiple graph
 * loads can be in-flight at once. Each load captures its generation at
 * start-time via `bump()`; before calling `updateLogState` it checks
 * `isCurrent()` to discard its result if a newer load has since started.
 * This prevents a slow, older load from overwriting the result of a faster,
 * newer one.
 *
 * One guard instance is shared by all loaders in the registerViews closure
 * (single-repo + merged multi-repo) so any load correctly invalidates the
 * others.
 */

export interface IStalenessGuard {
  /**
   * Increment the generation counter and return the new number. Call this
   * at the START of each load to mark it as the current generation.
   */
  bump(): number;
  /**
   * Returns `true` iff no newer load has started since `generation` was
   * captured. Returns `false` (stale) if a later `bump()` has run.
   */
  isCurrent(generation: number): boolean;
}

export function createStalenessGuard(): IStalenessGuard {
  let current = 0;
  return {
    bump(): number {
      return ++current;
    },
    isCurrent(generation: number): boolean {
      return generation === current;
    },
  };
}
