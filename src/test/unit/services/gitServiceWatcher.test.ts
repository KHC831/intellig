/**
 * Regression tests for task #78 — GitService refresh infinite loop.
 *
 * The previous implementation installed a single `**\/*` file watcher on the
 * `.git/` directory and unconditionally reloaded the repository on every
 * `onDidChange` / `onDidCreate` / `onDidDelete`. Because `loadRepository`
 * invokes several `git` subprocesses (`status`, `log`, `rev-parse`, …)
 * that each write to `.git/index`, `.git/logs/**`, `.git/objects/**`, etc.,
 * the watcher's own activity re-fired itself in an unbounded loop.
 *
 * The fix (see `GitService.setupRepositoryWatcher`):
 *   1. Narrow the watched patterns to a precise allow-list that excludes
 *      `objects/**` and `logs/**`.
 *   2. Debounce bursts of watcher events by 250 ms before reloading.
 *   3. Guard against self-triggered reloads: if a reload is still in flight
 *      when the debounce fires, chain onto that promise and re-debounce.
 *
 * These tests verify each leg of the fix independently.
 */

import * as assert from 'assert';
import { GitService } from '../../../services/GitService';
import { Uri, getCreatedFileSystemWatchers, RelativePattern } from '../../mocks/vscode';

/**
 * Deterministic fake-timer shim. Replaces the global `setTimeout` and
 * `clearTimeout` while a test runs so `tick()` can advance time without
 * real delays. Scoped per-test via `uninstall()`.
 *
 * Intentionally minimal: we need `setTimeout(cb, ms)` + `clearTimeout(h)`
 * only; the GitService debounce uses no intervals or `Date.now()`.
 */
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

/** Flush pending microtasks — used after `tick()` so async reload chains settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * GitCli stub that counts invocations and lets the test inject custom
 * results per-command-prefix. No subprocess is ever spawned.
 */
class StubGitCli {
  public readonly calls: { args: string[] }[] = [];
  public readonly prefixResults: Map<string, { exitCode: number; stdout: string; stderr: string }> =
    new Map();

  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.calls.push({ args });
    const key = args.join(' ');
    for (const [prefix, result] of this.prefixResults) {
      if (key.startsWith(prefix)) {
        return { ...result, combined: result.stdout + result.stderr };
      }
    }
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  get onCommandExecuted(): () => { dispose: () => void } {
    return (): { dispose: () => void } => ({ dispose: (): void => {} });
  }

  dispose(): void {
    // no-op to match GitCli.dispose() so GitService.dispose() doesn't crash.
  }
}

/**
 * Test-only surface on `GitService` for the watcher-regression suite.
 *
 * Reaches through the `private` boundary to:
 *   - swap `_gitCli` for a scripted stub so reloads don't spawn git,
 *   - replace `loadRepository` with a counter + hold/release latch,
 *   - call `setupRepositoryWatcher` directly (the production entry point
 *     runs it as part of `loadRepository`, which we've already replaced).
 *
 * See `docs/testing.md` §3 for the TestSurface convention.
 */
interface GitServiceWatcherTestSurface {
  _gitCli: StubGitCli;
  loadRepository: (root: string) => Promise<unknown>;
  setupRepositoryWatcher: (root: string) => void;
}

/**
 * Install `stubCli` and a stubbed `loadRepository` on `service`, then
 * call the private `setupRepositoryWatcher` directly. Returns a counter
 * that increments every time `loadRepository` fires.
 */
