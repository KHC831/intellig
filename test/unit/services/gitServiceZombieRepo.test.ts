/**
 * Regression: a `loadRepository` that resolves AFTER its root was torn down
 * must NOT resurrect the repo.
 *
 * Race: a folder is added → `discoverRepository` starts `loadRepository`
 * (enrolled in `_reloading`) → the user removes the folder before it resolves →
 * `removeRepositoryWatcher` clears the maps → the in-flight load resolves and
 * (pre-fix) unconditionally re-`set`s `_repositories` AND — since the load-repository funnel
 * landed — re-installs the `.git/` watcher and re-fires `onDidChangeRepository`.
 * The result is a stale, un-removable zombie repo.
 *
 * Fix: `loadRepository` snapshots a per-root removal counter at entry and skips
 * its cache-write/watcher/announce if the root was removed while it was in
 * flight.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

/**
 * A gitCli whose FIRST `exec` blocks until `release()` is called (so a
 * `loadRepository` can be held mid-flight), then returns benign output for that
 * and every later call. `entered` resolves once the first exec is reached.
 */
class PausableGitCli {
  readonly entered: Promise<void>;
  private _markEntered!: () => void;
  private readonly _gate: Promise<void>;
  private _release!: () => void;
  private _started = false;

  constructor() {
    this.entered = new Promise<void>((r) => (this._markEntered = r));
    this._gate = new Promise<void>((r) => (this._release = r));
  }

  release(): void {
    this._release();
  }

  onCommandExecuted = (): { dispose: () => void } => ({ dispose: (): void => {} });

  async exec(): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    if (!this._started) {
      this._started = true;
      this._markEntered();
      await this._gate;
    }
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  dispose(): void {}
}

describe('GitService — zombie-repo resurrection guard', () => {
  it('does not re-cache, re-watch, or re-announce a root removed while its load was in flight', async () => {
    const root = '/tmp/intellig-zombie-repo';
    const cli = new PausableGitCli();
    const gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = cli;

    // Start a load enrolled in `_reloading`, exactly as discovery does.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const loadPromise = (gitService as any)._enrollReload(
      root,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (gitService as any).loadRepository(root)
    ) as Promise<IRepository>;

    // Wait until the load is genuinely in flight (paused inside exec).
    await cli.entered;

    // Tear the root down mid-flight (folder removed / repo deleted).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    (gitService as any).removeRepositoryWatcher(root);

    let changeFires = 0;
    gitService.onDidChangeRepository(() => (changeFires += 1));

    // Let the load finish; the zombie guard must suppress the resurrection.
    cli.release();
    await loadPromise;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const repos = (gitService as any)._repositories as Map<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const watchers = (gitService as any)._fileWatchers as Map<string, unknown>;

    assert.strictEqual(repos.has(root), false, 'a removed root must not be re-cached');
    assert.strictEqual(watchers.has(root), false, 'a removed root must not get a watcher');
    assert.strictEqual(changeFires, 0, 'a removed root must not re-fire onDidChangeRepository');

    gitService.dispose();
  });

  it('still caches + announces a normal load when the root is NOT removed (guard is not over-eager)', async () => {
    const root = '/tmp/intellig-live-repo';
    const cli = new PausableGitCli();
    const gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = cli;

    let changeFires = 0;
    gitService.onDidChangeRepository(() => (changeFires += 1));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const loadPromise = (gitService as any)._enrollReload(
      root,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (gitService as any).loadRepository(root)
    ) as Promise<IRepository>;

    await cli.entered;
    cli.release(); // no removal in between
    await loadPromise;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    const repos = (gitService as any)._repositories as Map<string, unknown>;
    assert.strictEqual(repos.has(root), true, 'a live load must cache the repo');
    assert.strictEqual(changeFires, 1, 'a live first-insertion must announce once');

    gitService.dispose();
  });
});
