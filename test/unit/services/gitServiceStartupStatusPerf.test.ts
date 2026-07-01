/**
 * Startup-latency guard for repository discovery.
 *
 * `loadRepository` detects the repository state (idle / rebasing / merging /
 * cherry-picking / reverting) purely from the on-disk `.git` in-progress markers
 * — it does NOT run `git status`. A bare `git status` enumerates EVERY untracked
 * file by walking the whole working tree (5–10s on a large repo) and, because
 * repo discovery is on the critical path the graph load awaits, that walk stalls
 * the "Loading git graph…" view. Detecting state from markers avoids the
 * subprocess entirely.
 *
 * This test pins that: the discovery-time load never issues a `git status`.
 * Marker-based state detection itself is covered against real git in
 * `repositoryStateRealGit.test.ts`.
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync, ResultAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { GitError } from '../../../src/git-core/errors';
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

  getRepositoryRoot(path: string): ResultAsync<string | undefined, GitError> {
    return okAsync(path);
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

  it('discovery never issues a `git status` (state comes from .git markers, no untracked walk)', async () => {
    await gitService.getRepository(Uri.file('/test/repo'));

    const statuses = gitService['_gitCli'] as unknown as RecordingGitCli;
    const statusCalls = statuses.executedCommands
      .map((c) => c.args)
      .filter((a) => a.includes('status'));
    assert.strictEqual(
      statusCalls.length,
      0,
      `loadRepository must not run git status; got: ${statusCalls.map((a) => 'git ' + a.join(' ')).join(', ')}`
    );
  });
});
