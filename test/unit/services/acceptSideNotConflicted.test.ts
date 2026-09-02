/**
 * Real-git coverage: accepting a side on a file that is NOT unmerged must
 * refuse, not run `git checkout --ours/--theirs` on it.
 *
 * `git checkout --ours -- <path>` exits 0 on an ordinary path and rewrites the
 * working-tree file from HEAD, so any uncommitted edits in it are gone with no
 * error and nothing to undo. The per-file accepts are reachable with a target
 * the user did not pick — the command palette hands them whatever is in the
 * active editor — so "the row you clicked is conflicted" cannot be assumed.
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
const PRECIOUS = 'committed\nwork the user has not committed yet\n';

describe('accept side on a file that is not conflicted (real git)', () => {
  let repoPath: string;
  let gitCli: GitCli;
  let gitService: GitService;
  let service: ConflictResolutionService;
  let repo: IRepository;

  async function git(...args: string[]): Promise<string> {
    return (await gitCli.exec(args, { cwd: repoPath })).stdout;
  }

  beforeEach(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    repoPath = fs.mkdtempSync(path.join(TMP_ROOT, 'accept-clean-'));
    gitCli = new GitCli();
    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: repoPath });
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test User');
    await git('config', 'core.autocrlf', 'false');
    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;
    service = new ConflictResolutionService(gitService);
    repo = { rootUri: Uri.file(repoPath) } as unknown as IRepository;

    fs.writeFileSync(path.join(repoPath, 'a.txt'), 'committed\n');
    await git('add', 'a.txt');
    await git('commit', '-m', 'base');
    // The state that matters: tracked, modified, and NOT unmerged.
    fs.writeFileSync(path.join(repoPath, 'a.txt'), PRECIOUS);
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

  it('acceptCurrent refuses and leaves the working-tree file untouched', async () => {
    const res = await service.acceptCurrent(repo, 'a.txt', false);

    assert.strictEqual(res.success, false, 'a file with no conflict cannot be resolved');
    assert.strictEqual(
      fs.readFileSync(path.join(repoPath, 'a.txt'), 'utf8'),
      PRECIOUS,
      'uncommitted work survives'
    );
  });

  it('acceptIncoming refuses and leaves the working-tree file untouched', async () => {
    const res = await service.acceptIncoming(repo, 'a.txt', false);

    assert.strictEqual(res.success, false, 'a file with no conflict cannot be resolved');
    assert.strictEqual(
      fs.readFileSync(path.join(repoPath, 'a.txt'), 'utf8'),
      PRECIOUS,
      'uncommitted work survives'
    );
  });

  it('says why, rather than failing blankly', async () => {
    const res = await service.acceptCurrent(repo, 'a.txt', false);
    assert.match(String(res.error), /conflict/i, `unhelpful message: ${String(res.error)}`);
  });
});
