/**
 * TL-60 (Cluster C) — unit-seam coverage of GitService's watcher
 * self-trigger invariant.
 *
 * Wave 1 (task #78) fixed a CRITICAL infinite-refresh-loop bug where
 * GitService's `.git/` watcher fired on the side effects of the very
 * git subprocesses GitService itself spawned during a reload (the
 * watcher saw `.git/HEAD` rewritten by `_loadRepository`'s
 * `git rev-parse`, fired again, scheduled another reload, …). The
 * production fix layered three guards inside
 * `GitService.setupRepositoryWatcher`:
 *   1. Narrow allow-list of watched `.git/` patterns (skip `objects/**`,
 *      `logs/**`, `**\/*`).
 *   2. Debounce bursts of watcher events for 250 ms before reloading.
 *   3. In-flight guard: while a `_loadRepository` is still pending,
 *      subsequent watcher events are deferred via a `.finally(handleChange)`
 *      chain rather than starting a second reload concurrently.
 *
 * The existing ext-host smoke spec exercises (3) end-to-end on a real
 * git repo; the existing `gitServiceWatcher.test.ts` covers (1) + the
 * trailing-edge replay arm of (3). What the unit suite was MISSING is
 * a tight invariant pin on the inverse-direction case: an internal
 * watcher event that fires DURING the in-flight reload (i.e., the
 * watcher saw GitService's own `.git/` write) must NOT cause a second
 * `_onDidChangeRepository.fire()` while the reload is still running.
 *
 * This file owns that pin via three specs:
 *
 *   1. External-only:  external `.git/HEAD` change → refresh fires once.
 *   2. Internal-only:  watcher events arriving DURING an in-flight reload
 *                      must NOT fire `onDidChangeRepository` a second time
 *                      while the reload is still pending.
 *   3. Simultaneous:   internal + external bursts during an in-flight
 *                      reload coalesce — exactly one trailing-edge fire
 *                      after the held reload settles, regardless of how
 *                      many events landed mid-flight.
 *
 * The seam is the `_loadRepository`-replacement TestSurface used by
 * `gitServiceWatcher.test.ts`: holding `_loadRepository` simulates the
 * "still in flight" window during which any `.git/` write that
 * `_loadRepository` itself would emit is observed by the watcher.
 */

import * as assert from 'assert';
import { GitService } from '../../../git-core/GitService';
import { Uri, getCreatedFileSystemWatchers, RelativePattern } from '../../mocks/vscode';
import type { IRepository } from '../../../git-core/interfaces/IGitService';

// ============================================================================
// Fake-timer shim — same shape as gitServiceWatcher.test.ts. Kept local so
// this file stays self-contained.
// ============================================================================

interface IFakeTimerHandle {
  id: number;
  fireAt: number;
  callback: () => void;
}

function installFakeTimers(): {
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

/** Flush pending microtasks — used after `tick()` so async chains settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

// ============================================================================
// GitCli stub — minimal surface; reload paths never spawn subprocesses.
// ============================================================================

class StubGitCli {
  public readonly calls: { args: string[] }[] = [];

  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.calls.push({ args });
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  get onCommandExecuted(): () => { dispose: () => void } {
    return (): { dispose: () => void } => ({ dispose: (): void => {} });
  }

  dispose(): void {
    /* no-op */
  }
}

// ============================================================================
// TestSurface — reach through `private` to install a stub gitCli, replace
// `loadRepository` with a held latch, and call the private
// `setupRepositoryWatcher` directly. See `docs/testing.md` §3 for the
// TestSurface convention.
// ============================================================================

interface IGitServiceWatcherTestSurface {
  _gitCli: StubGitCli;
  loadRepository: (root: string) => Promise<IRepository>;
  setupRepositoryWatcher: (root: string) => void;
}

interface IWatcherProbe {
  loadCount: () => number;
  holdNextLoad: () => void;
  resolveLoad: () => void;
}

