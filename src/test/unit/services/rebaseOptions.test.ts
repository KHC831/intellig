/**
 * P2 — rebase options (IntelliJ git4idea GitRebaseOption parity).
 *
 * git4idea's options popup (`GitRebaseOption.kt` / `REBASE_FLAGS`) lets the
 * user pass `--rebase-merges`, `--keep-empty`, `--root`, `--update-refs`, and
 * `--autosquash` to a non-interactive rebase. We had only the bare
 * `git rebase <onto>`. `rebaseBranch` now accepts an optional `IRebaseOptions`
 * and splices the corresponding flags; legacy callers (no options) are
 * unchanged.
 *
 * These assert the exact argv emitted to git — the flags must land between the
 * `rebase` subcommand and the `--end-of-options <onto>` ref guard, never after
 * it (a flag after `--end-of-options` would be treated as a path).
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../git-core/GitService';
import { IRepository } from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

class ScriptedGitCli {
  public scripted: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  public executed: Array<{ args: string[] }> = [];

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

/** Push a clean rebase (exit 0) + clean status, so rebaseBranch returns ok. */
function scriptCleanRebase(cli: ScriptedGitCli): void {
  cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' }); // rebase
  cli.scripted.push({ exitCode: 0, stdout: '', stderr: '' }); // status --porcelain
}

describe('GitService.rebaseBranch — options (#P2 git4idea GitRebaseOption)', () => {
  it('emits the bare autostash rebase when no options are given (legacy unchanged)', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'origin/main');
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--end-of-options',
      'origin/main',
    ]);
  });

  it('splices --rebase-merges before the ref guard', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'origin/main', {
      rebaseMerges: true,
    });
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--rebase-merges',
      '--end-of-options',
      'origin/main',
    ]);
  });

  it('combines update-refs + autosquash + keep-empty in git4idea declaration order', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'feature', {
      keepEmpty: true,
      updateRefs: true,
      autosquash: true,
    });
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--keep-empty',
      '--update-refs',
      '--autosquash',
      '--end-of-options',
      'feature',
    ]);
  });

  it('with --root, omits the onto ref (git4idea disables the upstream field)', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'main', { root: true });
    // --root rebases from the root commit; no upstream/onto ref is passed.
    assert.deepStrictEqual(cli.executed[0].args, ['rebase', '--autostash', '--root']);
  });

  it('still returns success on a clean rebase with options', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    const result = await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'main', {
      rebaseMerges: true,
    });
    assert.strictEqual(result.success, true);
  });
});
