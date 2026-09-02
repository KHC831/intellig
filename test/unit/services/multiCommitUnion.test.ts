/**
 * getMultiCommitDiff scopes the combined diff to the SELECTED commits'
 * touched paths — a non-contiguous selection must not surface files that only
 * an unselected intermediate commit changed (IntelliJ unions per-commit change
 * lists; the range A^..C would otherwise include B).
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { literalPathspec } from '../../../src/git-core/gitCli';
import { pathspecTarget } from '../../helpers/pathspec';

interface ExecCall {
  args: string[];
}

function makeRepo(): IRepository {
  return { rootUri: Uri.file('/repo') } as unknown as IRepository;
}

/**
 * GitService with a scripted CLI covering the multi-commit diff flow:
 *   - A (newest) touches a.ts; C (oldest) touches c.ts; B (unselected) touched b.ts.
 *   - Only A and C are selected.
 */
function installGitService(): { gitService: GitService; calls: ExecCall[] } {
  const gitService = new GitService();
  const calls: ExecCall[] = [];
  const cli = {
    onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
    exec: async (args: string[]) => {
      calls.push({ args });
      const key = args.join(' ');
      // Commit date + parents (%cI\t%P).
      if (args[0] === 'show' && args[2] === '--format=%cI%x09%P') {
        const hash = args[args.length - 1];
        const date = hash === 'A' ? '2024-01-15T00:00:00Z' : '2024-01-05T00:00:00Z';
        return { exitCode: 0, stdout: `${date}\tp`, stderr: '', combined: '' };
      }
      // Touched-path collection per commit.
      if (args.includes('--name-only')) {
        const hash = args[args.length - 1];
        const touched = hash === 'A' ? 'a.ts\0' : 'c.ts\0';
        return { exitCode: 0, stdout: touched, stderr: '', combined: '' };
      }
      // Parent of the oldest (C).
      if (args[0] === 'rev-parse') {
        return { exitCode: 0, stdout: 'baseSha', stderr: '', combined: '' };
      }
      // The final range diff — if scoped correctly it is limited to a.ts + c.ts.
      // git's own diff header always names the real file, regardless of the
      // pathspec magic used to select it — so the mock resolves each arg back
      // to its target the way real git would, not the literal wire form.
      if (args[0] === 'diff') {
        const sep = args.indexOf('--');
        const paths = sep >= 0 ? args.slice(sep + 1).map(pathspecTarget) : [];
        // Emit a diff block for each requested path (proving scoping is applied).
        const blocks = paths
          .map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-x\n+y\n`)
          .join('');
        return { exitCode: 0, stdout: blocks, stderr: '', combined: '' };
      }
      void key;
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  };
  (gitService as unknown as { _gitCli: unknown })._gitCli = cli;
  return { gitService, calls };
}

describe('getMultiCommitDiff — selected-commit union scoping', () => {
  it("scopes the range diff to the selected commits' touched paths (excludes B)", async () => {
    const { gitService, calls } = installGitService();
    const diffs = await gitService.getMultiCommitDiff(makeRepo(), ['A', 'C']);

    const paths = diffs.map((d) => d.path).sort();
    assert.deepStrictEqual(paths, ['a.ts', 'c.ts'], 'only selected-commit files appear');
    assert.ok(
      !paths.includes('b.ts'),
      'a file only the unselected commit touched must be excluded'
    );

    // The final diff must carry the `-- <paths>` scope, each wrapped literal so
    // a touched path holding pathspec-magic characters can't also match an
    // unselected neighbour (PATH_SLOT_KIND['diff'] = 'pathspec').
    const diff = calls.find((c) => c.args[0] === 'diff');
    assert.ok(diff, 'a diff must run');
    const sep = diff.args.indexOf('--');
    assert.ok(sep >= 0, 'the diff must be path-scoped behind --');
    assert.deepStrictEqual(
      [...diff.args.slice(sep + 1)].sort(),
      [literalPathspec('a.ts'), literalPathspec('c.ts')].sort()
    );
  });
});
