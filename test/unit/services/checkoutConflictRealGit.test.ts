/**
 * Real-git integration coverage for the checkout Result boundary (closes the
 * gotcha that only mock tests existed):
 *
 * When `checkout` became a FORWARD `ResultAsync<void, GitError>`, the worktree-
 * conflict classification done by the branch-context-menu handlers — which read
 * `error.message` for the "would be overwritten" / worktree-in-use markers —
 * MUST keep working. A real `git checkout` refusal produces a `GitCommandError`
 * whose message + combined output carry git's refusal text; `classifyGitCommandError`
 * preserves both on the resulting `CommandFailedError`, so the funnel
 * (`.match(() => undefined, (e) => { throw e; })`) re-throws an error the catch
 * arm can still classify, and the `.result.combined` duck-typed inspectors
 * (`combinedGitErrorText` / `isConflictError`) still see the output.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../../../src/git-core/GitService';
import { GitCli } from '../../../src/git-core/gitCli';
import { CommandFailedError } from '../../../src/git-core/errors';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function repoFor(p: string): IRepository {
  return { rootUri: Uri.file(p) } as unknown as IRepository;
}

describe('checkout — dirty-tree conflict classification (real git)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let gitService: GitService;
  let repo: IRepository;

  beforeEach(async () => {
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-conflict-'));
    gitCli = new GitCli();
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    await gitCli.exec(['config', 'user.name', 'Test User'], { cwd: repoPath });

    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;
    repo = repoFor(repoPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // best-effort tempdir cleanup
    }
  });

  it('a "would be overwritten" checkout refusal surfaces a typed CommandFailedError whose message + combined carry the marker', async () => {
    const file = path.join(repoPath, 'f.txt');

    // main: f.txt = "base"
    fs.writeFileSync(file, 'base\n');
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', 'base'], { cwd: repoPath });

    // feature: f.txt = "feature-version"
    await gitCli.exec(['checkout', '-b', 'feature'], { cwd: repoPath });
    fs.writeFileSync(file, 'feature-version\n');
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', 'feature change'], { cwd: repoPath });

    // back on main, leave an uncommitted edit that switching to feature
    // would clobber — git refuses the checkout.
    await gitCli.exec(['checkout', 'main'], { cwd: repoPath });
    fs.writeFileSync(file, 'uncommitted local edit\n');

    const result = await gitService.checkout(repo, 'feature');

    assert.ok(result.isErr(), 'a dirty-tree-conflicting checkout must surface an Err, not Ok');
    const error = result._unsafeUnwrapErr();
    assert.ok(
      error instanceof CommandFailedError,
      `expected a CommandFailedError; got ${error.constructor.name}`
    );
    // The branch-context-menu handlers classify off error.message — git's
    // refusal text must survive into it.
    assert.match(
      error.message,
      /would be overwritten/i,
      'error.message must carry git\'s "would be overwritten" refusal so the handler classifies it'
    );
    // The `.combined` duck-typed inspectors must still see the output.
    assert.ok(error.result, 'CommandFailedError must carry the original result');
    assert.match(
      error.result.combined,
      /would be overwritten/i,
      'result.combined must preserve the refusal text for combinedGitErrorText / isConflictError'
    );

    // The working tree was NOT switched — HEAD is still main.
    const head = (
      await gitCli.exec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath })
    ).stdout.trim();
    assert.strictEqual(head, 'main', 'a refused checkout must leave HEAD on the original branch');
  });
});
