/**
 * Tests for `GitService.getCommitDiff` against merge commits — Bug A.
 *
 * `git show <merge-hash> --format=` emits combined-diff output: `diff --cc
 * <path>` headers (no a/…b/ prefixes) and `@@@` hunks. Before the parseDiff
 * fix, the splitter keyed on `^diff --git ` so the entire combined block was
 * an unsplittable chunk whose `--cc` header failed the path match — parseDiff
 * returned `[]` and the details panel showed "No changed files" for every
 * merge commit, even though GitHub's PR view shows the diff fine.
 *
 * This integration test drives `getCommitDiff` through a scripted GitCli that
 * returns realistic combined-diff stdout and asserts the file list is
 * non-empty with correctly extracted paths.
 *
 * Harness pattern mirrors `gitServiceRebaseFailure.test.ts` (ScriptedGitCli).
 */

import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

/**
 * Mock GitCli that returns a single scripted exec result. `getCommitDiff`
 * issues exactly one `git show` call, so one scripted entry suffices.
 */
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

describe('GitService.getCommitDiff — merge commit (combined diff)', () => {
  it('returns a non-empty file list for a single-file merge commit', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 0,
      stdout: `diff --cc src/branches/BranchContextMenuCommands.ts
index 1234567,abcdefg..fedcba9
--- a/src/branches/BranchContextMenuCommands.ts
+++ b/src/branches/BranchContextMenuCommands.ts
@@@ -10,3 -10,5 +10,4 @@@
  context
- removed-from-ours
 -removed-from-theirs
++resolved-by-merge
  context
`,
      stderr: '',
    });

    const gitService = createGitServiceWithCli(cli);
    const diffs = await gitService.getCommitDiff(createMockRepo(), '90295aa');

    assert.ok(diffs.length > 0, 'merge commit diff must not be empty (was "No changed files")');
    assert.strictEqual(diffs.length, 1);
    assert.strictEqual(diffs[0].path, 'src/branches/BranchContextMenuCommands.ts');
    assert.strictEqual(diffs[0].status, 'modified');
  });

  it('extracts every path from a multi-file merge commit', async () => {
    const cli = new ScriptedGitCli();
    cli.scripted.push({
      exitCode: 0,
      stdout: `diff --cc src/git-core/GitService.ts
index 1111111,2222222..3333333
--- a/src/git-core/GitService.ts
+++ b/src/git-core/GitService.ts
@@@ -1,2 -1,2 +1,2 @@@
  context
++merged-a
diff --cc src/git-core/interfaces/IGitService.ts
index 4444444,5555555..6666666
--- a/src/git-core/interfaces/IGitService.ts
+++ b/src/git-core/interfaces/IGitService.ts
@@@ -1,2 -1,2 +1,2 @@@
  context
++merged-b
diff --cc test/unit/branchContextMenuErrors.test.ts
index 7777777,8888888..9999999
--- a/test/unit/branchContextMenuErrors.test.ts
+++ b/test/unit/branchContextMenuErrors.test.ts
@@@ -1,2 -1,2 +1,2 @@@
  context
++merged-c
`,
      stderr: '',
    });

    const gitService = createGitServiceWithCli(cli);
    const diffs = await gitService.getCommitDiff(createMockRepo(), 'deadbeef');

    assert.deepStrictEqual(
      diffs.map((d) => d.path),
      [
        'src/git-core/GitService.ts',
        'src/git-core/interfaces/IGitService.ts',
        'test/unit/branchContextMenuErrors.test.ts',
      ]
    );
  });
});
