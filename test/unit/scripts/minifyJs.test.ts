/**
 * Unit test for `scripts/minify-js.sh`.
 *
 * The production minify pass runs inside `vscode:prepublish`, which
 * `vsce ls` invokes. check-vsix-clean.sh sets
 * INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1 to obtain a listing WITHOUT
 * packaging — so under that bypass, minify must be a no-op: the listed
 * file set does not depend on minification, and re-minifying on every
 * `npm test` is wasted work that also leaves dist/ minified for the
 * next run.
 *
 * RED→GREEN evidence: written before `scripts/minify-js.sh` existed —
 * the spawn failed (no such file). With the script in tree the bypass
 * branch exits 0 with the skip note and never touches the bundles.
 */

import '../../setup';
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'minify-js.sh');

describe('scripts/minify-js.sh — dryrun bypass short-circuits minify', () => {
  it('is a no-op (exit 0, skip note) under INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1', () => {
    const r = spawnSync('bash', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, INTELLIG_INTERNAL_PREPUBLISH_DRYRUN: '1' },
    });
    assert.strictEqual(r.status, 0, `expected 0; got ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /skipped/i, r.stdout || r.stderr);
    // The skip branch must not invoke esbuild at all.
    assert.doesNotMatch(r.stdout + r.stderr, /esbuild/i);
  });
});
