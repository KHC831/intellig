/**
 * Tests for `GitService.rebaseBranch` non-conflict failure reporting.
 *
 * Original bug (PR fix/silent-rebase-error-surfacing): when `git rebase`
 * failed for a non-conflict reason (dirty working tree, in-progress rebase,
 * refs out of sync, etc.), `rebaseBranch` returned `{success:false,
 * conflicts:[]}` and threw away `stderr`. Callers had no way to surface the
 * underlying reason — the click looked like a no-op.
 *
 * The fix populates `failureReason` (sanitized) when exit != 0 and there are
 * no conflicting files. These tests pin that behavior.
 */

import * as assert from 'assert';
import { GitService } from '../../../git-core/GitService';
import { IRepository } from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

/**
 * Mock GitCli that returns scripted exec results so we can drive
 * `rebaseBranch` through each branch of its decision tree.
 */
class ScriptedGitCli {
  // Each entry is consumed in order by `exec`. The test pushes one entry
  // per call site (rebase, then optionally `status --porcelain`).
  public scripted: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  public executed: Array<{ args: string[] }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };

  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }

  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executed.push({ args: [...args] });
    const next = this.scripted.shift();
    if (!next) {
      throw new Error(`ScriptedGitCli ran out of scripted results at: git ${args.join(' ')}`);
    }
    return { ...next, combined: next.stdout + next.stderr };
  }

  async getRepositoryRoot(path: string): Promise<string | undefined> {
    return path;
  }

  dispose(): void {}
}

function createGitServiceWithCli(cli: ScriptedGitCli): GitService {
  const gitService = new GitService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (gitService as any)._gitCli = cli;
  return gitService;
}

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: undefined,
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

describe('GitService.rebaseBranch — failure-reason surfacing', () => {
  it('returns success=true when git exits 0', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.failureReason, undefined);
  });

  it('returns conflicts and NO failureReason when status reports unmerged files', async () => {
    const cli = new ScriptedGitCli();
    // 1. rebase fails
    cli.scripted.push({
      exitCode: 1,
      stdout: '',
      stderr: 'CONFLICT (content): Merge conflict in src/a.ts',
    });
    // 2. status --porcelain reports an unmerged file
    cli.scripted.push({ exitCode: 0, stdout: 'UU src/a.ts\n', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.conflicts, ['src/a.ts']);
    assert.strictEqual(
      result.failureReason,
      undefined,
      'failureReason must NOT be set when conflicts are present — the conflict path owns surfacing'
    );
  });

  it('populates failureReason from stderr when rebase fails without conflicts (regression: silent no-op)', async () => {
    const cli = new ScriptedGitCli();
    // 1. rebase fails because the working tree is dirty
    cli.scripted.push({
      exitCode: 1,
      stdout: '',
      stderr: 'error: cannot rebase: You have unstaged changes.\n',
    });
    // 2. status --porcelain reports no unmerged files (only modified)
    cli.scripted.push({ exitCode: 0, stdout: ' M README.md\n', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.conflicts, []);
    assert.ok(
      result.failureReason && result.failureReason.length > 0,
      'failureReason MUST be populated — the original bug was an empty result that callers silently dropped'
    );
    assert.ok(
      result.failureReason.includes('unstaged changes') ||
        result.failureReason.includes('cannot rebase'),
      `failureReason should preserve git's error text, got: "${result.failureReason ?? '<undef>'}"`
    );
  });

  it('falls back to stdout when stderr is empty', async () => {
    // Some git versions / wrappers put the reason on stdout.
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 1,
      stdout: 'It seems that there is already a rebase-merge directory\n',
      stderr: '',
    });
    cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.conflicts, []);
    assert.ok(
      result.failureReason && result.failureReason.includes('rebase-merge directory'),
      `failureReason should fall back to stdout, got: "${result.failureReason ?? '<undef>'}"`
    );
  });
});

describe('GitService.rebaseAbort — orphaned-rebase cleanup (Bug C.2)', () => {
  it('emits `git rebase --abort`', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    await gitService.rebaseAbort(createMockRepo());

    assert.strictEqual(cli.executed.length, 1, 'exactly one git invocation');
    assert.deepStrictEqual(
      cli.executed[0].args,
      ['rebase', '--abort'],
      'rebaseAbort must shell out to `git rebase --abort`'
    );
  });
});
