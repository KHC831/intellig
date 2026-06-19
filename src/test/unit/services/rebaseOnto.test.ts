/**
 * H-2 — rebase `--onto <newbase>` (IntelliJ git4idea GitRebaseDialog "Onto"
 * field parity).
 *
 * git4idea's GitRebaseDialog exposes an optional "Onto" new-base in addition
 * to the upstream: `git rebase --onto <newbase> <upstream>` rebases the
 * `<upstream>..HEAD` range onto a different base. `rebaseBranch` now accepts
 * an optional `newBase` in `IRebaseOptions`; when unset the argv is unchanged.
 *
 * These assert the exact argv emitted to git — `--onto <newbase>` lands
 * between the `rebase` subcommand and the `--end-of-options <upstream>` ref
 * guard, and a `-`/`.`-leading newbase is rejected at the service boundary so
 * a hostile ref can never be parsed as a flag.
 *
 * North-star: plugins/git4idea/src/git4idea/rebase/GitRebaseProcess.java +
 * GitRebaseDialog (the "Onto" / new-base field).
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

/** Push a `git --version` banner (consumed by the --update-refs guard). */
function scriptGitVersion(cli: ScriptedGitCli, banner = 'git version 2.50.1'): void {
  cli.scripted.push({ exitCode: 0, stdout: banner, stderr: '' });
}

describe('GitService.rebaseBranch — --onto newbase (H-2 git4idea GitRebaseDialog)', () => {
  it('splices --onto <newbase> before the --end-of-options upstream guard', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'origin/main', {
      newBase: 'feature',
    });
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--onto',
      'feature',
      '--end-of-options',
      'origin/main',
    ]);
  });

  it('combines --onto with an option flag, both before the ref guard', async () => {
    const cli = new ScriptedGitCli();
    // updateRefs triggers a `git --version` pre-flight guard; script a modern
    // banner so the flag passes through.
    scriptGitVersion(cli);
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'origin/main', {
      updateRefs: true,
      newBase: 'feature',
    });
    const rebaseCall = cli.executed.find((c) => c.args[0] === 'rebase');
    assert.ok(rebaseCall, 'a rebase should have been executed');
    assert.deepStrictEqual(rebaseCall.args, [
      'rebase',
      '--autostash',
      '--update-refs',
      '--onto',
      'feature',
      '--end-of-options',
      'origin/main',
    ]);
  });

  it('with --onto + --root, omits the upstream ref (rebase whole history onto newbase)', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'main', {
      root: true,
      newBase: 'feature',
    });
    // --root rebases from the root commit, so no upstream ref is passed; the
    // newbase is still the --onto target.
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--root',
      '--onto',
      'feature',
    ]);
  });

  it('rejects a `-`-leading newbase at the service boundary (no exec)', async () => {
    const cli = new ScriptedGitCli();
    await assert.rejects(
      () =>
        createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'main', { newBase: '-evil' }),
      /Invalid rebase newbase/
    );
    assert.strictEqual(cli.executed.length, 0, 'no git command runs for a hostile newbase');
  });

  it('rejects a `.`-leading newbase at the service boundary (no exec)', async () => {
    const cli = new ScriptedGitCli();
    await assert.rejects(
      () =>
        createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'main', { newBase: '.git' }),
      /Invalid rebase newbase/
    );
    assert.strictEqual(cli.executed.length, 0);
  });

  it('emits the bare autostash rebase when newBase is absent (legacy unchanged)', async () => {
    const cli = new ScriptedGitCli();
    scriptCleanRebase(cli);
    await createGitServiceWithCli(cli).rebaseBranch(createMockRepo(), 'origin/main', {});
    assert.deepStrictEqual(cli.executed[0].args, [
      'rebase',
      '--autostash',
      '--end-of-options',
      'origin/main',
    ]);
  });
});
