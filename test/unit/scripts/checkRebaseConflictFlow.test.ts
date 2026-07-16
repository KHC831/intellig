/**
 * Companion spec for scripts/check-rebase-conflict-flow.sh.
 *
 * Proves the guard (a) passes against the real tree (allow-listed
 * user-action surfaces + the two justified orphaned-rebase recovery sites),
 * (b) has teeth on both checks — an `abortRebase(`/`rebaseAbort(` call in a
 * non-allow-listed file, and an `executeRebase(` call outside the
 * `_runHistoryRewrite` runner (a fifth skeleton) — and (c) honours the two
 * escape-hatch markers. Explicit-path mode treats every given file as
 * non-allow-listed, which is what lets these fixtures exercise the teeth.
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

const RUNNER_WITH_EXECUTE = [
  'class C {',
  '  private async _runHistoryRewrite(repo: IRepository): Promise<void> {',
  '    const result = await this._rebaseService.executeRebase(repo);',
  '  }',
  '}',
  '',
].join('\n');

describe('check-rebase-conflict-flow guard', () => {
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

  it('fails on an executeRebase( call outside _runHistoryRewrite (no fifth skeleton)', () => {
    assert.strictEqual(
      checkSource(
        'class C {\n' +
          '  private async _handleNewFlow(repo: IRepository): Promise<void> {\n' +
          '    const result = await this._rebaseService.executeRebase(repo);\n' +
          '  }\n' +
          '}\n'
      ),
      1,
      'a hand-rolled execute outside the runner must fail'
    );
  });

  it('passes the executeRebase( call inside the _runHistoryRewrite runner', () => {
    assert.strictEqual(
      checkSource(RUNNER_WITH_EXECUTE),
      0,
      'the runner is the single sanctioned execute site'
    );
  });

  it('scope ends at the next class member — an execute after the runner still fails', () => {
    assert.strictEqual(
      checkSource(
        'class C {\n' +
          '  private async _runHistoryRewrite(repo: IRepository): Promise<void> {\n' +
          '    const result = await this._rebaseService.executeRebase(repo);\n' +
          '  }\n' +
          '  private async _another(repo: IRepository): Promise<void> {\n' +
          '    await this._rebaseService.executeRebase(repo);\n' +
          '  }\n' +
          '}\n'
      ),
      1,
      'the runner scope must not leak past the next member'
    );
  });

  it('honours the history-rewrite-exempt marker on the preceding line', () => {
    assert.strictEqual(
      checkSource(
        '// history-rewrite-exempt: exercised by a scripted migration, not a user flow\n' +
          'await this._rebaseService.executeRebase(repo);\n'
      ),
      0,
      'a justified out-of-runner execute must be allowed'
    );
  });
});
