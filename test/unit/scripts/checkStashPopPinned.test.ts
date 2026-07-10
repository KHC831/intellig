/**
 * Companion spec for scripts/check-stash-pop-pinned.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth on BOTH
 * receiver shapes — a bare `stashPop(repo, 0)` AND a property-access
 * `stashPop(this._repo, 0)` (the shape that slipped the old narrow regex),
 * (c) passes a resolved-index pop, and (d) honours the `pop-head-exempt:`
 * marker.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-stash-pop-pinned.sh');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function runGuard(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function mkTmpDir(): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, 'stash-pop-guard-'));
}

function checkSource(src: string): number | null {
  const dir = mkTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'offender.ts'), src, 'utf8');
    return runGuard([dir]).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-stash-pop-pinned guard', () => {
  it('passes against the real tree', () => {
    const { status, stdout } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stdout:\n${stdout}`);
  });

  it('fails on a bare stashPop(repo, 0) (has teeth)', () => {
    assert.strictEqual(
      checkSource('await this._gitService.stashPop(repo, 0);\n'),
      1,
      'a bare head-pop must fail'
    );
  });

  it('fails on a property-access receiver stashPop(this._repo, 0) — the ResetDialog shape', () => {
    assert.strictEqual(
      checkSource('await this._gitService.stashPop(this._repo, 0).match();\n'),
      1,
      'a property-access first arg must also fail (the old regex missed this)'
    );
  });

  it('passes a resolved-index pop stashPop(repo, idx)', () => {
    assert.strictEqual(
      checkSource('await this._gitService.stashPop(repo, resolvedIdx);\n'),
      0,
      'a resolved (non-literal-0) index is the pinned form and must pass'
    );
  });

  it('skips a line carrying the pop-head-exempt marker', () => {
    assert.strictEqual(
      checkSource(
        'await svc.stashPop(this._repo, 0); // pop-head-exempt: head is the entry just pushed\n'
      ),
      0,
      'a marked exempt line must be allowed'
    );
  });
});
