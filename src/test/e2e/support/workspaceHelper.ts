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

import { getServices } from '../../../extension';
import type { IRepository } from '../../../services/interfaces/IGitService';

const EXT_ID = 'intellig-vscode.intellig';

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
  const gitService = services.gitService as unknown as {
    getRepositories(): IRepository[];
    removeRepositoryWatcher?: (rootPath: string) => void;
  };
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
 */
export function clearWorkspace(): void {
  const services = getServices();
  if (!services) {
    return;
  }
  const gitService = services.gitService as unknown as {
    getRepositories(): IRepository[];
    removeRepositoryWatcher?: (rootPath: string) => void;
  };
  for (const existing of gitService.getRepositories()) {
    gitService.removeRepositoryWatcher?.(existing.rootUri.fsPath);
  }
}
