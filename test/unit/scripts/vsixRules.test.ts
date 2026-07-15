/**
 * Unit tests for `scripts/lib/vsix-rules.sh` — the single source of
 * truth for what may and may not appear in the published .vsix.
 *
 * Both `check-vsix-clean.sh` (structural guard over `vsce ls`) and
 * `publish.sh` (post-build `unzip -Z1` scan of the real artifact)
 * source this library so the two can never drift.
 *
 * The library provides three stdin→stdout evaluators exercised here:
 *   - vsix_forbidden_violations : deny-list net (patterns that must
 *     never ship).
 *   - vsix_allowlist_violations : allow-list assertion (every listed
 *     entry must fall under a known-good prefix or exact root file).
 *   - vsix_missing_required     : runtime-manifest completeness.
 *
 * RED→GREEN evidence: written before `scripts/lib/vsix-rules.sh`
 * existed. Each `source` failed with a non-zero status ("No such
 * file"), and the `.husky/`, `out-test/` and build-log fixtures went
 * uncaught by the pre-fix deny-list (no `^\.husky/` / `^out-test/`
 * patterns) and had no allow-list at all. With the library in tree the
 * three fixtures fail the check as asserted below.
 */

import '../../setup';
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const RULES = 'scripts/lib/vsix-rules.sh';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Source the rules lib, pipe `listing` to `fn`, return its output. */
function evaluate(fn: string, listing: string[]): RunResult {
  const script = `source ${RULES}; printf '%s\\n' "$@" | ${fn}`;
  const r = spawnSync('bash', ['-c', script, 'bash', ...listing], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('scripts/lib/vsix-rules.sh — shared .vsix content rules', () => {
  describe('vsix_forbidden_violations (deny-list net)', () => {
    it('flags a .husky/ runner path (F1 — shipped in 0.3.1)', () => {
      const r = evaluate('vsix_forbidden_violations', ['.husky/_/husky.sh']);
      assert.match(r.stdout, /\.husky\/_\/husky\.sh/, r.stdout || r.stderr);
    });

    it('flags an out-test/ path (F6)', () => {
      const r = evaluate('vsix_forbidden_violations', ['out-test/test/e2e/runTests.js']);
      assert.match(r.stdout, /out-test\/test\/e2e\/runTests\.js/, r.stdout || r.stderr);
    });

    it('passes clean runtime-manifest entries', () => {
      const r = evaluate('vsix_forbidden_violations', [
        'dist/extension.js',
        'media/mergeWindow.js',
        'package.json',
      ]);
      assert.strictEqual(r.stdout.trim(), '', r.stdout);
    });
  });

  describe('vsix_allowlist_violations (allow-list assertion — S1 class fix)', () => {
    it('flags a build-log line that is neither an allowed prefix nor an exact root file', () => {
      const r = evaluate('vsix_allowlist_violations', ['> intellig@0.3.1 vscode:prepublish']);
      assert.match(r.stdout, /intellig@0\.3\.1 vscode:prepublish/, r.stdout || r.stderr);
    });

    it('flags a .husky/ path (leak direction the deny-list historically missed)', () => {
      const r = evaluate('vsix_allowlist_violations', ['.husky/pre-commit']);
      assert.match(r.stdout, /\.husky\/pre-commit/, r.stdout || r.stderr);
    });

    it('flags an out-test/ path', () => {
      const r = evaluate('vsix_allowlist_violations', ['out-test/test/e2e/runTests.js']);
      assert.match(r.stdout, /out-test\/test\/e2e\/runTests\.js/, r.stdout || r.stderr);
    });

    it('accepts allowed prefixes and the root doc/manifest set', () => {
      const r = evaluate('vsix_allowlist_violations', [
        'dist/extension.js',
        'dist/rebaseTodoEditor.js',
        'media/monaco/vs/loader.js',
        'resources/git-icon-branch.svg',
        'images/icon.png',
        'README.md',
        'CHANGELOG.md',
        'LICENSE',
        'SECURITY.md',
        'package.json',
      ]);
      assert.strictEqual(r.stdout.trim(), '', r.stdout);
    });

    it('flags images/ entries other than the shipped icon', () => {
      const r = evaluate('vsix_allowlist_violations', ['images/icon.svg']);
      assert.match(r.stdout, /images\/icon\.svg/, r.stdout || r.stderr);
    });
  });

  describe('vsix_normalize_zip_entries (publish.sh artifact scan)', () => {
    it('strips the extension/ prefix and drops package metadata + directory entries', () => {
      const r = evaluate('vsix_normalize_zip_entries', [
        'extension/dist/extension.js',
        'extension/media/', // directory entry
        'extension/package.json',
        'extension.vsixmanifest',
        '[Content_Types].xml',
      ]);
      const lines = r.stdout.split('\n').filter(Boolean).sort();
      assert.deepStrictEqual(lines, ['dist/extension.js', 'package.json']);
    });

    it('normalized dogfood-shaped entries feed the allow-list, which flags the leak', () => {
      const norm = evaluate('vsix_normalize_zip_entries', [
        'extension/dist/extension.js',
        'extension/.husky/pre-commit',
        'extension.vsixmanifest',
      ]);
      const entries = norm.stdout.split('\n').filter(Boolean);
      const flagged = evaluate('vsix_allowlist_violations', entries);
      assert.match(flagged.stdout, /\.husky\/pre-commit/, flagged.stdout || flagged.stderr);
    });
  });

  describe('vsix_missing_required (runtime-manifest completeness)', () => {
    it('reports every required entry absent from an empty listing (incl. icons — F7)', () => {
      const r = evaluate('vsix_missing_required', ['dist/extension.js']);
      assert.match(r.stdout, /resources\/git-icon-branch\.svg/, r.stdout);
      assert.match(r.stdout, /images\/icon\.png/, r.stdout);
      assert.match(r.stdout, /media\/codicon\.ttf/, r.stdout);
    });

    it('reports nothing when all required entries are present', () => {
      const r = evaluate('vsix_missing_required', [
        'dist/extension.js',
        'dist/rebaseTodoEditor.js',
        'media/mergeWindow.js',
        'media/webview/shelveDialog.js',
        'media/webview/newBranchDialog.js',
        'media/webview/mergeDialog.js',
        'media/webview/commitMessageDialog.js',
        'media/webview/resetDialog.js',
        'media/webview/rebaseDialog.js',
        'media/webview/applyPatchDialog.js',
        'media/webview/resolveConflictsDialog.js',
        'media/webview/pushDialog.js',
        'media/webview/rebaseProgressView.js',
        'media/webview/rebaseEditor.js',
        'media/webview/commitDialog.js',
        'media/webview/commitToolWindow.js',
        'media/webview/gitToolWindow.js',
        'media/codicon.ttf',
        'media/monaco/vs/loader.js',
        'resources/git-icon-branch.svg',
        'images/icon.png',
      ]);
      assert.strictEqual(r.stdout.trim(), '', r.stdout);
    });
  });
});
