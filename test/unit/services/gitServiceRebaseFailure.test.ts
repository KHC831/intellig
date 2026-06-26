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
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
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
  it('returns success=true when git exits 0 and the tree has no unmerged files', async () => {
    const cli = new ScriptedGitCli();
    // 1. rebase succeeds
    cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' });
    // 2. status --porcelain reports a clean tree (autostash re-applied cleanly)
    cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.failureReason, undefined);
  });

  it('reports an exit-0 autostash pop conflict as a non-continuable conflict (rebaseInProgress:false)', async () => {
    const cli = new ScriptedGitCli();
    // 1. rebase replays cleanly and exits 0, but re-applying the autostash
    //    collided with the rebased changes. Because git exits 0, the rebase is
    //    already complete and NO rebase is in progress — `rebase --continue`
    //    would dead-end on "no rebase in progress".
    cli.scripted.push({
      exitCode: 0,
      stdout: 'Applying autostash resulted in conflicts.',
      stderr: '',
    });
    // 2. status --porcelain reports the unmerged file left by the failed pop.
    cli.scripted.push({ exitCode: 0, stdout: 'UU src/a.ts\n', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, false);
    // The resolve dialog still opens and lists the files, so `conflicts` is
    // populated in both cases — only continuability differs.
    assert.deepStrictEqual(result.conflicts, ['src/a.ts']);
    assert.strictEqual(
      result.rebaseInProgress,
      false,
      'a completed-rebase autostash pop conflict is NOT continuable — continue/abort must not be offered'
    );
    assert.strictEqual(result.failureReason, undefined);
  });

  it('reports an add/add (AA) exit-0 autostash pop conflict as non-continuable', async () => {
    // An autostash pop that re-adds a path the rebased commits also added
    // leaves an `AA` (both-added) unmerged entry, not `UU`. git still exits 0.
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 0,
      stdout: 'Applying autostash resulted in conflicts.',
      stderr: '',
    });
    cli.scripted.push({ exitCode: 0, stdout: 'AA src/added.ts\n', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.conflicts, ['src/added.ts']);
    assert.strictEqual(result.rebaseInProgress, false);
    assert.strictEqual(result.failureReason, undefined);
  });

  it('reads conflicts with status --porcelain -z and reports a non-ASCII conflicted path verbatim', async () => {
    // End-to-end through the conflict-detection call site: the status probe must
    // use -z so a unicode filename comes back verbatim (the default newline
    // format C-quotes it to `"caf\303\251.ts"`, pointing the resolve flow at no
    // file). NUL-terminated stdout mirrors real `-z` output.
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 0,
      stdout: 'Applying autostash resulted in conflicts.',
      stderr: '',
    });
    cli.scripted.push({ exitCode: 0, stdout: 'UU café.ts\0', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.deepStrictEqual(result.conflicts, ['café.ts'], 'unicode path returned verbatim');
    const statusCall = cli.executed.find((c) => c.args[0] === 'status');
    assert.ok(statusCall, 'a status probe should run');
    assert.ok(
      statusCall.args.includes('-z'),
      `conflict-detection status must pass -z; got: ${statusCall.args.join(' ')}`
    );
  });

  it('reports a delete/delete (DD) exit-0 autostash pop conflict as non-continuable', async () => {
    // Symmetric to the add/add case: a both-deleted unmerged entry (`DD`)
    // must also be treated as a non-continuable conflict on the zero-exit path.
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 0,
      stdout: 'Applying autostash resulted in conflicts.',
      stderr: '',
    });
    cli.scripted.push({ exitCode: 0, stdout: 'DD src/gone.ts\n', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.conflicts, ['src/gone.ts']);
    assert.strictEqual(result.rebaseInProgress, false);
    assert.strictEqual(result.failureReason, undefined);
  });

  it('reports a non-zero-exit unmerged result as a continuable conflict (rebaseInProgress:true)', async () => {
    // A mid-replay conflict makes `git rebase` exit NON-zero with a live rebase
    // still in progress (rebase-merge present). That case IS continuable, so it
    // must mark rebaseInProgress:true so callers offer continue/abort.
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 1,
      stdout: '',
      stderr: 'CONFLICT (content): Merge conflict in src/a.ts',
    });
    cli.scripted.push({ exitCode: 0, stdout: 'UU src/a.ts\n', stderr: '' });

    const gitService = createGitServiceWithCli(cli);
    const result = await gitService.rebaseBranch(createMockRepo(), 'origin/main');

    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.conflicts, ['src/a.ts']);
    assert.strictEqual(
      result.rebaseInProgress,
      true,
      'a continuable mid-rebase conflict must mark rebaseInProgress:true'
    );
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
