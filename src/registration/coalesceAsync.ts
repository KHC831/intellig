/**
 * Wrap an idempotent async task so concurrent invocations share a single run,
 * with one trailing re-run if any invocation arrived while a run was in flight.
 *
 * The Git tool window's `loadAllPanelData` is triggered by three events that all
 * fire within the same activation tick — `onDidRequestInitialData` (webview
 * ready), `onDidRequestRefresh`, and `onDidChangeRepository` (repo discovered).
 * Unwrapped, that launches three concurrent graph loads, i.e. three CPU-bound
 * `git log --topo-order` walks racing for the CPU; on a large repo with no
 * commit-graph each ~2s walk stretches to ~5s under the contention, so the
 * graph's first paint lands at ~6s instead of ~2s.
 *
 * Coalescing collapses that burst to ONE run (the redundant triggers await it
 * instead of starting their own), so the first load runs uncontended and paints
 * fast. The single trailing re-run preserves correctness: a genuine repository
 * change that arrives mid-load is not dropped — exactly one fresh reload follows.
 * The trailing run is fire-and-forget so it never delays the caller that started
 * the first run.
 */
export function createCoalescedRunner(task: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let pending = false;

  const run = (): Promise<void> => {
    const current = inFlight;
    if (current) {
      // A run is already underway; remember that a fresh one was requested and
      // share the in-flight promise rather than launching a competing walk.
      pending = true;
      return current;
    }
    const started = task().finally(() => {
      inFlight = undefined;
      if (pending) {
        pending = false;
        void run();
      }
    });
    inFlight = started;
    return started;
  };

  return run;
}