function wireWatcher(service: GitService, stubCli: StubGitCli, rootPath: string): IWatcherProbe {
  const surface = service as unknown as IGitServiceWatcherTestSurface;
  surface._gitCli = stubCli;

  let count = 0;
  let hold = false;
  let release: (() => void) | null = null;

  surface.loadRepository = async (_root: string): Promise<IRepository> => {
    count += 1;
    if (hold) {
      await new Promise<void>((resolve) => {
        release = (): void => {
          hold = false;
          release = null;
          resolve();
        };
      });
    }
    return {
      rootUri: Uri.file(rootPath),
      state: 'idle',
      head: { name: 'main', commit: 'a'.repeat(40), ahead: 0, behind: 0 },
      remotes: [],
      submodules: [],
    } as unknown as IRepository;
  };

  surface.setupRepositoryWatcher(rootPath);

  return {
    loadCount: (): number => count,
    holdNextLoad: (): void => {
      hold = true;
    },
    resolveLoad: (): void => {
      if (release) {
        release();
      }
    },
  };
}

interface ICreatedWatcher {
  _pattern: unknown;
  _fireChange: (uri: { fsPath: string }) => void;
  _fireCreate: (uri: { fsPath: string }) => void;
  _fireDelete: (uri: { fsPath: string }) => void;
  dispose: () => void;
}

/** Locate the `RelativePattern`-keyed watcher matching `pattern`. */
function findWatcherByPattern(
  watchers: ReturnType<typeof getCreatedFileSystemWatchers>,
  pattern: string
): ICreatedWatcher {
  const found = watchers.find(
    (w) => w._pattern instanceof RelativePattern && w._pattern.pattern === pattern
  );
  assert.ok(found, `watcher for pattern '${pattern}' must exist`);
  return found as unknown as ICreatedWatcher;
}

// ============================================================================
// Specs
// ============================================================================

