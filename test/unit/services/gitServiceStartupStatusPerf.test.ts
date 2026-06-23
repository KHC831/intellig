/**
 * Startup-latency guard for repository discovery.
 *
 * `loadRepository` runs a `git status` purely to detect the repository state
 * (idle / rebasing / merging / cherry-picking / reverting) via
 * `parseRepositoryState`, which only reads status *header* lines. A bare
 * `git status` also enumerates EVERY untracked file by walking the whole
 * working tree — on a large repo that walk takes 5–10s and, because repo
 * discovery is on the critical path the graph load awaits, it stalls the
 * "Loading git graph…" view for that whole time.
 *
 * The state probe must therefore suppress untracked enumeration
 * (`--untracked-files=no`). These tests pin that: the discovery-time status
 * call never runs a bare `git status`, and state detection still works because
 * the rebase/merge/etc. header lines are unaffected by the untracked flag.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { Uri } from '../../mocks/vscode';

class RecordingGitCli {
  public executedCommands: { args: string[]; options: unknown }[] = [];
  private _byPrefix = new Map<string, { exitCode: number; stdout: string; stderr: string }>();

  setByPrefix(prefix: string, r: { exitCode: number; stdout: string; stderr: string }): void {
    this._byPrefix.set(prefix, r);
  }

  async exec(
    args: string[],
    options: unknown
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executedCommands.push({ args, options });
    const key = args.join(' ');
    for (const [needle, r] of this._byPrefix) {
      if (key.includes(needle)) {
        return { ...r, combined: r.stdout + r.stderr };
      }
    }
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  async getRepositoryRoot(path: string): Promise<string | undefined> {
    return path;
  }

  dispose(): void {}
}

describe('GitService startup — repository state probe avoids the untracked-file walk', () => {
  let gitService: GitService;
  let cli: RecordingGitCli;

  beforeEach(() => {
    gitService = new GitService();
    cli = new RecordingGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = cli;
    cli.setByPrefix('symbolic-ref HEAD', {
      exitCode: 0,
      stdout: 'refs/heads/main\n',
      stderr: '',
    });
    cli.setByPrefix('rev-parse HEAD', { exitCode: 0, stdout: 'abc123\n', stderr: '' });
  });

  afterEach(() => {
    gitService.dispose();
  });

  function statusCalls(): string[][] {
    return cli.executedCommands.map((c) => c.args).filter((a) => a.includes('status'));
  }

  it('discovery never issues a bare `git status` (the full untracked-file walk)', async () => {
    await gitService.getRepository(Uri.file('/test/repo'));

    const statuses = statusCalls();
    assert.ok(statuses.length > 0, 'expected a state-probe status call during discovery');
    for (const args of statuses) {
      assert.ok(
        args.includes('--untracked-files=no'),
        `state-probe status must suppress untracked enumeration; got: git ${args.join(' ')}`
      );
      assert.notDeepStrictEqual(args, ['status'], 'a bare `git status` walks the whole work tree');
    }
  });

  it('still detects a non-idle state from the status header with untracked suppressed', async () => {
    cli.setByPrefix('status', {
      exitCode: 0,
      stdout: 'interactive rebase in progress; onto deadbeef\n',
      stderr: '',
    });

    const repo = await gitService.getRepository(Uri.file('/test/repo'));
    assert.ok(repo, 'repository should load');
    assert.strictEqual(repo.state, 'rebasing', 'state header still parsed with -uno');
  });
});
