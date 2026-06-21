/**
 * Tier-2 command E2E — nested-repo fixture builder.
 *
 * Several suites need the SAME pathological workspace shape to reproduce the
 * "asRelativePath vs repo-root path" bug class: a git repo whose root differs
 * from the workspace folder (a nested repo / submodule, or a multi-root
 * workspace where the folder name prefixes every path). Git commands run with
 * `cwd = repo.rootUri.fsPath`, so a handler that derives its pathspec from
 * `vscode.workspace.asRelativePath(uri)` (workspace-folder-relative) sends git
 * a path that is NOT repo-root-relative — `git <op> -- <folder>/<file>` then
 * fails with "pathspec did not match any files" (mutating ops silently do
 * nothing) or yields an empty result (history/blame report a false "nothing
 * here").
 *
 * This builder creates the fixture repo under `os.tmpdir()` first (unwatched)
 * and only then `rename`s it INSIDE the launcher's sentinel workspace folder
 * as one atomic step. Creating it directly under the sentinel would let the
 * extension's folder watcher discover the `.git` mid-build and race the
 * fixture's commits on `index.lock`. After relocation the repo root is a
 * descendant of the workspace folder, so `asRelativePath(file0.txt)` returns a
 * multi-segment path that is NOT repo-root-relative — exactly the shape that
 * trips the handlers.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, Fixture, FixtureOpts } from './gitFixture';
import { useFixtureWorkspace } from './workspaceHelper';

/** A relocated nested fixture plus a `uriFor` bound to its repo root. */
export interface NestedFixture {
  /** The live fixture (its `rootPath` now lives under the sentinel folder). */
  fix: Fixture;
  /** Build a `vscode.Uri` for a repo-relative path inside the fixture. */
  uriFor: (rel: string) => vscode.Uri;
}

/**
 * Build a fixture repo and relocate it inside the sentinel workspace folder so
 * its root differs from the workspace-folder root. Registers it as the sole
 * GitService-known repo for the current test and asserts the precondition that
 * `asRelativePath(file0.txt)` is genuinely nested (otherwise the test would
 * prove nothing about the repo-root-relative path fix).
 *
 * Callers MUST invoke `fix.cleanup()` in their `afterEach` (paired with
 * `clearWorkspace()` for teardown ordering).
 */
export async function setupNestedFixture(opts: FixtureOpts = {}): Promise<NestedFixture> {
  const sentinel = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(sentinel, 'launcher sentinel workspace folder must exist');

  const built = await createFixtureRepo({ commits: 2, ...opts });
  const builtBase = path.dirname(built.rootPath); // <tmp>/intellig-e2e-XXXX
  const destBase = path.join(sentinel, path.basename(builtBase));
  fs.renameSync(builtBase, destBase); // atomic: the repo appears fully-formed
  const rootPath = path.join(destBase, 'repo');
  const fix: Fixture = {
    ...built,
    rootPath,
    cleanup: async () => {
      try {
        fs.rmSync(destBase, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* best-effort */
      }
      await built.cleanup();
    },
  };

  await useFixtureWorkspace(fix.rootPath);

  const uriFor = (rel: string): vscode.Uri => vscode.Uri.file(path.join(fix.rootPath, rel));

  // Precondition: the file's workspace-relative path must be nested (not
  // repo-root-relative), i.e. the buggy `asRelativePath` value differs from
  // the correct repo-relative value. Otherwise the test proves nothing.
  const rel = vscode.workspace.asRelativePath(uriFor('file0.txt'));
  assert.ok(
    rel.includes('/') && rel !== 'file0.txt',
    `precondition: asRelativePath should be nested under the workspace folder, got "${rel}"`
  );

  return { fix, uriFor };
}