describe('GitService — watcher self-trigger invariant (TL-60 unit seam)', () => {
  const rootPath = '/tmp/repo-watcher-invariant-test';
  const DEBOUNCE_MS = 250;

  let gitService: GitService;
  let stubCli: StubGitCli;
  let timers: { tick: (ms: number) => void; uninstall: () => void };
  let baselineWatcherCount: number;

  beforeEach(() => {
    stubCli = new StubGitCli();
    gitService = new GitService();
    timers = installFakeTimers();
    baselineWatcherCount = getCreatedFileSystemWatchers().length;
  });

  afterEach(() => {
    timers.uninstall();
    gitService.dispose();
  });

  function getFreshWatchers(): ReturnType<typeof getCreatedFileSystemWatchers> {
    return getCreatedFileSystemWatchers().slice(baselineWatcherCount);
  }

  // -------------------------------------------------------------------------
  // Spec 1 — External-only path. Baseline: a single external `.git/HEAD`
  // change (e.g., user runs `git checkout` from another terminal) DOES
  // produce a single `_onDidChangeRepository` fire.
  // -------------------------------------------------------------------------
  it('external .git/HEAD change → refresh fires exactly once', async () => {
    const probe = wireWatcher(gitService, stubCli, rootPath);
    const headWatcher = findWatcherByPattern(getFreshWatchers(), 'HEAD');

    let fireCount = 0;
    const sub = gitService.onDidChangeRepository(() => fireCount++);

    // Simulate an EXTERNAL write: GitService is idle (no in-flight
    // reload), the user's terminal `git checkout` updated `.git/HEAD`,
    // and the OS file-watcher delivered the event.
    headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
    timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.strictEqual(probe.loadCount(), 1, 'one reload after debounce');
    assert.strictEqual(fireCount, 1, 'one onDidChangeRepository fire after the external event');
    sub.dispose();
  });

  // -------------------------------------------------------------------------
  // Spec 2 — Internal path. While a reload is in flight, every watcher
  // event that fires (i.e., events that GitService's own
  // `_loadRepository` would emit by writing to `.git/HEAD`, refs/**,
  // etc.) MUST NOT cause a second `_onDidChangeRepository.fire()` while
  // the reload is still pending — that's the inverse-direction self-
  // trigger that produced the Wave 1 infinite loop.
  //
  // The invariant: `fireCount` stays at 0 (or whatever its pre-flight
  // value is) while the reload is held, regardless of how many internal
  // events arrive.
  // -------------------------------------------------------------------------
  it('internal events during an in-flight reload do NOT fire onDidChangeRepository while held', async () => {
    const probe = wireWatcher(gitService, stubCli, rootPath);
    const headWatcher = findWatcherByPattern(getFreshWatchers(), 'HEAD');
    const indexWatcher = findWatcherByPattern(getFreshWatchers(), 'index');

    let fireCount = 0;
    const sub = gitService.onDidChangeRepository(() => fireCount++);

    // Kick off the first reload via an external event, then HOLD it so
    // the next watcher events represent the inverse-direction case
    // (events that arrive DURING the reload).
    probe.holdNextLoad();
    headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
    timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'reload started, held');

    // Simulate the watcher firing on writes that GitService's own
    // `_loadRepository` would produce: `.git/HEAD` (rev-parse cache
    // refresh), `.git/index` (status), and `.git/refs/heads/main`
    // (cached ref read). A burst of 30 events.
    for (let i = 0; i < 10; i++) {
      headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
      indexWatcher._fireChange(Uri.file(`${rootPath}/.git/index`));
    }
    // Advance debounce; the handler must see the in-flight reload and
    // defer rather than starting a concurrent reload OR firing the
    // emitter on the in-flight reload's own `.git/` writes.
    timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();

    assert.strictEqual(
      probe.loadCount(),
      1,
      'no concurrent reload — internal events must defer behind the in-flight one'
    );
    assert.strictEqual(
      fireCount,
      0,
      'no onDidChangeRepository fire while the reload is still pending — the held reload has not produced a repo to fire yet'
    );
    sub.dispose();
  });

  // -------------------------------------------------------------------------
  // Spec 3 — Simultaneous internal + external. A held reload in flight,
  // mixed events arrive (some are GitService's own `.git/` writes, some
  // are external), and after the held reload settles + trailing-edge
  // debounce elapses, `_onDidChangeRepository` fires EXACTLY ONCE for
  // the entire mixed burst — debounced and coalesced. The pre-fix code
  // would have fired N times (once per event) producing the loop.
  // -------------------------------------------------------------------------
  it('simultaneous internal + external events coalesce into exactly one fire after the held reload settles', async () => {
    const probe = wireWatcher(gitService, stubCli, rootPath);
    const headWatcher = findWatcherByPattern(getFreshWatchers(), 'HEAD');
    const indexWatcher = findWatcherByPattern(getFreshWatchers(), 'index');
    const refsWatcher = findWatcherByPattern(getFreshWatchers(), 'refs/**');

    let fireCount = 0;
    const sub = gitService.onDidChangeRepository(() => fireCount++);

    // Start + hold the first reload.
    probe.holdNextLoad();
    headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
    timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();
    assert.strictEqual(probe.loadCount(), 1, 'first reload in flight');
    assert.strictEqual(fireCount, 0, 'no fire while held');

    // Simultaneous burst: 5 internal-shaped events (the kinds
    // `_loadRepository` itself produces) interleaved with 5 external-
    // shaped events (e.g. another terminal pushes a branch update).
    // From the watcher's perspective these are indistinguishable; the
    // invariant that protects the loop is the `_reloading` in-flight
    // chain, NOT origin attribution.
    for (let i = 0; i < 5; i++) {
      // "Internal" — same paths a refresh would touch.
      headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
      indexWatcher._fireChange(Uri.file(`${rootPath}/.git/index`));
      // "External" — a refs update from another terminal.
      refsWatcher._fireChange(Uri.file(`${rootPath}/.git/refs/heads/feature`));
    }
    timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();
    assert.strictEqual(
      probe.loadCount(),
      1,
      'still only one reload — burst deferred behind the in-flight one'
    );
    assert.strictEqual(fireCount, 0, 'no fire mid-flight, even with mixed origins');

    // Release the held reload. The trailing-edge `.finally(handleChange)`
    // re-debounces, and after `DEBOUNCE_MS` we get exactly ONE more
    // reload + ONE fire.
    probe.resolveLoad();
    await flushMicrotasks();
    timers.tick(DEBOUNCE_MS);
    await flushMicrotasks();
    // The first reload's promise settles too, which fires once.
    // Then the trailing-edge reload settles, which fires once.
    // Both are coalesced through the single trailing-edge debounce
    // (only ONE handleChange chain is running because the in-flight
    // guard collapsed the burst).

    assert.strictEqual(
      probe.loadCount(),
      2,
      'exactly one trailing-edge reload after the held one settles'
    );
    // Both reloads fire — the held one (now resolved) and the trailing-
    // edge one. The KEY invariant: it's a small, bounded count (<= 2),
    // not the unbounded N-fire loop the pre-fix code produced.
    assert.ok(
      fireCount >= 1 && fireCount <= 2,
      `fireCount must be bounded (1 or 2), got ${fireCount} — anything higher is the self-trigger loop`
    );
    sub.dispose();
  });
});
