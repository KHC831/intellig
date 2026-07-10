/**
 * Companion spec for scripts/check-checkout-head-batched.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth — a bare
 * `['checkout', 'HEAD', '--', ...]` argv fails it, (c) honours the
 * `checkout-head-exempt:` opt-out marker, and (d) ignores paren-less prose
 * mentions of the shape.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-checkout-head-batched.sh');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function runGuard(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function mkTmpDir(): string {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(TMP_ROOT, 'checkout-head-guard-'));
}

describe('check-checkout-head-batched guard', () => {
  it('passes against the real tree', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails on a bare batched checkout HEAD -- argv (has teeth)', () => {
    const dir = mkTmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'offender.ts'),
        "await cli.exec(['checkout', 'HEAD', '--', ...paths], { cwd });\n",
        'utf8'
      );
      const { status, stderr } = runGuard([dir]);
      assert.strictEqual(status, 1, 'a bare batched checkout HEAD -- must fail the guard');
      assert.ok(/check-checkout-head-batched/.test(stderr), 'should report the failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a line carrying the checkout-head-exempt marker', () => {
    const dir = mkTmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'ok.ts'),
        "await cli.exec(['checkout', 'HEAD', '--', file.path], { cwd }); // checkout-head-exempt: path is present in HEAD\n",
        'utf8'
      );
      const { status } = runGuard([dir]);
      assert.strictEqual(status, 0, 'a marked exempt line must be allowed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a paren-less prose mention of the shape', () => {
    const dir = mkTmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'doc.ts'),
        '// A bare checkout HEAD -- over caller paths fatals on an add/add file.\n',
        'utf8'
      );
      const { status } = runGuard([dir]);
      assert.strictEqual(status, 0, 'a comment without the argv literal must not match');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
