/**
 * Real-git coverage: the in-progress conflict probe must work inside a linked
 * worktree.
 *
 * In a linked worktree `<root>/.git` is a FILE (`gitdir: …`), and the per-worktree
 * markers (MERGE_HEAD/…) live under the resolved gitdir. If the state-file check
 * probes the raw `<root>/.git/MERGE_HEAD` it hits ENOTDIR and reports no operation
 * in progress, so `intellig.conflicts.active` never flips on and the status-bar
 * "Resolve Conflicts" prompt never appears during a worktree conflict. The check
 * must resolve the real gitdir first.
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

describe('conflict state-file check inside a linked worktree (real git)', () => {
  let root: string;
  let mainRepo: string;
  let worktree: string;
  let gitCli: GitCli;
  let gitService: GitService;
  let service: ConflictResolutionService;

  async function git(cwd: string, ...args: string[]): Promise<void> {
    await gitCli.exec(args, { cwd });
  }

  beforeEach(async () => {
    fs.mkdirSync(TMP_ROOT, { recursive: true });
    root = fs.mkdtempSync(path.join(TMP_ROOT, 'wt-conflict-'));
    mainRepo = path.join(root, 'main');
    worktree = path.join(root, 'linked');
    fs.mkdirSync(mainRepo);
    gitCli = new GitCli();

    await gitCli.exec(['-c', 'init.defaultBranch=main', 'init'], { cwd: mainRepo });
    await git(mainRepo, 'config', 'user.email', 'test@example.com');
    await git(mainRepo, 'config', 'user.name', 'Test User');
    fs.writeFileSync(path.join(mainRepo, 'f.txt'), 'a\nb\nc\n');
    await git(mainRepo, 'add', '.');
    await git(mainRepo, 'commit', '-m', 'base');
    await git(mainRepo, 'checkout', '-b', 'other');
    fs.writeFileSync(path.join(mainRepo, 'f.txt'), 'a\nX\nc\n');
    await git(mainRepo, 'commit', '-am', 'other');
    await git(mainRepo, 'checkout', 'main');
    fs.writeFileSync(path.join(mainRepo, 'f.txt'), 'a\nY\nc\n');
    await git(mainRepo, 'commit', '-am', 'main change');

    // Linked worktree at main's tip; merge 'other' there → conflict + MERGE_HEAD
    // live under main/.git/worktrees/linked, and worktree/.git is a FILE.
    await git(mainRepo, 'worktree', 'add', '-b', 'wt', worktree, 'main');
    await gitCli.exec(['merge', 'other'], { cwd: worktree }); // conflicts (non-zero, ignored)

    gitService = new GitService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = gitCli;
    service = new ConflictResolutionService(gitService);
  });

  afterEach(() => {
    service.dispose();
    gitService.dispose();
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("reports conflicts active when the in-progress merge lives in the worktree's gitdir", async () => {
    assert.ok(
      fs.statSync(path.join(worktree, '.git')).isFile(),
      'precondition: worktree .git is a file'
    );

    const repo = { rootUri: Uri.file(worktree) } as unknown as IRepository;
    const active = await service.runStateFileCheck(repo);

    assert.strictEqual(
      active,
      true,
      'a merge conflict inside a linked worktree must register as conflicts-active'
    );
  });
});