function wireWatcher(
  service: GitService,
  stubCli: StubGitCli,
  rootPath: string
): { loadCount: () => number; resolveLoad: () => void; holdNextLoad: () => void } {
  const surface = service as unknown as GitServiceWatcherTestSurface;
  surface._gitCli = stubCli;

  let count = 0;
  let hold = false;
  let release: (() => void) | null = null;

  surface.loadRepository = async (_root: string): Promise<unknown> => {
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
    };
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

describe('GitService — .git file watcher (task #78 regression)', () => {
  const rootPath = '/tmp/repo-watcher-test';

  let gitService: GitService;
  let stubCli: StubGitCli;
  let timers: { tick: (ms: number) => void; uninstall: () => void };
  let baselineWatcherCount: number;

  beforeEach(() => {
    stubCli = new StubGitCli();
    gitService = new GitService();
    timers = installFakeTimers();
    // Snapshot the registry count BEFORE we wire up the test fixture so
    // that `getFreshWatchers()` only returns watchers this test creates.
    // Previous test suites may leave disposed-but-not-unhooked watchers in
    // the shared mock registry; we don't assume cross-file isolation here.
    baselineWatcherCount = getCreatedFileSystemWatchers().length;
  });

  afterEach(() => {
    timers.uninstall();
    gitService.dispose();
  });

  /** Watchers created during the current test, in creation order. */
  function getFreshWatchers(): ReturnType<typeof getCreatedFileSystemWatchers> {
    return getCreatedFileSystemWatchers().slice(baselineWatcherCount);
  }

  describe('pattern narrowing', () => {
    it('installs a watcher per narrow pattern and NEVER subscribes to objects/** or logs/**', () => {
      wireWatcher(gitService, stubCli, rootPath);
      const watchers = getFreshWatchers();

      // Each watcher's `_pattern` is the RelativePattern we passed in.
      const patterns = watchers.map((w) =>
        w._pattern instanceof RelativePattern ? w._pattern.pattern : String(w._pattern)
      );

      // Positive invariants — we must be able to react to branch/ref/index changes.
      assert.ok(patterns.includes('HEAD'), 'should watch HEAD for branch switches');
      assert.ok(patterns.includes('index'), 'should watch index for staging changes');
      assert.ok(patterns.includes('refs/**'), 'should watch refs/** for branch/tag updates');
      assert.ok(patterns.includes('packed-refs'), 'should watch packed-refs');

      // In-progress operation markers.
      assert.ok(patterns.includes('MERGE_HEAD'), 'should watch MERGE_HEAD');
      assert.ok(patterns.includes('CHERRY_PICK_HEAD'), 'should watch CHERRY_PICK_HEAD');
      assert.ok(patterns.includes('REVERT_HEAD'), 'should watch REVERT_HEAD');
      assert.ok(patterns.includes('rebase-merge/**'), 'should watch rebase-merge/**');
      assert.ok(patterns.includes('rebase-apply/**'), 'should watch rebase-apply/**');

      // Negative invariants — loop-causing paths must NOT be watched.
      for (const p of patterns) {
        assert.ok(
          !p.startsWith('objects'),
          `pattern ${JSON.stringify(p)} would trigger the refresh loop via objects/**`
        );
        assert.ok(
          !p.startsWith('logs'),
          `pattern ${JSON.stringify(p)} would trigger the refresh loop via logs/**`
        );
        assert.notStrictEqual(
          p,
          '**/*',
          'the broad `**/*` pattern was the root cause of the refresh loop'
        );
      }
    });
  });

  describe('debounce', () => {
    it('coalesces 100 synthetic events into at most one loadRepository call', async () => {
      const probe = wireWatcher(gitService, stubCli, rootPath);
      const watchers = getFreshWatchers();
      const headWatcher = watchers.find(
        (w) => w._pattern instanceof RelativePattern && w._pattern.pattern === 'HEAD'
      );
      assert.ok(headWatcher, 'HEAD watcher must exist');

      // Fire 100 events synchronously — simulates a git operation writing
      // HEAD, index, refs/heads/main in rapid succession.
      for (let i = 0; i < 100; i++) {
        headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
      }
      // No time has passed yet — nothing should have fired.
      assert.strictEqual(probe.loadCount(), 0, 'nothing fires before debounce elapses');

      // Advance past the debounce window.
      timers.tick(250);
      await flushMicrotasks();

      // Exactly one reload — the trailing-edge of the debounced burst.
      assert.strictEqual(probe.loadCount(), 1, '100 events must coalesce into exactly one reload');
    });

    it('fires exactly one reload after a single refs/heads/main change', async () => {
      const probe = wireWatcher(gitService, stubCli, rootPath);
      const watchers = getFreshWatchers();
      const refsWatcher = watchers.find(
        (w) => w._pattern instanceof RelativePattern && w._pattern.pattern === 'refs/**'
      );
      assert.ok(refsWatcher, 'refs/** watcher must exist');

      refsWatcher._fireChange(Uri.file(`${rootPath}/.git/refs/heads/main`));
      assert.strictEqual(probe.loadCount(), 0, 'no synchronous reload');

      timers.tick(GitService__DEBOUNCE_MS());
      await flushMicrotasks();

      assert.strictEqual(probe.loadCount(), 1);
    });
  });

  describe('dispose-during-reload guard (task #98 F1)', () => {
    it('does not reload after dispose, even if a reload is in flight', async () => {
      const probe = wireWatcher(gitService, stubCli, rootPath);
      const watchers = getFreshWatchers();
      const headWatcher = watchers.find(
        (w) => w._pattern instanceof RelativePattern && w._pattern.pattern === 'HEAD'
      );
      assert.ok(headWatcher);

      // Subscribe a counter to onDidChangeRepository so we can assert that
      // the emitter never fires for any post-dispose reload attempt (F6
      // defense-in-depth — the fire is post-gate, so the pre-F1 code also
      // would not have fired here; the assertion makes the invariant
      // explicit against future regressions).
      let fireCount = 0;
      const fireSub = gitService.onDidChangeRepository(() => fireCount++);

      // First event → debounce elapses → reload starts but is held.
      probe.holdNextLoad();
      headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
      timers.tick(250);
      await flushMicrotasks();
      assert.strictEqual(probe.loadCount(), 1, 'first reload has started and is held');

      // Queue a trailing-edge event so the `.finally(() => handleChange())`
      // chain has something to re-debounce once the held reload resolves —
      // this is the exact shape that used to leak an untracked 250 ms timer
      // onto a disposed service when a window reload landed mid-fetch.
      for (let i = 0; i < 5; i++) {
        headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
      }
      timers.tick(250);
      await flushMicrotasks();
      assert.strictEqual(
        probe.loadCount(),
        1,
        'trailing-edge events are deferred behind the in-flight reload'
      );

      // Simulate window reload: dispose the service WHILE the original
      // loadRepository is still held.
      gitService.dispose();

      // Now release the held reload. Its `.finally(() => handleChange())`
      // chain must see `_disposed === true` and bail — no fresh 250 ms
      // timer, no second loadRepository, no git spawn, no emitter.fire()
      // on the disposed EventEmitter.
      probe.resolveLoad();
      await flushMicrotasks();

      // Advance past any timer the pre-fix code would have scheduled.
      timers.tick(250);
      await flushMicrotasks();
      timers.tick(250);
      await flushMicrotasks();

      assert.strictEqual(
        probe.loadCount(),
        1,
        'no post-dispose reload — the chained handleChange must bail on _disposed'
      );
      assert.strictEqual(fireCount, 0, 'no post-dispose fire');
      fireSub.dispose();
    });
  });

  describe('in-flight guard', () => {
    it('does not start a second reload while one is still running', async () => {
      const probe = wireWatcher(gitService, stubCli, rootPath);
      const watchers = getFreshWatchers();
      const headWatcher = watchers.find(
        (w) => w._pattern instanceof RelativePattern && w._pattern.pattern === 'HEAD'
      );
      assert.ok(headWatcher);

      // First event → debounce elapses → reload starts but is held.
      probe.holdNextLoad();
      headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
      timers.tick(250);
      await flushMicrotasks();
      assert.strictEqual(probe.loadCount(), 1, 'first reload has started');

      // A flurry of events arrives while the first reload is still running.
      for (let i = 0; i < 50; i++) {
        headWatcher._fireChange(Uri.file(`${rootPath}/.git/HEAD`));
      }
      // Advance the debounce — the handler should see the in-flight reload
      // and defer rather than spawning a concurrent one.
      timers.tick(250);
      await flushMicrotasks();
      assert.strictEqual(
        probe.loadCount(),
        1,
        'no second reload while the first is still in flight'
      );

      // Release the in-flight reload. The trailing-edge event re-debounces.
      probe.resolveLoad();
      await flushMicrotasks();

      // The trailing-edge is a fresh debounce timer — advance again.
      timers.tick(250);
      await flushMicrotasks();
      assert.strictEqual(
        probe.loadCount(),
        2,
        'trailing-edge event reloads once after the first settles'
      );
    });
  });
});

/**
 * Access the private debounce constant for use in assertions. Kept as a
 * function so the tests don't import a symbol that isn't part of the
 * public API.
 */
function GitService__DEBOUNCE_MS(): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  return (GitService as any).WATCHER_DEBOUNCE_MS as number;
}
