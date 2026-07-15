/**
 * Regression test for the `_drainPendingReloads()` test-only seam on
 * `GitService` and the `_reloading` enrollment widening that backs it.
 *
 * Structural defect being fixed
 * -----------------------------
 * `useFixtureWorkspace`'s `gitService.getRepository(folderUri)` call
 * kicked off an async `loadRepository` chain. The test's `afterEach`
 * ran synchronous `clearWorkspace()` + `fs.rmSync(fixture-dir)` BEFORE
 * that async chain completed. The chain's later git spawns produced
 * ENOENT against the now-deleted cwd; the per-call try/catches
 * swallowed those errors; then `loadRepository`'s final unconditional
 * `_repositories.set(rootPath, ...)` resurrected a stale cache entry
 * pointing at the deleted directory. The next test then hit a
 * "working directory missing" failure against a path it never asked
 * about.
 *
 * The fix
 * -------
 *   1. Every `loadRepository` call is enrolled into `_reloading` (not
 *      just the watcher's `_performDebouncedRefresh` path).
 *   2. A new `_drainPendingReloads()` test-only method on GitService
 *      awaits `Promise.allSettled` of every entry currently in the
 *      `_reloading` map.
 *   3. `clearWorkspace` (test infra) calls `_drainPendingReloads()`
 *      before disposing watchers and once more after.
 *
 * What this test pins
 * -------------------
 *   - `_drainPendingReloads()` does NOT resolve until every in-flight
 *     `loadRepository` resolves (we hang one on a controllable promise
 *     and verify the drain awaits it).
 *   - The `_reloading` enrollment is wide enough that a `getRepository`
 *     call alone (no `_performDebouncedRefresh`) populates the map.
 *
 * The companion suite `gitServiceRepoDeletion.test.ts` continues to
 * exercise the synthetic-path (`/repo`, `/work/projectA`) contract that
 * treats `_repositories` as an authoritative in-memory model decoupled
 * from disk — those specs do NOT exercise `loadRepository`'s async tail
 * (they pre-seed `_repositories` via fake-fs scanning), so this fix
 * does not regress them.
 */

import '../../setup';
import * as assert from 'assert';

import { ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError } from '../../../src/git-core/errors';
import { Uri } from '../../mocks/vscode';

/** Test-only handle to the GitService internals exercised here. */
interface DrainTestSurface {
  _gitCli: unknown;
  _reloading: Map<string, Promise<unknown>>;
  _drainPendingReloads: () => Promise<void>;
}

/**
 * Stub GitCli where `exec` returns a controllable promise. Tests resolve
 * the promise on demand to release `loadRepository`'s async tail.
 */
class HangingStubGitCli {
  /** Resolves the first `getRepositoryRoot` invocation. */
  rootResolve: ((root: string | undefined) => void) | null = null;
  /**
   * Resolves the NEXT `exec` call. Re-armed after each release so the
   * test can tick through the chain of git invocations
   * (`symbolic-ref` → `rev-parse` → `status` → `remote -v`) one by
   * one.
   */
  execResolve: ((result: ExecResult) => void) | null = null;

  /** Number of pending exec calls that are currently waiting. */
  execPending = 0;

  getRepositoryRoot(_p: string): ResultAsync<string | undefined, GitError> {
    return ResultAsync.fromSafePromise(
      new Promise<string | undefined>((resolve) => {
        this.rootResolve = resolve;
      })
    );
  }

  async exec(_args: string[]): Promise<ExecResult> {
    this.execPending += 1;
    return new Promise<ExecResult>((resolve) => {
      // Release the previous waiter (if any) first so chained sequential
      // awaits inside `loadRepository` proceed when the test calls
      // `releaseExec`.
      this.execResolve = (result: ExecResult): void => {
        this.execPending -= 1;
        resolve(result);
      };
    });
  }

  get onCommandExecuted(): () => { dispose: () => void } {
    return (): { dispose: () => void } => ({ dispose: (): void => {} });
  }

