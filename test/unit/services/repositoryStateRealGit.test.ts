/**
 * Real-git coverage for repository-state detection.
 *
 * `loadRepository` must classify the in-progress operation from the
 * language-independent `.git` marker files (MERGE_HEAD / CHERRY_PICK_HEAD /
 * REVERT_HEAD / rebase dirs), not from `git status` prose. Two cases the prose
 * gets wrong:
 *
 *   1. A merge whose conflicts are all resolved-but-not-committed prints
 *      "All conflicts fixed but you are still merging." — which contains neither
 *      "merge in progress" nor "you have unmerged paths", so the text parser
 *      falls through to `idle`. MERGE_HEAD is still present, so the state is
 *      genuinely `merging`; misreporting `idle` dead-ends the Resolve dialog's
 *      Continue affordance.
 *   2. `git status` prose is localized. Under a non-English git locale the
 *      cherry-pick/merge/revert header phrases don't match, so state parses as
 *      `idle` and the conflict dialog picks the wrong ours/theirs reversal. The
 *      marker file NAMES are never localized, so marker-based detection is
 *      correct in any locale. (We can't install a non-English git locale in CI,
 *      so case 1 is the machine-reproducible proof that markers must win over
 *      the prose; the mechanism it exercises fixes both.)
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../../../src/git-core/GitService';
import { GitCli } from '../../../src/git-core/gitCli';
import { Uri } from '../../mocks/vscode';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const TMP_ROOT = SCRATCH_ROOT;

describe('loadRepository — state from .git markers (real git)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let gitService: GitService;

  async function git(...args: string[]): Promise<{ exitCode: number; stdout: string }> {
    const r = await gitCli.exec(args, { cwd: repoPath });
    return { exitCode: r.exitCode, stdout: r.stdout };
  }

  async function commit(content: string, message: string): Promise<void> {
    fs.writeFileSync(path.join(repoPath, 'f.txt'), content);
    await git('add', '.');
    await git('commit', '-m', message);
  }

  beforeEach(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    repoPath = fs.mkdtempSync(path.join(TMP_ROOT, 'repo-state-'));
    gitCli = new GitCli();
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test User');
    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;
  });

  afterEach(() => {
    gitService.dispose();
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it("reports 'merging' for an all-resolved-but-uncommitted merge (status prose says idle)", async () => {
    await commit('a\nb\nc\n', 'base');
    await git('checkout', '-b', 'feat');
    await commit('a\nF\nc\n', 'feat');
    await git('checkout', 'main');
    await commit('a\nM\nc\n', 'main change');
    await git('merge', 'feat'); // conflicts

    // Resolve every conflict and stage — but do NOT commit. `git status` now
    // prints "All conflicts fixed but you are still merging." (parses to idle).
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\nRESOLVED\nc\n');
    await git('add', 'f.txt');

    const status = await git('status');
    assert.ok(
      /still merging/.test(status.stdout) && !/you have unmerged paths/i.test(status.stdout),
      'precondition: status prose must be the idle-parsing "still merging" form'
    );
    assert.ok(fs.existsSync(path.join(repoPath, '.git', 'MERGE_HEAD')), 'MERGE_HEAD present');

    const repo = await gitService.getRepository(Uri.file(repoPath));
    assert.ok(repo, 'repository should load');
    assert.strictEqual(repo.state, 'merging', 'state must come from MERGE_HEAD, not prose');
  });

  it("reports 'cherry-picking' from CHERRY_PICK_HEAD", async () => {
    await commit('a\nb\nc\n', 'base');
    await git('checkout', '-b', 'feat');
    await commit('a\nF\nc\n', 'feat');
    await git('checkout', 'main');
    await commit('a\nM\nc\n', 'main change');
    await git('cherry-pick', 'feat'); // conflicts

    assert.ok(fs.existsSync(path.join(repoPath, '.git', 'CHERRY_PICK_HEAD')), 'CHERRY_PICK_HEAD');
    const repo = await gitService.getRepository(Uri.file(repoPath));
    assert.strictEqual(repo!.state, 'cherry-picking');
  });

  it("reports 'idle' for a stash-pop conflict (no marker) so recorded-op reversal holds", async () => {
    await commit('a\nb\nc\n', 'base');
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\nX\nc\n');
    await git('stash');
    await commit('a\nY\nc\n', 'other');
    await git('stash', 'pop'); // conflicts, but no MERGE_HEAD

    assert.ok(!fs.existsSync(path.join(repoPath, '.git', 'MERGE_HEAD')), 'no MERGE_HEAD for stash');
    const repo = await gitService.getRepository(Uri.file(repoPath));
    assert.strictEqual(
      repo!.state,
      'idle',
      'stash-pop must stay idle (recorded-op drives reversal)'
    );
  });
});
