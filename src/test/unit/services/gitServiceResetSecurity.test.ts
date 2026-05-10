/**
 * SR-3 security coverage for `GitService.resetToCommit`.
 *
 * The method is the argv-construction boundary for `git reset`; a ref that
 * starts with `-` would be parsed by git itself as a CLI flag (e.g.
 * `git reset --mixed -foo` becomes `git reset --mixed -f oo`), bypassing
 * the spawn-argv defense. The method must reject such inputs before
 * invoking the CLI.
 */

import * as assert from 'assert';
import { GitService } from '../../../services/GitService';
import { IRepository, ResetMode } from '../../../services/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

class CountingGitCli {
  public readonly calls: { args: string[] }[] = [];
  async exec(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.calls.push({ args });
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }
  get onCommandExecuted(): () => { dispose: () => void } {
    return (): { dispose: () => void } => ({ dispose: (): void => {} });
  }
  dispose(): void {
    // no-op — match GitCli.dispose so GitService.dispose() doesn't crash.
  }
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/tmp/repo'),
    state: 'idle',
    head: { name: 'main', commit: 'abc123', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

describe('GitService.resetToCommit — SR-3 ref validation', () => {
  let gitService: GitService;
  let cli: CountingGitCli;

  beforeEach(() => {
    gitService = new GitService();
    cli = new CountingGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = cli;
  });

  afterEach(() => {
    gitService.dispose();
  });

  const rejectedTargets = ['-foo', '-x/y', '-.main', '-', '-HEAD', '.hidden'];
  for (const target of rejectedTargets) {
    it(`rejects dangerous target "${target}" and does not spawn git`, async () => {
      await assert.rejects(
        () => gitService.resetToCommit(makeRepo(), target, 'mixed' as ResetMode),
        /Invalid reset target/
      );
      assert.strictEqual(cli.calls.length, 0, 'git exec must not run on invalid ref');
    });
  }

  const acceptedTargets = [
    'main',
    'feature/x',
    'v1.0.0',
    'HEAD~1',
    'a'.repeat(40), // sha1
    'refs/heads/release-1.0',
  ];
  for (const target of acceptedTargets) {
    it(`accepts normal target "${target}" and invokes git reset --<mode> <target>`, async () => {
      await gitService.resetToCommit(makeRepo(), target, 'mixed' as ResetMode);
      assert.strictEqual(cli.calls.length, 1);
      assert.deepStrictEqual(cli.calls[0].args, ['reset', '--mixed', target]);
    });
  }
});
