/**
 * Companion spec for scripts/check-exec-leading-rev-eoo.sh.
 *
 * Proves the guard (a) passes against the real tree, (b) has teeth — a raw
 * `.exec(['<ref-cmd>', `${...`])` with a leading interpolation-first ref fails
 * it (the BranchComparisonView regression shape), (c) does NOT flag the safe
 * sinks (flag-then-template, literal-prefixed template, buildGitArgs routing),
 * (d) honours the `argv-guard-allow` opt-out marker, and (e) in default
 * (no-arg) mode scans git-TRACKED `src` only (excluding `src/test`).
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-exec-leading-rev-eoo.sh');

// The dangerous regression shape: a ref subcommand whose leading positional is
// a template literal that begins with an interpolation (no literal prefix).
const LEADING_REV =
  "await ctx.gitCli.exec(['diff', `${branch1}...${branch2}`, '--', filePath], o);\n";

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

describe('check-exec-leading-rev guard', () => {
  it('passes against the real tree (default scope: tracked src minus src/test)', () => {
    const { status, stderr } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stderr:\n${stderr}`);
  });

  it('fails on a leading interpolation-first ref/range bare-exec (has teeth)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-rev-guard-'));
    try {
      fs.writeFileSync(path.join(dir, 'offender.ts'), LEADING_REV, 'utf8');
      const { status, stderr } = runGuard([dir]);
      assert.strictEqual(status, 1, 'a leading-interp ref bare-exec must fail the guard');
      assert.ok(/exec-leading-rev guard FAILED/.test(stderr), 'should report the failure');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT flag the safe sinks (flag-then-template, prefixed template, buildGitArgs)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-rev-guard-'));
    try {
      const safe = [
        // Leading positional is a FLAG; the hex-validated range follows it.
        "await c.exec(['diff', '--name-only', `${oldHash}..${newHash}`], o);",
        // Template has a literal prefix — can never begin with '--'.
        "await c.exec(['show', `:${stage}:${filePath}`], o);",
        "await c.exec(['show', `HEAD:${basePath}`], o);",
        "await c.exec(['rev-parse', `stash@{${index}}`], o);",
        // Routed through buildGitArgs: range rides behind --end-of-options.
        "buildGitArgs('diff', [], [`${branch1}...${branch2}`], [filePath]);",
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'safe.ts'), safe + '\n', 'utf8');
      const { status, stderr } = runGuard([dir]);
      assert.strictEqual(status, 0, `safe sinks must not be flagged; stderr:\n${stderr}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a line carrying the argv-guard-allow marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-rev-guard-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'ok.ts'),
        "await c.exec(['diff', `${safeRange}`], o); // argv-guard-allow: range is hex-validated upstream\n",
        'utf8'
      );
      const { status } = runGuard([dir]);
      assert.strictEqual(status, 0, 'a marked, proven-safe leading-interp line must be allowed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default mode has teeth on a tracked src file but excludes src/test', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-rev-guard-git-'));
    try {
      git(dir, 'init', '-q');
      fs.mkdirSync(path.join(dir, 'src', 'test'), { recursive: true });
      // Offender under src/test is OUT of scope.
      fs.writeFileSync(path.join(dir, 'src', 'test', 'fixture.ts'), LEADING_REV, 'utf8');
      git(dir, 'add', 'src/test/fixture.ts');
      assert.strictEqual(
        runGuardInDir(dir).status,
        0,
        'a leading-rev exec under src/test must be out of default scope'
      );

      // The same offender under src/ (non-test) must fail.
      fs.writeFileSync(path.join(dir, 'src', 'offender.ts'), LEADING_REV, 'utf8');
      git(dir, 'add', 'src/offender.ts');
      assert.strictEqual(
        runGuardInDir(dir).status,
        1,
        'a tracked src (non-test) leading-rev exec must fail in default mode'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
