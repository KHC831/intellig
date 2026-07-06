/**
 * Real-git coverage for RebaseService inside a LINKED WORKTREE.
 *
 * In a linked worktree `<root>/.git` is a FILE holding `gitdir: <path>`,
 * not a directory. Every RebaseService probe that read
 * `path.join(root, '.git', …)` therefore looked at a path INSIDE a file:
 *   (i)  state probes (detectActiveRebase / isRebaseInProgress) found no
 *        rebase-merge dir, so a live rebase read as "not in progress" —
 *        the continue/abort affordance was hidden.
 *   (ii) executeRebase's sequence-editor script write threw ENOTDIR, so
 *        interactive rebase / squash was dead in a worktree.
 *
 * Both probes must route through the per-worktree gitdir resolver.
 *
 * RED evidence (pre-fix): (i) getRebaseSession returned undefined and the
 * private isRebaseInProgress returned false while a real rebase was
 * stopped in the worktree; (ii) executeRebase rejected with ENOTDIR from
 * the `<root>/.git/rebase-todo-script.sh` write.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { RebaseService } from '../../../src/git-core/RebaseService';
import { GitCli } from '../../../src/git-core/gitCli';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const TMP_ROOT = path.join(REPO_ROOT, 'workspace-notes', 'tmp');

function repoFor(p: string): IRepository {
  return { rootUri: Uri.file(p) } as unknown as IRepository;
}

describe('RebaseService — linked worktree (real git)', () => {
  let basePath: string;
  let mainPath: string;
  let wtPath: string;
  let gitCli: GitCli;
  let rebaseService: RebaseService;
  let repo: IRepository;
  let savedSeqEditor: string | undefined;
  let savedEditor: string | undefined;

  async function gitIn(cwd: string, ...args: string[]): Promise<void> {
    await gitCli.exec(args, { cwd });
  }

  async function commitIn(cwd: string, content: string, message: string): Promise<void> {
    fs.writeFileSync(path.join(cwd, 'f.txt'), content);
    await gitCli.exec(['add', '.'], { cwd });
    await gitCli.exec(['commit', '-m', message], { cwd });
  }

  beforeEach(async () => {
    savedSeqEditor = process.env.GIT_SEQUENCE_EDITOR;
    savedEditor = process.env.GIT_EDITOR;
    process.env.GIT_SEQUENCE_EDITOR = 'true';
    process.env.GIT_EDITOR = 'true';

    fs.mkdirSync(TMP_ROOT, { recursive: true });
    basePath = fs.mkdtempSync(path.join(TMP_ROOT, 'rebase-worktree-'));
    mainPath = path.join(basePath, 'main');
    wtPath = path.join(basePath, 'wt');
    fs.mkdirSync(mainPath, { recursive: true });

    gitCli = new GitCli();
    await gitIn(mainPath, '-c', 'init.defaultBranch=main', 'init');
    await gitIn(mainPath, 'config', 'user.email', 'test@example.com');
    await gitIn(mainPath, 'config', 'user.name', 'Test User');
    await commitIn(mainPath, 'base\n', 'A');

    // Linked worktree checked out on a new `feature` branch (starts at A).
    await gitIn(mainPath, 'worktree', 'add', '-b', 'feature', wtPath);
    // feature advances (touches f.txt), main diverges on the same line → a
    // rebase of feature onto main conflicts.
    await commitIn(wtPath, 'feature-change\n', 'B');
    await commitIn(mainPath, 'main-change\n', 'M');

    rebaseService = new RebaseService(gitCli);
    repo = repoFor(wtPath);

    // Sanity: `<wt>/.git` really is a pointer FILE, not a directory.
    assert.strictEqual(
      fs.statSync(path.join(wtPath, '.git')).isFile(),
      true,
      'precondition: worktree .git must be a pointer file'
    );
  });

  afterEach(() => {
    rebaseService.dispose();
    process.env.GIT_SEQUENCE_EDITOR = savedSeqEditor;
    process.env.GIT_EDITOR = savedEditor;
    if (savedSeqEditor === undefined) {
      delete process.env.GIT_SEQUENCE_EDITOR;
    }
    if (savedEditor === undefined) {
      delete process.env.GIT_EDITOR;
    }
    try {
      fs.rmSync(basePath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  });

  it('detects a rebase stopped inside the worktree (state probes follow the gitdir pointer)', async () => {
    // Drive a real conflicting rebase in the worktree (not through the
    // service) so the rebase-merge metadata lands in the REAL per-worktree
    // gitdir, where a naive `<root>/.git/rebase-merge` probe cannot see it.
    await gitCli.exec(['rebase', 'main'], { cwd: wtPath }); // conflicts, exits non-zero

    // Public surface: a session must be reconstructed from disk.
    const session = rebaseService.getRebaseSession(repo);
    assert.ok(session, 'getRebaseSession must see the in-worktree rebase');
    assert.strictEqual(session?.originalBranch, 'feature', 'head-name resolves to feature');

    // Direct probe: the continue/abort affordance gates on this.
    const inProgress = (
      rebaseService as unknown as { isRebaseInProgress(r: IRepository): boolean }
    ).isRebaseInProgress(repo);
    assert.strictEqual(inProgress, true, 'isRebaseInProgress must be true in the worktree');
  });

  it('executeRebase writes its sequence-editor script without ENOTDIR', async () => {
    await rebaseService.startInteractiveRebase(repo, 'main');
    // Pre-fix this rejects with ENOTDIR from the `<root>/.git/...sh` write.
    // Post-fix the write lands in the resolved gitdir and executeRebase
    // resolves to a result (the editor subprocess itself is out of scope
    // here — the assertion is that the script write no longer throws).
    await assert.doesNotReject(
      () => rebaseService.executeRebase(repo),
      'executeRebase must not throw ENOTDIR writing the sequence-editor script'
    );
  });
});
