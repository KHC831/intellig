/**
 * Tier-2 command E2E — workspace helper.
 *
 * Problem: VS Code refuses to replace the root of a single-root workspace
 * via `updateWorkspaceFolders`. Re-launching the host per-test is also
 * too slow (the 90 s aggregate budget won't survive it).
 *
 * Solution: keep VS Code's workspace anchored at the sentinel folder the
 * launcher passed via `--folder-uri` (see `runTests.ts`), but tell the
 * extension's GitService to discover each fixture directly. `GitService
 * .getRepository(uri)` populates the internal repo cache; `getRepositories()`
 * then returns the fixture, and `resolveRepo` picks it as the single-repo
 * fallback (every test uses exactly one fixture at a time).
 *
 * Between tests we clear the cache via `removeRepositoryWatcher` so the
 * next test starts with a clean slate.
 */

import * as vscode from 'vscode';

import { getServices, getGitToolWindowProvider } from '../../../src/extension';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

const EXT_ID = 'KaHoChan.intellig';

/**
 * Narrow test-only surface on GitService for the E2E workspace-helper flow.
 *
 * Reaches through the frozen IGitService composite to:
 *   - enumerate cached repos,
 *   - drop their watchers,
 *   - drain any in-flight `loadRepository` async work before fixture
 *     teardown so we don't race a `fs.rmSync(fixture)` against the
 *     async tail of repository discovery (the structural defect that was
 *     resurrecting stale `_repositories` entries pointing at deleted
 *     paths and surfacing as "working directory missing" in the NEXT
 *     test). See GitService._drainPendingReloads JSDoc.
 *
 * Kept separate from production because `removeRepositoryWatcher` is a
 * teardown hook that shouldn't leak onto the public service interface,
 * and `_drainPendingReloads` is a strictly test-only seam.
 *
 * See `docs/testing.md` section 3 for the TestSurface convention.
 */
interface GitServiceWorkspaceHelperSurface {
  getRepositories(): IRepository[];
  removeRepositoryWatcher?: (rootPath: string) => void;
  _drainPendingReloads?: () => Promise<void>;
}

/**
 * Ensure the extension is activated and services are ready. Idempotent —
 * safe to call in every `beforeEach`.
 */
export async function ensureActivated(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) {
    throw new Error(`extension ${EXT_ID} not installed in host`);
  }
  if (!ext.isActive) {
    await ext.activate();
  }
}

/**
 * Register the fixture as the sole GitService-known repo for the duration
 * of the current test. Returns the discovered IRepository for callers that
 * want to pass it explicitly to service-level APIs.
 */
export async function useFixtureWorkspace(repoPath: string): Promise<IRepository> {
  await ensureActivated();

  const services = getServices();
  if (!services) {
    throw new Error('ExtensionServices not initialised yet — did activation fail?');
  }

  // Clear any lingering fixtures from previous tests. The gitService
  // exposes `removeRepositoryWatcher`; we call it for every cached repo so
  // `getRepositories()` starts empty. Defensively tolerate a missing method
  // in case the API ever moves.
  const gitService = services.gitService as unknown as GitServiceWorkspaceHelperSurface;
  // Drain any pending async repository discovery before disposing watchers
  // so we don't race the cache cleanup against `loadRepository`'s tail.
  await gitService._drainPendingReloads?.();
  for (const existing of gitService.getRepositories()) {
    gitService.removeRepositoryWatcher?.(existing.rootUri.fsPath);
  }

  const folderUri = vscode.Uri.file(repoPath);
  const repo = await services.gitService.getRepository(folderUri);
  if (!repo) {
    throw new Error(`no repository discovered at ${repoPath}`);
  }
  return repo;
}

/**
 * Tear down the test's repository registrations. Called in `afterEach`.
 *
 * Drains all in-flight repository async work, then synchronously removes
 * watchers + cache entries. Callers MUST `await` this. Without the drain,
 * a `fs.rmSync(fixture)` immediately after this returns can race
 * `loadRepository`'s tail (rev-parse / status / remote -v git spawns),
 * yielding ENOENT errors that `loadRepository` swallows in its per-call
 * try/catches — then its final unconditional `_repositories.set(rootPath,
 * ...)` resurrects a stale cache entry pointing at the deleted directory.
 * The NEXT test then sees that stale entry through `_resolveRepo` and
 * surfaces "working directory missing" against a path it never asked
 * about.
 *
 * The two `_drainPendingReloads` calls are intentional: the first drains
 * the previous test's pending discovery; the second mops up any new
 * loads that the watcher disposal events themselves kicked off (e.g.
 * `onDidChangeWorkspaceFolders` listeners triggering rediscovery).
 */
export async function clearWorkspace(): Promise<void> {
  const services = getServices();
  if (!services) {
    return;
  }
  const gitService = services.gitService as unknown as GitServiceWorkspaceHelperSurface;
  await gitService._drainPendingReloads?.();
  for (const existing of gitService.getRepositories()) {
    gitService.removeRepositoryWatcher?.(existing.rootUri.fsPath);
  }
  // Second drain: disposing watchers can fire workspace events that
  // schedule fresh `discoverRepository` calls; settle those too before we
  // hand control back to the caller's `fs.rmSync`.
  await gitService._drainPendingReloads?.();

  // Reset the GitToolWindowProvider's `_availableRepositories` (the
  // repo-selector dropdown's source of truth). Without this, the
  // provider keeps a stale `IRepository` handle from a previous test's
  // fixture — populated via `loadAllPanelData → setAvailableRepositories`
  // when the test's `provider.refresh()` fires. The next test's
  // `_handleCheckoutRevision` (and similar) then reaches the stale
  // handle through `getSelectedRepository()` and spawns `git` with
  // `cwd = <deleted fixture path>`, surfacing as
  // `spawn /usr/bin/git ENOENT` against the absolute git binary.
  //
  // The drain alone doesn't fix this because the stale state lives
  // in the provider, not in `gitService._repositories`.
  const provider = getGitToolWindowProvider();
  provider?.setAvailableRepositories([]);
}
