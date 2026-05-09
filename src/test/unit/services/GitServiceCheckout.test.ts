/**
 * Comprehensive correctness tests for GitService command argument construction.
 *
 * These tests verify that every combination of options produces valid git commands
 * with correct argument ordering. This prevents bugs like the "-b -f" ordering issue
 * where `git checkout -b -f branch` was generated instead of `git checkout -b branch -f`.
 */

import * as assert from 'assert';
import { GitService } from '../../../services/GitService';
import { IRepository } from '../../../services/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

/**
 * Mock GitCli that captures all executed commands for assertion.
 */
class MockGitCli {
  public executedCommands: { args: string[]; options: unknown }[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };

  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async exec(
    args: string[],
    options: { cwd?: string; throwOnError?: boolean } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executedCommands.push({ args: [...args], options });
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getRepositoryRoot(path: string): Promise<string | undefined> {
    return path;
  }

  dispose(): void {}

  getLastCommand(): { args: string[]; options: unknown } | undefined {
    return this.executedCommands[this.executedCommands.length - 1];
  }

  getAllCommands(): { args: string[]; options: unknown }[] {
    return [...this.executedCommands];
  }

  clear(): void {
    this.executedCommands = [];
  }
}

describe('GitService - Command Argument Correctness', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    gitService = new GitService();
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'refs/heads/main',
        commit: 'abc123',
        upstream: { remote: 'origin', name: 'main' },
        ahead: 0,
        behind: 0,
      },
      remotes: [{ name: 'origin', fetchUrl: 'https://example.com/repo.git', pushUrl: 'https://example.com/repo.git' }],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  // ============================================
  // checkout() — the critical one
  // ============================================
  describe('checkout() argument ordering', () => {
    it('simple checkout produces: git checkout <ref>', async () => {
      await gitService.checkout(mockRepo, 'feature-branch');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['checkout', 'feature-branch']);
    });

    it('force checkout produces: git checkout -f <ref>', async () => {
      await gitService.checkout(mockRepo, 'feature-branch', { force: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['checkout', '-f', 'feature-branch']);
    });

    it('create branch produces: git checkout -b <ref>', async () => {
      await gitService.checkout(mockRepo, 'new-branch', { createBranch: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['checkout', '-b', 'new-branch']);
    });

    it('create branch with track produces: git checkout -b <ref> --track <upstream>', async () => {
      await gitService.checkout(mockRepo, 'local-branch', {
        createBranch: true,
        track: 'origin/remote-branch',
      });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, [
        'checkout', '-b', 'local-branch', '--track', 'origin/remote-branch',
      ]);
    });

    it('create branch with force: branch name MUST follow -b immediately, not -f', async () => {
      await gitService.checkout(mockRepo, 'new-branch', {
        createBranch: true,
        force: true,
      });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // The branch name must come right after -b
      const bIndex = cmd.args.indexOf('-b');
      assert.strictEqual(bIndex, 1, '-b should be at index 1');
      assert.strictEqual(cmd.args[bIndex + 1], 'new-branch',
        'Branch name must immediately follow -b, got: ' + cmd.args[bIndex + 1]);
      assert.ok(cmd.args.includes('-f'), 'Must include -f flag');
      // -f must NOT be between -b and the branch name
      const fIndex = cmd.args.indexOf('-f');
      assert.ok(fIndex > bIndex + 1,
        `-f at index ${fIndex} must come after branch name at index ${bIndex + 1}`);
    });

    it('create branch + force + track: reproduces the exact bug scenario', async () => {
      // This is the exact scenario that caused the original bug:
      // git checkout -b -f onebox --track origin/onebox (WRONG)
      // git checkout -b onebox -f --track origin/onebox (CORRECT)
      await gitService.checkout(mockRepo, 'onebox', {
        createBranch: true,
        force: true,
        track: 'origin/onebox',
      });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);

      // Verify branch name immediately follows -b
      const bIndex = cmd.args.indexOf('-b');
      assert.strictEqual(cmd.args[bIndex + 1], 'onebox',
        'Branch name "onebox" must immediately follow -b. Got: ' + JSON.stringify(cmd.args));

      // Verify -f is present but NOT between -b and branch name
      const fIndex = cmd.args.indexOf('-f');
      assert.ok(fIndex >= 0, '-f must be present');
      assert.ok(fIndex !== bIndex + 1,
        '-f must NOT be immediately after -b (that position is for branch name)');

      // Verify --track and tracking ref are present
      assert.ok(cmd.args.includes('--track'));
      assert.ok(cmd.args.includes('origin/onebox'));
    });

    it('track without createBranch produces: git checkout <ref> --track <upstream>', async () => {
      await gitService.checkout(mockRepo, 'branch', { track: 'origin/branch' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['checkout', 'branch', '--track', 'origin/branch']);
    });

    it('createBranch=false does not include -b', async () => {
      await gitService.checkout(mockRepo, 'existing', { createBranch: false });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(!cmd.args.includes('-b'));
    });

    it('force=false does not include -f', async () => {
      await gitService.checkout(mockRepo, 'branch', { force: false });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(!cmd.args.includes('-f'));
    });

    it('no options produces: git checkout <ref>', async () => {
      await gitService.checkout(mockRepo, 'main', {});
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['checkout', 'main']);
    });
  });

  // ============================================
  // push() argument construction
  // ============================================
  describe('push() argument construction', () => {
    it('simple push: git push', async () => {
      await gitService.push(mockRepo);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['push']);
    });

    it('push with remote and branch: git push <remote> <branch>', async () => {
      await gitService.push(mockRepo, { remote: 'origin', branch: 'main' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['push', 'origin', 'main']);
    });

    it('push with setUpstream: includes --set-upstream before remote/branch', async () => {
      await gitService.push(mockRepo, { setUpstream: true, branch: 'feature' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--set-upstream'));
      assert.ok(cmd.args.includes('feature'));
      // --set-upstream must come before the branch name
      const suIdx = cmd.args.indexOf('--set-upstream');
      const brIdx = cmd.args.indexOf('feature');
      assert.ok(suIdx < brIdx, '--set-upstream must come before branch name');
    });

    it('push delete remote branch: git push <remote> :<branch>', async () => {
      await gitService.push(mockRepo, { remote: 'origin', branch: ':feature' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['push', 'origin', ':feature']);
    });

    it('force push includes --force', async () => {
      await gitService.push(mockRepo, { force: true, remote: 'origin', branch: 'main' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--force'));
    });

    it('force-with-lease push includes --force-with-lease', async () => {
      await gitService.push(mockRepo, { forceWithLease: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--force-with-lease'));
    });

    it('push tags includes --tags', async () => {
      await gitService.push(mockRepo, { tags: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--tags'));
    });
  });

  // ============================================
  // pull() argument construction
  // ============================================
  describe('pull() argument construction', () => {
    it('simple pull: git pull', async () => {
      await gitService.pull(mockRepo);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['pull']);
    });

    it('pull with rebase: git pull --rebase <remote> <branch>', async () => {
      await gitService.pull(mockRepo, { rebase: true, remote: 'origin', branch: 'main' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['pull', '--rebase', 'origin', 'main']);
    });

    it('pull without rebase: git pull <remote> <branch> (no --rebase flag)', async () => {
      await gitService.pull(mockRepo, { rebase: false, remote: 'origin', branch: 'main' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['pull', 'origin', 'main']);
      assert.ok(!cmd.args.includes('--rebase'));
    });
  });

  // ============================================
  // fetch() argument construction
  // ============================================
  describe('fetch() argument construction', () => {
    it('fetch all: git fetch --porcelain --all', async () => {
      await gitService.fetch(mockRepo);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['fetch', '--porcelain', '--all']);
    });

    it('fetch specific remote: git fetch --porcelain <remote>', async () => {
      await gitService.fetch(mockRepo, 'origin');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['fetch', '--porcelain', 'origin']);
    });
  });

  // ============================================
  // branch operations
  // ============================================
  describe('branch operations', () => {
    it('create branch: git branch <name>', async () => {
      await gitService.createBranch(mockRepo, 'new-feature');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['branch', 'new-feature']);
    });

    it('create branch from start point: git branch <name> <startPoint>', async () => {
      await gitService.createBranch(mockRepo, 'new-feature', 'main');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['branch', 'new-feature', 'main']);
    });

    it('delete branch: git branch -d <name>', async () => {
      await gitService.deleteBranch(mockRepo, 'old-feature');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['branch', '-d', 'old-feature']);
    });

    it('force delete branch: git branch -D <name>', async () => {
      await gitService.deleteBranch(mockRepo, 'old-feature', true);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['branch', '-D', 'old-feature']);
    });

    it('rename branch: git branch -m <old> <new>', async () => {
      await gitService.renameBranch(mockRepo, 'old-name', 'new-name');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['branch', '-m', 'old-name', 'new-name']);
    });
  });

  // ============================================
  // merge/rebase
  // ============================================
  describe('merge/rebase', () => {
    it('merge: git merge <branch>', async () => {
      await gitService.mergeBranch(mockRepo, 'feature');
      const cmds = mockGitCli.getAllCommands();
      assert.deepStrictEqual(cmds[0].args, ['merge', 'feature']);
    });

    it('rebase: git rebase <onto>', async () => {
      await gitService.rebaseBranch(mockRepo, 'main');
      const cmds = mockGitCli.getAllCommands();
      assert.deepStrictEqual(cmds[0].args, ['rebase', 'main']);
    });
  });

  // ============================================
  // tag operations
  // ============================================
  describe('tag operations', () => {
    it('delete tag: git tag -d <name>', async () => {
      await gitService.deleteTag(mockRepo, 'v1.0.0');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['tag', '-d', 'v1.0.0']);
    });

    it('push tag: git push origin refs/tags/<name>', async () => {
      await gitService.pushTag(mockRepo, 'v1.0.0');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['push', 'origin', 'refs/tags/v1.0.0']);
    });

    it('push tag to specific remote', async () => {
      await gitService.pushTag(mockRepo, 'v1.0.0', 'upstream');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['push', 'upstream', 'refs/tags/v1.0.0']);
    });
  });

  // ============================================
  // stash operations
  // ============================================
  describe('stash operations', () => {
    it('stash push: git stash push', async () => {
      await gitService.stash(mockRepo);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['stash', 'push']);
    });

    it('stash with message: git stash push -m <message>', async () => {
      await gitService.stash(mockRepo, 'my stash');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['stash', 'push', '-m', 'my stash']);
    });

    it('stash with untracked: includes --include-untracked', async () => {
      await gitService.stash(mockRepo, undefined, { includeUntracked: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--include-untracked'));
    });

    it('stash with keepIndex: includes --keep-index', async () => {
      await gitService.stash(mockRepo, undefined, { keepIndex: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--keep-index'));
    });

    it('stash apply: git stash apply stash@{N}', async () => {
      await gitService.stashApply(mockRepo, 2);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['stash', 'apply', 'stash@{2}']);
    });

    it('stash pop: git stash pop stash@{N}', async () => {
      await gitService.stashPop(mockRepo, 0);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['stash', 'pop', 'stash@{0}']);
    });

    it('stash drop: git stash drop stash@{N}', async () => {
      await gitService.stashDrop(mockRepo, 1);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['stash', 'drop', 'stash@{1}']);
    });
  });

  // ============================================
  // cherry-pick operations
  // ============================================
  describe('cherry-pick operations', () => {
    it('cherry-pick single: git cherry-pick <hash>', async () => {
      await gitService.cherryPick(mockRepo, ['abc123']);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['cherry-pick', 'abc123']);
    });

    it('cherry-pick multiple: git cherry-pick <hash1> <hash2>', async () => {
      await gitService.cherryPick(mockRepo, ['abc123', 'def456']);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['cherry-pick', 'abc123', 'def456']);
    });

    it('cherry-pick empty array returns success without executing', async () => {
      const result = await gitService.cherryPick(mockRepo, []);
      assert.strictEqual(result.success, true);
      assert.strictEqual(mockGitCli.getAllCommands().length, 0);
    });

    it('cherry-pick abort: git cherry-pick --abort', async () => {
      await gitService.cherryPickAbort(mockRepo);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['cherry-pick', '--abort']);
    });

    it('cherry-pick continue: git cherry-pick --continue', async () => {
      await gitService.cherryPickContinue(mockRepo);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['cherry-pick', '--continue']);
    });
  });

  // ============================================
  // commit operations
  // ============================================
  describe('commit operations', () => {
    it('simple commit: git commit -m <message>', async () => {
      await gitService.commit(mockRepo, 'fix: something');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['commit', '-m', 'fix: something']);
    });

    it('amend: includes --amend', async () => {
      await gitService.commit(mockRepo, 'fix: updated', { amend: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--amend'));
    });

    it('sign-off: includes --signoff', async () => {
      await gitService.commit(mockRepo, 'feat: new', { signOff: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--signoff'));
    });

    it('no-verify: includes --no-verify', async () => {
      await gitService.commit(mockRepo, 'wip', { noVerify: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--no-verify'));
    });

    it('allow-empty: includes --allow-empty', async () => {
      await gitService.commit(mockRepo, 'empty', { allowEmpty: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--allow-empty'));
    });

    it('rejects empty commit message', async () => {
      try {
        await gitService.commit(mockRepo, '');
        assert.fail('Should have thrown');
      } catch (e) {
        assert.ok((e as Error).message.includes('empty'));
      }
    });

    it('rejects whitespace-only commit message', async () => {
      try {
        await gitService.commit(mockRepo, '   ');
        assert.fail('Should have thrown');
      } catch (e) {
        assert.ok((e as Error).message.includes('empty'));
      }
    });

    it('allows empty message with amend', async () => {
      await gitService.commit(mockRepo, '', { amend: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--amend'));
    });

    it('allows empty message with allowEmpty', async () => {
      await gitService.commit(mockRepo, '', { allowEmpty: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.ok(cmd.args.includes('--allow-empty'));
    });
  });
});
