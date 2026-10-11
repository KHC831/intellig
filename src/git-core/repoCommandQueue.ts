/**
 * Layer 1.5 — a per-repository serializer for index-mutating git commands.
 *
 * A git repository's index is a single resource guarded by `.git/index.lock`;
 * two commands that write it concurrently collide ("Unable to create
 * index.lock"). The conflict accept paths are invoked fire-and-forget from the
 * webview (different rows) and from the palette (bulk), so without ordering they
 * race. `withLock` chains every index mutation for a given repo root onto one
 * promise so they run strictly one at a time. Reads need not acquire it.
 *
 * The chain is keyed by repo root, so unrelated repos run in parallel. A failing
 * op does not poison the queue — the next op runs after it settles either way,
 * and the caller still observes the op's own resolution/rejection.
 */
export class RepoCommandQueue {
  // in-flight-map-exempt: a serial queue's tail, never handed out as a result
  private readonly _tails = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` after every previously-enqueued op for `repoRoot` has settled,
   * serializing index writes for that repo. Returns `fn`'s result (or rejection).
   */
  async withLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
    const previous = this._tails.get(repoRoot) ?? Promise.resolve();
    // Wait for the previous op to SETTLE (ignore its outcome), then run fn.
    const run = previous.then(
      () => fn(),
      () => fn()
    );
    // Keep the tail alive but swallow rejections so one failure can't break the
    // chain for subsequent ops.
    this._tails.set(
      repoRoot,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }
}
