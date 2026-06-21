/**
 * Companion spec for scripts/check-pathspec-canonicalized.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth — a raw
 * `path.relative(...)` call fails it, (c) honours the `pathspec-guard-allow`
 * opt-out marker (the RepositoryDiscovery containment checks), (d) ignores
 * paren-less prose mentions of the API, and (e) in default (no-arg) mode scans
 * git-TRACKED `src` only (excluding `test`).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-pathspec-canonicalized.sh');

function runGuard(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function runGuardInDir(cwd: string): { status: number | null; stderr: string } {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', cwd });
  return { status: r.status, stderr: r.stderr ?? '' };
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr ?? ''}`);
  }
}

describe('check-pathspec-canonicalized guard', () => {
  it('passes against the real tree (default scope: tracked src minus test)', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails on a raw path.relative pathspec derivation (has teeth)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathspec-guard-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'offender.ts'),
        'const rel = path.relative(repo.rootUri.fsPath, uri.fsPath);\n',
        'utf8'
      );
      const { status, stderr } = runGuard([dir]);
      assert.strictEqual(status, 1, 'a raw path.relative( call must fail the guard');
      assert.ok(/pathspec-canonicalized guard FAILED/.test(stderr), 'should report the failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a line carrying the pathspec-guard-allow marker (containment check)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathspec-guard-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'ok.ts'),
        'const rel = path.relative(rootPath, candidate); // pathspec-guard-allow: containment check\n',
        'utf8'
      );
      const { status } = runGuard([dir]);
      assert.strictEqual(status, 0, 'a marked containment-check line must be allowed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a paren-less prose mention of the API', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathspec-guard-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'doc.ts'),
        '// Uses `path.relative` rather than a string startsWith check.\n',
        'utf8'
      );
      const { status } = runGuard([dir]);
      assert.strictEqual(status, 0, 'a comment without a call paren must not match');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default mode has teeth on a tracked src file but excludes test', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathspec-guard-git-'));
    try {
      git(dir, 'init', '-q');
      fs.mkdirSync(path.join(dir, 'src', 'test'), { recursive: true });
      // A pathspec offender under test must be OUT of scope (green so far).
      fs.writeFileSync(
        path.join(dir, 'src', 'test', 'fixture.ts'),
        'const rel = path.relative(repo.rootUri.fsPath, uri.fsPath);\n',
        'utf8'
      );
      git(dir, 'add', 'src/test/fixture.ts');
      assert.strictEqual(
        runGuardInDir(dir).status,
        0,
        'a path.relative under test must be out of default scope'
      );

      // The same offender under src/ (non-test) must fail.
      fs.writeFileSync(
        path.join(dir, 'src', 'offender.ts'),
        'const rel = path.relative(repo.rootUri.fsPath, uri.fsPath);\n',
        'utf8'
      );
      git(dir, 'add', 'src/offender.ts');
      assert.strictEqual(
        runGuardInDir(dir).status,
        1,
        'a tracked src (non-test) path.relative must fail in default mode'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
