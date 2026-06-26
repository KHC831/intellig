/**
 * Unit tests for `scripts/check-publish-vsix.sh`.
 *
 * The guard refuses to publish a vsix whose filename matches
 * `*-dogfood.vsix`, and is a no-op for any other filename.
 *
 * RED→GREEN evidence: each fail-case spec was first added expecting
 * exit-1, with no `check-publish-vsix.sh` in tree (the script
 * predated this WIP for cluster-B but the suite did not). Running
 * the spec without the script in tree gave a non-zero spawn error
 * (RED). With the script committed, the dogfood path returns 1
 * with the documented reason (GREEN).
 *
 * The synthetic `.vsix` files are zero-byte stubs in tmp dirs —
 * the guard is filename-based and does not inspect content, so a
 * stub is sufficient to exercise it.
 */

import '../../setup';
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-publish-vsix.sh');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runScript(args: string[]): RunResult {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

function tmpVsix(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-publish-vsix-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, ''); // empty stub
  return p;
}

describe('scripts/check-publish-vsix.sh — TL-95 dogfood filename guard', () => {
  it('exits 0 with no arguments (publish-flow safety net no-op)', () => {
    const r = runScript([]);
    assert.strictEqual(r.status, 0, `expected 0; got ${r.status}\n${r.stderr}`);
    assert.match(r.stdout, /OK — no vsix paths supplied/);
  });

  it('exits 0 for a real publish vsix filename (intellig-X.Y.Z.vsix)', () => {
    const p = tmpVsix('intellig-0.1.0.vsix');
    try {
      const r = runScript([p]);
      assert.strictEqual(r.status, 0, `expected 0; got ${r.status}\n${r.stderr}`);
      assert.match(r.stdout, /none of the 1 supplied path\(s\) match/);
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  it('exits 1 for an intellig-X.Y.Z-dogfood.vsix filename and names the offender', () => {
    const p = tmpVsix('intellig-0.1.0-dogfood.vsix');
    try {
      const r = runScript([p]);
      assert.strictEqual(r.status, 1, `expected 1; got ${r.status}\n${r.stdout}\n${r.stderr}`);
      // stdout because the script uses `echo`, not `>&2`.
      assert.match(r.stdout, /FAIL: refusing to publish dogfood-tagged vsix/);
      assert.match(r.stdout, new RegExp(`- ${path.basename(p)}|- ${escapeRe(p)}`));
      // Migration hint: the right escape is `vsce package` without env vars.
      assert.match(r.stdout, /vsce@2\.24\.0 package/);
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  it('matches *-dogfood.vsix case-insensitively', () => {
    const p = tmpVsix('intellig-0.1.0-DOGFOOD.VSIX');
    try {
      const r = runScript([p]);
      assert.strictEqual(r.status, 1, `expected 1; got ${r.status}\n${r.stdout}`);
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  it('matches by basename (works on absolute or relative paths uniformly)', () => {
    const p = tmpVsix('intellig-0.1.0-dogfood.vsix');
    try {
      // Relative-style invocation (./<basename>) — basename check still trips.
      const cwd = path.dirname(p);
      const rel = './' + path.basename(p);
      const r = spawnSync('bash', [SCRIPT, rel], { cwd, encoding: 'utf8' });
      assert.strictEqual(r.status, 1, `expected 1; got ${r.status}\n${r.stdout}\n${r.stderr}`);
    } finally {
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
    }
  });

  it('does not require the file to exist on disk (filename-only guard)', () => {
    // The intentional design: this script validates filenames, not file
    // existence. A non-existent
    // *-dogfood.vsix path still trips. The downstream `vsce publish`
    // is what asserts the file actually exists.
    const r = runScript(['/no/such/dir/intellig-0.0.0-dogfood.vsix']);
    assert.strictEqual(r.status, 1, `expected 1; got ${r.status}\n${r.stdout}`);
  });

  it('flags every dogfood path when given a mixed list', () => {
    const ok = tmpVsix('intellig-0.1.0.vsix');
    const bad1 = tmpVsix('intellig-0.1.0-dogfood.vsix');
    const bad2 = tmpVsix('intellig-0.2.0-dogfood.vsix');
    try {
      const r = runScript([ok, bad1, bad2]);
      assert.strictEqual(r.status, 1);
      assert.match(r.stdout, new RegExp(escapeRe(path.basename(bad1))));
      assert.match(r.stdout, new RegExp(escapeRe(path.basename(bad2))));
    } finally {
      [ok, bad1, bad2].forEach((p) => fs.rmSync(path.dirname(p), { recursive: true, force: true }));
    }
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
