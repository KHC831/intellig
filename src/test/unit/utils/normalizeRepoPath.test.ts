/**
 * Unit tests for normalizeRepoPath (spec L14).
 *
 * Pins the canonical repository-path identity contract: Windows
 * drive-letter case and slash flavor collapse to one form, trailing
 * slashes are stripped, and POSIX case is preserved (Linux is
 * case-sensitive). This is the helper repo-identity comparisons route
 * through so the dropdown doesn't treat two spellings of the same
 * directory as different repos.
 */

import * as assert from 'assert';
import { Uri } from '../../mocks/vscode';
import { normalizeRepoPath, normalizeRepoPathString } from '../../../utils/normalizeRepoPath';

describe('normalizeRepoPath', () => {
  describe('Windows drive-letter case (L14)', () => {
    it('collapses upper- and lower-case drive letters to the same string', () => {
      const upper = normalizeRepoPathString('C:/Repos/foo');
      const lower = normalizeRepoPathString('c:/Repos/foo');
      assert.strictEqual(upper, lower);
      assert.strictEqual(upper, 'c:/Repos/foo', 'drive letter is lowercased; rest preserved');
    });

    it('preserves case in the path body (only the drive letter is folded)', () => {
      // "Repos/Foo" keeps its case — only "C:" -> "c:".
      assert.strictEqual(normalizeRepoPathString('C:/Repos/Foo'), 'c:/Repos/Foo');
    });
  });

  describe('slash flavor', () => {
    it('collapses backslash and forward-slash variants to the same string', () => {
      const back = normalizeRepoPathString('C:\\Repos\\foo');
      const fwd = normalizeRepoPathString('C:/Repos/foo');
      assert.strictEqual(back, fwd);
      assert.strictEqual(back, 'c:/Repos/foo');
    });

    it('handles mixed slashes', () => {
      assert.strictEqual(normalizeRepoPathString('C:\\Repos/foo\\bar'), 'c:/Repos/foo/bar');
    });
  });

  describe('trailing slash', () => {
    it('strips a single trailing slash', () => {
      assert.strictEqual(normalizeRepoPathString('/home/user/repo/'), '/home/user/repo');
    });

    it('does not reduce a bare root to empty', () => {
      assert.strictEqual(normalizeRepoPathString('/'), '/');
    });

    it('strips a trailing backslash (Windows)', () => {
      assert.strictEqual(normalizeRepoPathString('C:\\Repos\\foo\\'), 'c:/Repos/foo');
    });
  });

  describe('POSIX case sensitivity', () => {
    it('preserves case differences (Linux treats /Repo and /repo as distinct)', () => {
      const a = normalizeRepoPathString('/home/user/Repo');
      const b = normalizeRepoPathString('/home/user/repo');
      assert.notStrictEqual(a, b, 'POSIX paths must NOT be case-folded');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      assert.strictEqual(normalizeRepoPathString(''), '');
    });

    it('leaves an already-canonical POSIX path unchanged', () => {
      assert.strictEqual(normalizeRepoPathString('/home/user/repo'), '/home/user/repo');
    });
  });

  describe('Uri overload', () => {
    it('normalizes via the Uri.fsPath', () => {
      const uri = Uri.file('/home/user/repo');
      assert.strictEqual(normalizeRepoPath(uri), normalizeRepoPathString(uri.fsPath));
    });
  });
});
