/**
 * Real-git coverage for the rebase/unstash ours↔theirs swap.
 *
 * During a rebase git swaps the index sides: stage 2 (`--ours`) is the branch
 * being replayed onto, stage 3 (`--theirs`) is the user's own commit. So
 * "Accept Yours" must take `--theirs` and "Accept Theirs" must take `--ours`,
 * matching IntelliJ `GitMergeUtil.isReverseRoot`. Without the swap the buttons
 * resolve to the opposite side.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { okAsync } from 'neverthrow';
import * as vscode from 'vscode';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import { createGitCli } from '../../../src/git-core/gitCli';
import {
  IGitService,
  IRepository,
  IFileStatus,
} from '../../../src/git-core/interfaces/IGitService';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Leave `f.txt` mid-rebase of `feature` onto `mainline`, with the user's own
 * commit content = "MY-FEATURE-WORK" and the upstream content = "UPSTREAM-WORK".
 */
function makeRebaseConflictRepo(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-swap-'));
  git(root, 'init', '-q', '-b', 'mainline');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');

  fs.writeFileSync(path.join(root, 'f.txt'), 'base\n');
  git(root, 'add', 'f.txt');
  git(root, 'commit', '-q', '-m', 'base');

  git(root, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(root, 'f.txt'), 'MY-FEATURE-WORK\n');
  git(root, 'commit', '-q', '-am', 'feature work');

  git(root, 'checkout', '-q', 'mainline');
  fs.writeFileSync(path.join(root, 'f.txt'), 'UPSTREAM-WORK\n');
  git(root, 'commit', '-q', '-am', 'upstream work');

  git(root, 'checkout', '-q', 'feature');
  try {
    git(root, 'rebase', 'mainline');
  } catch {
    // expected — rebase stops on the conflict
  }
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function makeService(root: string): ConflictResolutionService {
  const cli = createGitCli();
  const gitService = {
    gitCli: cli,
    getStatus: async (): Promise<IFileStatus[]> => {
      const out = git(root, 'status', '--porcelain');
      return out
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => ({
          path: l.slice(3),
          indexStatus: l[0],
          workTreeStatus: l[1],
        })) as IFileStatus[];
    },
    stage: (_repo: IRepository, paths: string[]) => {
      git(root, 'add', '--', ...paths);
      return okAsync(undefined);
    },
    onDidChangeRepository: new vscode.EventEmitter<IRepository>().event,
  } as unknown as IGitService;
  return new ConflictResolutionService(gitService);
}

describe('ConflictResolutionService ours/theirs swap — real git rebase', () => {
  it("Accept Yours during a rebase keeps the user's own commit (auto-detected from state)", async () => {
    const { root, cleanup } = makeRebaseConflictRepo();
    try {
      const service = makeService(root);
      const repo = {
        rootUri: vscode.Uri.file(root),
        state: 'rebasing',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      const result = await service.acceptCurrent(repo, 'f.txt');
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(
        fs.readFileSync(path.join(root, 'f.txt'), 'utf8'),
        'MY-FEATURE-WORK\n',
        "Accept Yours during a rebase must keep the user's own work, not upstream"
      );
      service.dispose();
    } finally {
      cleanup();
    }
  });

  it('Accept Theirs during a rebase keeps the upstream content', async () => {
    const { root, cleanup } = makeRebaseConflictRepo();
    try {
      const service = makeService(root);
      const repo = {
        rootUri: vscode.Uri.file(root),
        state: 'rebasing',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      const result = await service.acceptIncoming(repo, 'f.txt');
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(
        fs.readFileSync(path.join(root, 'f.txt'), 'utf8'),
        'UPSTREAM-WORK\n',
        'Accept Theirs during a rebase must keep the upstream content'
      );
      service.dispose();
    } finally {
      cleanup();
    }
  });

  it('explicit reversed=true overrides state (covers unstash/unshelve, repo state idle)', async () => {
    const { root, cleanup } = makeRebaseConflictRepo();
    try {
      const service = makeService(root);
      // State 'idle' would NOT auto-detect a swap; the explicit flag forces it.
      const repo = {
        rootUri: vscode.Uri.file(root),
        state: 'idle',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      const result = await service.acceptCurrent(repo, 'f.txt', true);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(
        fs.readFileSync(path.join(root, 'f.txt'), 'utf8'),
        'MY-FEATURE-WORK\n',
        'explicit reversed must take the user side regardless of repo.state'
      );
      service.dispose();
    } finally {
      cleanup();
    }
  });

  it('without reversal (plain merge state) Accept Yours takes --ours', async () => {
    const { root, cleanup } = makeRebaseConflictRepo();
    try {
      const service = makeService(root);
      const repo = {
        rootUri: vscode.Uri.file(root),
        state: 'merging',
        remotes: [],
        submodules: [],
      } as unknown as IRepository;

      // In a (hypothetical) non-reversed context, --ours is stage 2 = upstream.
      const result = await service.acceptCurrent(repo, 'f.txt', false);
      assert.strictEqual(result.success, true, result.error);
      assert.strictEqual(
        fs.readFileSync(path.join(root, 'f.txt'), 'utf8'),
        'UPSTREAM-WORK\n',
        'non-reversed Accept Yours takes --ours (stage 2)'
      );
      service.dispose();
    } finally {
      cleanup();
    }
  });
});
