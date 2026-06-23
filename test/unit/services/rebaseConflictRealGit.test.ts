/**
 * Real-git integration coverage for the rebase/conflict/pull correctness fixes
 * (closes the gap where only mock/argv-shape tests existed):
 *
 *  (a) H1 — the multi-commit rebase-continue loop: a real rebase that stops at
 *      successive conflicts. `rebaseContinue` must return the NEXT commit's
 *      conflicts as data (not throw) so the Resolve dialog can re-populate, and
 *      finally report success once every stop is resolved.
 *  (b) M4 — a real conflicting pull: the thrown `GitCommandError` carries the
 *      "CONFLICT"/"Automatic merge failed" marker (on stdout/combined), and
 *      `isConflictError` classifies it as a conflict so the Resolve flow opens.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../../../src/git-core/GitService';
import { GitCli } from '../../../src/git-core/gitCli';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { isConflictError } from '../../../src/sync/PullDialog';
import { Uri } from '../../mocks/vscode';

function repoFor(p: string): IRepository {
  return { rootUri: Uri.file(p) } as unknown as IRepository;
}

describe('rebaseContinue — multi-commit conflict loop (real git, H1)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let gitService: GitService;
  let repo: IRepository;
  let savedSeqEditor: string | undefined;
  let savedEditor: string | undefined;

  async function git(...args: string[]): Promise<string> {
    return (await gitCli.exec(args, { cwd: repoPath })).stdout.trim();
  }

  async function commit(content: string, message: string): Promise<void> {
    fs.writeFileSync(path.join(repoPath, 'f.txt'), content);
    await gitCli.exec(['add', '.'], { cwd: repoPath });
    await gitCli.exec(['commit', '-m', message], { cwd: repoPath });
  }

  beforeEach(async () => {
    savedSeqEditor = process.env.GIT_SEQUENCE_EDITOR;
    savedEditor = process.env.GIT_EDITOR;
    process.env.GIT_SEQUENCE_EDITOR = 'true';
    process.env.GIT_EDITOR = 'true';

    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-continue-loop-'));
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
    process.env.GIT_SEQUENCE_EDITOR = savedSeqEditor;
    process.env.GIT_EDITOR = savedEditor;
    if (savedSeqEditor === undefined) {
      delete process.env.GIT_SEQUENCE_EDITOR;
    }
    if (savedEditor === undefined) {
      delete process.env.GIT_EDITOR;
    }
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it('reports conflicts at each successive commit then succeeds once all are resolved', async () => {
    // base on main, two feature commits that both touch the same line, and a
    // diverging main change → rebasing feature onto main stops twice.
    await commit('base\n', 'A');
    await git('checkout', '-b', 'feature');
    await commit('B\n', 'B');
    await commit('C\n', 'C');
    await git('checkout', 'main');
    await commit('main\n', 'M');
    await git('checkout', 'feature');

    // First stop: commit B conflicts.
    const start = await gitService.rebaseBranch(repo, 'main');
    assert.strictEqual(start.success, false, 'rebase should stop at the first conflict');
    assert.deepStrictEqual(start.conflicts, ['f.txt'], 'B should conflict in f.txt');
    assert.strictEqual(start.rebaseInProgress, true, 'a live rebase remains (continuable)');

    // Resolve + continue → second stop: commit C conflicts. The KEY H1 path —
    // rebaseContinue must NOT throw on the expected non-zero; it returns the
    // next conflicts as data.
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'resolved-B\n');
    await gitCli.exec(['add', 'f.txt'], { cwd: repoPath });
    const cont1 = await gitService.rebaseContinue(repo);
    assert.strictEqual(cont1.success, false, 'rebase should stop again at C');
    assert.deepStrictEqual(cont1.conflicts, ['f.txt'], 'C should conflict in f.txt');
    assert.strictEqual(cont1.rebaseInProgress, true, 'still a live rebase');

    // Resolve + continue → done.
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'resolved-C\n');
    await gitCli.exec(['add', 'f.txt'], { cwd: repoPath });
    const cont2 = await gitService.rebaseContinue(repo);
    assert.strictEqual(cont2.success, true, 'rebase should complete after the last resolution');

    // No rebase left in progress; feature is the current branch again.
    assert.strictEqual(
      fs.existsSync(path.join(repoPath, '.git', 'rebase-merge')),
      false,
      'rebase metadata must be gone after a clean completion'
    );
  });
});

describe('isConflictError — real conflicting pull (M4)', () => {
  let originPath: string;
  let localPath: string;
  let gitCli: GitCli;
  let gitService: GitService;

  async function commitIn(cwd: string, content: string, message: string): Promise<void> {
    fs.writeFileSync(path.join(cwd, 'f.txt'), content);
    await gitCli.exec(['add', '.'], { cwd });
    await gitCli.exec(['commit', '-m', message], { cwd });
  }

  beforeEach(async () => {
    gitCli = new GitCli();
    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;

    originPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-origin-'));
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: originPath });
    await gitCli.exec(['config', 'user.email', 'o@e.com'], { cwd: originPath });
    await gitCli.exec(['config', 'user.name', 'Origin'], { cwd: originPath });
    await commitIn(originPath, 'base\n', 'base');

    // Clone origin → local.
    localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-local-'));
    await gitCli.exec(['clone', originPath, localPath], { cwd: os.tmpdir() });
    await gitCli.exec(['config', 'user.email', 'l@e.com'], { cwd: localPath });
    await gitCli.exec(['config', 'user.name', 'Local'], { cwd: localPath });
    // Default pull strategy = merge, so a divergent pull produces a merge
    // conflict (not git's "need to reconcile" refusal). Mirrors a plain
    // non-rebase pull in the dialog.
    await gitCli.exec(['config', 'pull.rebase', 'false'], { cwd: localPath });

    // Diverge the same line in both repos → a pull will conflict.
    await commitIn(originPath, 'origin-change\n', 'origin change');
    await commitIn(localPath, 'local-change\n', 'local change');
  });

  afterEach(() => {
    for (const p of [originPath, localPath]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  });

  it('a conflicting `git pull` throws an error that isConflictError classifies as a conflict', async () => {
    const result = await gitService.pull(repoFor(localPath), { remote: 'origin', branch: 'main' });
    assert.ok(result.isErr(), 'a diverging pull must yield an Err');
    const thrown: unknown = result._unsafeUnwrapErr();

    // The exact M4 contract: the classifier inspects the COMBINED output, so a
    // real conflicting pull routes to the Resolve flow instead of a generic
    // "Failed to pull" toast.
    assert.strictEqual(
      isConflictError(thrown),
      true,
      `real pull conflict must classify as a conflict; error: ${String(thrown)}`
    );
  });
});
