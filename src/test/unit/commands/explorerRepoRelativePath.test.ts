/**
 * Unit coverage for `repoRelativePath` — the explorer-command path fix.
 *
 * The explorer Git handlers used to derive the git pathspec with
 * `vscode.workspace.asRelativePath`, which is relative to the WORKSPACE FOLDER
 * and so wrong whenever the repo root differs from the folder (a nested repo /
 * submodule, or a multi-root workspace where the folder name is prefixed). git
 * runs the op under `cwd = repo.rootUri.fsPath`, so it needs a REPO-root-
 * relative path. `repoRelativePath` produces exactly that.
 *
 * These tests pin the pure relative-path logic and the outside-repo fallback.
 * Symlink canonicalization (macOS `/var` → `/private/var`, where git reports
 * the resolved root but the URI keeps the symlink) is exercised end-to-end by
 * the real-git e2e suite `13.explorer.test.ts`, which runs against an actual
 * temp repo under the symlinked `/var/folders` tree.
 */

import '../../setup';
import * as assert from 'assert';
import * as path from 'path';
import {
  repoRelativePath,
  toRepoRelativePosix,
} from '../../../commands/registration/explorerCommands';

describe('repoRelativePath (explorer git pathspec derivation)', () => {
  it('returns the bare filename for a top-level file', () => {
    assert.strictEqual(repoRelativePath('/repo', '/repo/file0.txt'), 'file0.txt');
  });

  it('returns the repo-root-relative, POSIX path for a nested file', () => {
    assert.strictEqual(
      repoRelativePath('/repo', '/repo/platform/util/Bar.java'),
      'platform/util/Bar.java'
    );
  });

  it('is repo-root-relative even when the repo is nested below the workspace folder', () => {
    // The intellij-community / submodule shape: the workspace folder is an
    // ancestor of the repo, so `asRelativePath` would yield `repo/file0.txt`,
    // but the git cwd is the repo root — the path must drop that prefix.
    assert.strictEqual(repoRelativePath('/ws/repo', '/ws/repo/file0.txt'), 'file0.txt');
  });

  it('falls back to the absolute fsPath when the file is outside the repo', () => {
    // A bogus `../` pathspec would be silently wrong; handing git the absolute
    // path makes it surface a clear "outside repository" error instead.
    assert.strictEqual(repoRelativePath('/repo', '/elsewhere/file.txt'), '/elsewhere/file.txt');
  });

  it('falls back to the absolute fsPath when asked for the repo root itself', () => {
    assert.strictEqual(repoRelativePath('/repo', '/repo'), '/repo');
  });

  it('tolerates a trailing separator on the repo root', () => {
    assert.strictEqual(repoRelativePath('/repo/', '/repo/sub/file.txt'), 'sub/file.txt');
  });
});

describe('toRepoRelativePosix (separator + outside-repo core, path impl injected)', () => {
  describe('POSIX', () => {
    it('returns the repo-relative POSIX path', () => {
      assert.strictEqual(toRepoRelativePosix('/repo', '/repo/src/a.ts', path.posix), 'src/a.ts');
    });

    it('falls back to absolute fsPath for a file outside the repo', () => {
      assert.strictEqual(toRepoRelativePosix('/repo', '/other/a.ts', path.posix), '/other/a.ts');
    });
  });

  describe('Windows (path.win32)', () => {
    it('normalizes back-slashes to POSIX in the repo-relative result', () => {
      assert.strictEqual(
        toRepoRelativePosix('C:\\repo', 'C:\\repo\\sub\\f.txt', path.win32),
        'sub/f.txt'
      );
    });

    it('falls back to the absolute fsPath across drives (outside the repo)', () => {
      // path.win32.relative across drives yields the absolute target, which the
      // drive-letter isAbsolute branch must catch.
      assert.strictEqual(
        toRepoRelativePosix('C:\\repo', 'D:\\x\\f.txt', path.win32),
        'D:\\x\\f.txt'
      );
    });

    it('falls back to the absolute fsPath when asked for the repo root itself', () => {
      assert.strictEqual(toRepoRelativePosix('C:\\repo', 'C:\\repo', path.win32), 'C:\\repo');
    });
  });
});
