/**
 * Real-git coverage for completeMerge.
 *
 * completeMerge finishes an in-progress merge by committing the resolved index.
 * It must not hard-guard on the cached `repo.state`: that value can lag after a
 * reload, and the dialog acts on a frozen operation. git itself is the correct
 * guard — `git merge --continue` reads `MERGE_HEAD` live and self-errors when no
 * merge is in progress. So completeMerge should succeed for a genuinely-merging
 * repo even when `repo.state` reads stale 'idle', and it should carry MERGE_MSG.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../../../src/git-core/GitService';
import { GitCli } from '../../../src/git-core/gitCli';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';
import { SCRATCH_ROOT } from '../../helpers/scratchRoot';

const TMP_ROOT = SCRATCH_ROOT;

describe('completeMerge (real git)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let gitService: GitService;
  let service: ConflictResolutionService;

  async function git(...args: string[]): Promise<string> {
    return (await gitCli.exec(args, { cwd: repoPath })).stdout;
  }

  beforeEach(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    repoPath = fs.mkdtempSync(path.join(TMP_ROOT, 'complete-merge-'));
    gitCli = new GitCli();
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test User');
    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;
    service = new ConflictResolutionService(gitService);

    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\nb\nc\n');
    await git('add', '.');
    await git('commit', '-m', 'base');
    await git('checkout', '-b', 'feat');
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\nF\nc\n');
    await git('commit', '-am', 'feat');
    await git('checkout', 'main');
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\nM\nc\n');
    await git('commit', '-am', 'main change');
    await gitCli.exec(['merge', 'feat'], { cwd: repoPath }); // conflicts
    // Resolve + stage.
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'a\nRESOLVED\nc\n');
    await git('add', 'f.txt');
  });

  afterEach(() => {
    service.dispose();
    gitService.dispose();
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('commits the resolved merge even when repo.state reads stale idle', async () => {
    const headBefore = (await git('rev-parse', 'HEAD')).trim();
    // Pass a repo whose cached state is 'idle' — completeMerge must not block on
    // it; MERGE_HEAD is present so git completes the merge.
    const repo = { rootUri: Uri.file(repoPath), state: 'idle' } as unknown as IRepository;

    const res = await service.completeMerge(repo);
    assert.strictEqual(res.success, true, res.error);

    const headAfter = (await git('rev-parse', 'HEAD')).trim();
    assert.notStrictEqual(headAfter, headBefore, 'a merge commit must be created');
    assert.ok(!fs.existsSync(path.join(repoPath, '.git', 'MERGE_HEAD')), 'merge concluded');
    // MERGE_MSG-derived message (merge --continue honors it).
    const subject = (await git('log', '-1', '--pretty=%s')).trim();
    assert.ok(/Merge/i.test(subject), `merge commit should carry a merge message, got: ${subject}`);
  });

  it('fails without committing when no merge is in progress (git self-guards)', async () => {
    // Conclude the merge first so no MERGE_HEAD remains, then call again.
    await gitCli.exec(['merge', '--continue'], {
      cwd: repoPath,
      env: { ...process.env, GIT_EDITOR: 'true' },
    });
    const headBefore = (await git('rev-parse', 'HEAD')).trim();

    const repo = { rootUri: Uri.file(repoPath), state: 'merging' } as unknown as IRepository;
    const res = await service.completeMerge(repo);

    assert.strictEqual(res.success, false, 'must not succeed with no merge in progress');
    assert.strictEqual(
      (await git('rev-parse', 'HEAD')).trim(),
      headBefore,
      'no commit may be created when there is no merge to conclude'
    );
  });
});
