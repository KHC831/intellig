/**
 * Companion spec for scripts/check-rebase-conflict-flow.sh (check (a) only —
 * the abort-scope rule; the runner-scope checks (b)+(c) moved to
 * checkRebaseRunnerScope.test.ts).
 *
 * Proves the guard (a) passes against the real tree (allow-listed user-action
 * surfaces + the two justified orphaned-rebase recovery sites), (b) has teeth —
 * an `abortRebase(`/`rebaseAbort(` call in a non-allow-listed file fails — and
 * (c) honours the escape-hatch marker. Explicit-path mode treats every given
 * file as non-allow-listed, which is what lets these fixtures exercise the teeth.
 */
import * as assert from 'assert';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.join(process.cwd(), 'scripts/check-rebase-conflict-flow.sh');
const TMP_ROOT = path.join(process.cwd(), 'workspace-notes/tmp');

function runGuard(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function checkSource(src: string): number | null {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'rebase-flow-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'offender.ts'), src, 'utf8');
    return runGuard([dir]).status;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('check-rebase-conflict-flow guard (abort scope)', () => {
  it('passes against the real tree', () => {
    const { status, stdout } = runGuard([]);
    assert.strictEqual(status, 0, `guard should pass on a clean tree; stdout:\n${stdout}`);
  });

  it('fails on an abortRebase( call in a non-allow-listed file (has teeth)', () => {
    assert.strictEqual(
      checkSource('await this._rebaseService.abortRebase(repo);\n'),
      1,
      'an auto-abort call must fail the guard'
    );
  });

  it('fails on the rebaseAbort( spelling too (the GitService/BranchOps facade name)', () => {
    assert.strictEqual(
      checkSource('await this._gitService.rebaseAbort(repo).match();\n'),
      1,
      'both abort spellings are the same class'
    );
  });

  it('honours the rebase-abort-exempt marker on the preceding line', () => {
    assert.strictEqual(
      checkSource(
        '// rebase-abort-exempt: driven by an explicit user action in a test fixture\n' +
          'await this._rebaseService.abortRebase(repo);\n'
      ),
      0,
      'a justified abort must be allowed'
    );
    assert.strictEqual(
      checkSource(
        '// rebase-abort-exempt: orphaned-rebase recovery boundary\n' +
          'await this._gitService.rebaseAbort(repo).match();\n'
      ),
      0,
      'the marker covers the rebaseAbort spelling too'
    );
  });
});
