/**
 * Tests for the watcher-families registry pattern in
 * `GitService.removeRepositoryWatcher` (#219).
 *
 * Bug: originally, `removeRepositoryWatcher` walked two specific Maps
 * `_fileWatchers` (per-repo `.git/<entry>` watchers from) and
 * `_newRepoWatchers` (mid-session `**\/.git` watchers from)
 * by direct reference. Each new "watcher family" added to the service
 * (e.g. a hypothetical "submodule init watcher" or "worktree-add
 * watcher") would silently leak unless a future contributor also
 * remembered to add that map to the cleanup loop.
 *
 * Introduce a `_watcherMaps` registry — `Array<Map<string,
 * vscode.Disposable[]>>` — that every watcher family registers itself
 * in at construction time. `removeRepositoryWatcher(rootPath)` then
 * walks the union of all registered maps, disposing entries whose key
 * is `rootPath` itself OR a path-child of `rootPath` (matching the
 * existing nested-repo cleanup contract from / ).
 *
 * Each spec was authored RED-first and confirmed failing before the
 * registry refactor. See AGENT_WORKSPACE.md for the verbatim red-message
 * captures.
 */

import '../../setup';
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { GitService } from '../../../src/git-core/GitService';
import * as vscodeMock from '../../mocks/vscode';

const { Uri } = vscodeMock;

interface FamilySurface {
  _fileWatchers: Map<string, vscode.Disposable[]>;
  // Aligned to production type. ADR-008 section 1 documents that the
  // new-repo family was widened from singular `vscode.FileSystemWatcher`
  // to `vscode.FileSystemWatcher[]` (single-element array) so the map
  // fits the uniform `_watcherMaps` registry walker. Earlier this
  // TestSurface declared the field as `Map<string, vscode.Disposable>`
  // (singular), which was masked from compile by the `as unknown as`
  // cast and would have caused a runtime mismatch if a test reached
  // into the field directly.
  _newRepoWatchers: Map<string, vscode.Disposable[]>;
  _watcherMaps: Array<Map<string, vscode.Disposable[]>>;
  removeRepositoryWatcher: (rootPath: string) => void;
}

describe('GitService — watcher-families registry (TL-91 / #219)', () => {
  let gitService: GitService;

  beforeEach(() => {
    gitService = new GitService();
  });

  afterEach(() => {
    gitService.dispose();
  });

  it('exposes _watcherMaps as a registry of watcher Maps', () => {
    // Type-level pin: the registry exists, holds the existing per-repo
    // and new-repo maps (or maps that produce equivalent cleanup),
    // and is iterable.
    const surface = gitService as unknown as FamilySurface;
    assert.ok(Array.isArray(surface._watcherMaps), '_watcherMaps must be an array of Maps');
    assert.ok(
      surface._watcherMaps.length >= 1,
      'at least one watcher family (per-repo .git/ watchers) must be registered'
    );
    for (const m of surface._watcherMaps) {
      assert.ok(m instanceof Map, 'every entry in _watcherMaps must be a Map');
    }
  });

  it('removeRepositoryWatcher walks every registered map and disposes matching keys', () => {
    // Synthesize a third watcher-family map and register it, then verify
    // that removeRepositoryWatcher disposes the entry for `/repo` from the
    // third map alongside the standard per-repo / new-repo cleanup.
    const surface = gitService as unknown as FamilySurface;

    const disposeCalls: string[] = [];
    const fakeWatcher: vscode.Disposable = {
      dispose: () => {
        disposeCalls.push('synthetic-third-map:/repo');
      },
    };

    const thirdFamily: Map<string, vscode.Disposable[]> = new Map();
    thirdFamily.set('/repo', [fakeWatcher]);
    surface._watcherMaps.push(thirdFamily);

    // Pre-populate the standard per-repo map so the existing cleanup path
    // still has work to do. (The synthetic third-map disposes are the
    // novel surface this test exercises.)
    surface._fileWatchers.set('/repo', [
      {
        dispose: () => {
          disposeCalls.push('per-repo:/repo');
        },
      } as unknown as vscode.FileSystemWatcher,
    ]);

    surface.removeRepositoryWatcher('/repo');

    assert.ok(
      disposeCalls.includes('synthetic-third-map:/repo'),
      `synthetic third-map watcher must have been disposed; calls=${JSON.stringify(disposeCalls)}`
    );
    assert.ok(
      !thirdFamily.has('/repo'),
      'synthetic third-map entry for /repo must be removed after cleanup'
    );
    assert.ok(disposeCalls.includes('per-repo:/repo'), 'standard per-repo watcher still disposed');
  });

  it('synthetic third-map cleanup honors the path-child rule (Wave 10 R2 / TL-83 contract)', () => {
    // The path-child rule: removing /work disposes /work/projectA AND
    // /work/projectB but NOT /workspace/other (sibling that shares only
    // a string prefix). The new registry pattern must preserve that
    // semantics across ALL registered maps, not just the existing two.
    const surface = gitService as unknown as FamilySurface;

    const disposeCalls: string[] = [];
    const mk = (key: string): vscode.Disposable => ({
      dispose: () => {
        disposeCalls.push(key);
      },
    });

    const thirdFamily: Map<string, vscode.Disposable[]> = new Map();
    thirdFamily.set('/work', [mk('third:/work')]);
    thirdFamily.set('/work/projectA', [mk('third:/work/projectA')]);
    thirdFamily.set('/work/projectB', [mk('third:/work/projectB')]);
    thirdFamily.set('/workspace/other', [mk('third:/workspace/other')]);
    surface._watcherMaps.push(thirdFamily);

    surface.removeRepositoryWatcher('/work');

    // /work, /work/projectA, /work/projectB disposed; /workspace/other preserved.
    assert.deepStrictEqual(
      disposeCalls.sort(),
      ['third:/work', 'third:/work/projectA', 'third:/work/projectB'],
      `expected third-map cleanup to honor the path-child rule; got ${JSON.stringify(disposeCalls)}`
    );
    assert.ok(
      thirdFamily.has('/workspace/other'),
      'sibling /workspace/other must remain in the third-map'
    );
  });

  // Touch Uri so the import isn't reported as unused if a future test
  // adds a uri-based assertion.
  void Uri;
});
