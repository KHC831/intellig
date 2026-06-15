/**
 * P2 — Find merged local branches (IntelliJ git4idea
 * FindMergedLocalBranchesAction / CleanupBranchesDialog parity).
 *
 * `getMergedBranches(repo, into?)` lists local branches fully merged into the
 * target (default HEAD) — the primitive behind "Clean Up Feature Branches".
 * It runs `git branch --merged <target>` and returns plain branch names,
 * EXCLUDING the current branch (the `*`-marked line — you can't delete the
 * branch you're on) and any detached-HEAD `(HEAD detached …)` line.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../git-core/GitService';
import { IRepository } from '../../../git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

class ScriptedGitCli {
  public scripted: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  public executed: Array<{ args: string[] }> = [];
  private _onCommandExecuted = { event: (): { dispose: () => void } => ({ dispose: () => {} }) };
  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }
  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executed.push({ args: [...args] });
    const next = this.scripted.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
    return { ...next, combined: next.stdout + next.stderr };
  }
  async getRepositoryRoot(p: string): Promise<string | undefined> {
    return p;
  }
  dispose(): void {}
}

function makeService(cli: ScriptedGitCli): GitService {
  const s = new GitService();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
  (s as any)._gitCli = cli;
  return s;
}

const repo = { rootUri: Uri.file('/test/repo') } as unknown as IRepository;

describe('GitService.getMergedBranches (#P2 find merged branches)', () => {
  it('runs `git branch --merged` against HEAD by default', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({ exitCode: 0, stdout: '  feature-a\n  feature-b\n', stderr: '' });
    await makeService(cli).getMergedBranches(repo);
    assert.deepStrictEqual(cli.executed[0].args, [
      'branch',
      '--merged',
      '--end-of-options',
      'HEAD',
    ]);
  });

  it('targets an explicit ref when given', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({ exitCode: 0, stdout: '  old\n', stderr: '' });
    await makeService(cli).getMergedBranches(repo, 'main');
    assert.deepStrictEqual(cli.executed[0].args, [
      'branch',
      '--merged',
      '--end-of-options',
      'main',
    ]);
  });

  it('returns trimmed names and EXCLUDES the current (*) branch', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 0,
      stdout: '* main\n  feature-a\n  feature-b\n',
      stderr: '',
    });
    const merged = await makeService(cli).getMergedBranches(repo);
    assert.deepStrictEqual(merged, ['feature-a', 'feature-b']);
  });

  it('ignores a detached-HEAD line', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 0,
      stdout: '* (HEAD detached at abc1234)\n  feature-a\n',
      stderr: '',
    });
    const merged = await makeService(cli).getMergedBranches(repo);
    assert.deepStrictEqual(merged, ['feature-a']);
  });

  it('returns [] on git failure (e.g. bad ref) rather than throwing', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({ exitCode: 1, stdout: '', stderr: 'fatal: malformed object name' });
    assert.deepStrictEqual(await makeService(cli).getMergedBranches(repo, 'nope'), []);
  });

  it('rejects a target that looks like a flag (argv-injection guard)', async () => {
    const cli = new ScriptedGitCli();
    await assert.rejects(async () => makeService(cli).getMergedBranches(repo, '--all'), /invalid/i);
  });
});