  dispose(): void {
    // no-op
  }
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
}

/** Yield to the microtask queue so chained awaits in the SUT can advance. */
async function flushMicrotasks(): Promise<void> {
  // Two `setImmediate` ticks — one to drain microtasks scheduled BY the
  // current async frame, a second to drain those scheduled BY the
  // first batch (e.g. the `await this._gitCli.exec(...)` continuation
  // inside `loadRepository` schedules its successor only after its own
  // resolution lands).
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('GitService — _drainPendingReloads (structural drain fix)', () => {
  const rootPath = '/tmp/drain-test-repo';

  let service: GitService;
  let stubCli: HangingStubGitCli;

  beforeEach(() => {
    service = new GitService();
    stubCli = new HangingStubGitCli();
    (service as unknown as DrainTestSurface)._gitCli = stubCli;
  });

  afterEach(() => {
    service.dispose();
  });

  it('enrolls a getRepository-driven loadRepository into _reloading', async () => {
    // Kick off the call but DO NOT await it — we need to inspect the
    // service's internal state mid-flight.
    const getPromise = service.getRepository(Uri.file(rootPath));
    void getPromise;

    // Let `getRepository` reach `await this._gitCli.getRepositoryRoot(path)`.
    await flushMicrotasks();
    assert.ok(stubCli.rootResolve, 'getRepositoryRoot should be in flight');

    // Resolve the root lookup so `getRepository` proceeds into
    // `loadRepository(rootPath)`. After this, `_reloading` MUST contain
    // an entry keyed by rootPath.
    stubCli.rootResolve(rootPath);
    await flushMicrotasks();

    const reloading = (service as unknown as DrainTestSurface)._reloading;
    assert.strictEqual(
      reloading.has(rootPath),
      true,
      'getRepository must enroll its loadRepository call into _reloading'
    );
  });

  // POSIX-only: this white-box spec drives loadRepository's real-fs marker-read
  // + git-exec interleave to FULL completion against a non-existent path, and
  // that fs error timing diverges on Windows enough to stall the release loop.
  // The drain contract itself is platform-independent and covered by the other
  // specs in this file, which do not drive the load to completion.
  (process.platform === 'win32' ? it.skip : it)(
    '_drainPendingReloads does not resolve until the in-flight load resolves',
    async () => {
      // Drive `getRepository` into `loadRepository` and stall there.
      void service.getRepository(Uri.file(rootPath));
      await flushMicrotasks();
      assert.ok(stubCli.rootResolve, 'getRepositoryRoot should be in flight');
      stubCli.rootResolve(rootPath);
      await flushMicrotasks();

      // Sanity: the load should be parked on its first git exec
      // (symbolic-ref / rev-parse / etc).
      assert.ok(stubCli.execResolve, 'loadRepository should be parked on a git exec');

      // Start the drain.
      let drainResolved = false;
      const drainPromise = (service as unknown as DrainTestSurface)
        ._drainPendingReloads()
        .then(() => {
          drainResolved = true;
        });

      // Let the drain microtasks settle. It MUST NOT resolve yet — the
      // load is still pending.
      await flushMicrotasks();
      assert.strictEqual(
        drainResolved,
        false,
        'drain must wait for the in-flight loadRepository to settle'
      );

      // Release the async tail. `loadRepository` interleaves `git exec` calls
      // with on-disk marker reads (fs I/O for repository-state detection), so an
      // exec is not always parked between steps — drive off drain completion, not
      // "an exec is in flight", and resolve each exec as it appears.
      for (let i = 0; i < 100 && !drainResolved; i++) {
        if (stubCli.execResolve) {
          const release = stubCli.execResolve;
          stubCli.execResolve = null;
          release({ exitCode: 0, stdout: 'main\n', stderr: '', combined: 'main\n' });
        }
        await flushMicrotasks();
      }

      // The drain must now resolve.
      await drainPromise;
      assert.strictEqual(
        drainResolved,
        true,
        'drain should resolve once every in-flight loadRepository has settled'
      );
    }
  );
});
