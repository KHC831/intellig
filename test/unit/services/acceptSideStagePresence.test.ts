/**
 * Real-git coverage: accepting a side whose git index STAGE is absent must
 * resolve the file (via `git rm`), not run `git checkout --ours/--theirs` on a
 * stage that does not exist (which errors and leaves the file unmerged).
 *
 * The delete/modify cases (UD/DU) carry a porcelain 'D' column, but add-by-one-
 * side unmerged states (AU = ours only / UA = theirs only) do not — the wanted
 * stage is simply missing. `_takeSide` must key off actual stage presence
 * (`git ls-files -u`), not the porcelain 'D' letter.
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

const TMP_ROOT = path.join(__dirname, '../../../workspace-notes/tmp');

describe('accept side with an absent index stage (real git)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let gitService: GitService;
  let service: ConflictResolutionService;
  let repo: IRepository;

  async function git(...args: string[]): Promise<string> {
    return (await gitCli.exec(args, { cwd: repoPath })).stdout;
  }

  /**
   * Make `f.txt` an unmerged entry carrying ONLY the given stage (2=ours,
   * 3=theirs) — the AU/UA shape where the other side's blob is absent.
   */
  async function makeSingleStageConflict(stage: 2 | 3): Promise<void> {
    fs.writeFileSync(path.join(repoPath, 'f.txt'), 'content\n');
    await git('add', 'f.txt');
    await git('commit', '-m', 'base');
    const sha = (await git('rev-parse', 'HEAD:f.txt')).trim();
    await git('rm', '--cached', '-q', 'f.txt');
    await gitCli.exec(['update-index', '--index-info'], {
      cwd: repoPath,
      input: `100644 ${sha} ${stage}\tf.txt\n`,
    });
  }

  beforeEach(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    repoPath = fs.mkdtempSync(path.join(TMP_ROOT, 'accept-stage-'));
    gitCli = new GitCli();
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test User');
    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;
    service = new ConflictResolutionService(gitService);
    repo = { rootUri: Uri.file(repoPath) } as unknown as IRepository;
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

  it('acceptIncoming resolves when theirs (stage 3) is absent, instead of erroring', async () => {
    await makeSingleStageConflict(2); // ours only → taking theirs must rm
    const res = await service.acceptIncoming(repo, 'f.txt', false);
    assert.strictEqual(res.success, true, res.error);
    const unmerged = (await git('ls-files', '-u', 'f.txt')).trim();
    assert.strictEqual(unmerged, '', 'f.txt must no longer be unmerged after accept');
  });

  it('acceptCurrent resolves when ours (stage 2) is absent, instead of erroring', async () => {
    await makeSingleStageConflict(3); // theirs only → taking ours must rm
    const res = await service.acceptCurrent(repo, 'f.txt', false);
    assert.strictEqual(res.success, true, res.error);
    const unmerged = (await git('ls-files', '-u', 'f.txt')).trim();
    assert.strictEqual(unmerged, '', 'f.txt must no longer be unmerged after accept');
  });

  it('acceptCurrent keeps ours (stage 2) when present', async () => {
    await makeSingleStageConflict(2); // ours only → taking ours keeps content
    const res = await service.acceptCurrent(repo, 'f.txt', false);
    assert.strictEqual(res.success, true, res.error);
    assert.strictEqual(fs.readFileSync(path.join(repoPath, 'f.txt'), 'utf8'), 'content\n');
    assert.strictEqual((await git('ls-files', '-u', 'f.txt')).trim(), '');
  });
});
