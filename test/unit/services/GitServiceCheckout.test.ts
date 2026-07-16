/**
 * Comprehensive correctness tests for GitService command argument construction.
 *
 * These tests verify that every combination of options produces valid git commands
 * with correct argument ordering. This prevents bugs like the "-b -f" ordering issue
 * where `git checkout -b -f branch` was generated instead of `git checkout -b branch -f`.
 */

import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
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

  async exec(
    args: string[],
    options: { cwd?: string; throwOnError?: boolean } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executedCommands.push({ args: [...args], options });
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

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
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/repo.git',
          pushUrl: 'https://example.com/repo.git',
        },
      ],
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
      assert.deepStrictEqual(cmd.args, ['checkout', '--end-of-options', 'feature-branch']);
    });

    it('force checkout produces: git checkout -f <ref>', async () => {
      await gitService.checkout(mockRepo, 'feature-branch', { force: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // non-createBranch refs follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['checkout', '-f', '--end-of-options', 'feature-branch']);
    });

    it('create branch produces: git checkout -b <ref>', async () => {
      await gitService.checkout(mockRepo, 'new-branch', { createBranch: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // createBranch path keeps the historical layout: `-b` must
      // be immediately followed by the branch name (git parser contract).
      // Branch-name validation upstream rejects hostile names.
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
        'checkout',
        '-b',
        'local-branch',
        '--track',
        'origin/remote-branch',
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
      assert.strictEqual(
        cmd.args[bIndex + 1],
        'new-branch',
        'Branch name must immediately follow -b, got: ' + cmd.args[bIndex + 1]
      );
      assert.ok(cmd.args.includes('-f'), 'Must include -f flag');
      // -f must NOT be between -b and the branch name
      const fIndex = cmd.args.indexOf('-f');
      assert.ok(
        fIndex > bIndex + 1,
        `-f at index ${fIndex} must come after branch name at index ${bIndex + 1}`
      );
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
      assert.strictEqual(
        cmd.args[bIndex + 1],
        'onebox',
        'Branch name "onebox" must immediately follow -b. Got: ' + JSON.stringify(cmd.args)
      );

      // Verify -f is present but NOT between -b and branch name
      const fIndex = cmd.args.indexOf('-f');
      assert.ok(fIndex >= 0, '-f must be present');
      assert.ok(
        fIndex !== bIndex + 1,
        '-f must NOT be immediately after -b (that position is for branch name)'
      );

      // Verify --track and tracking ref are present
      assert.ok(cmd.args.includes('--track'));
      assert.ok(cmd.args.includes('origin/onebox'));
    });

    it('track without createBranch is IGNORED — after --end-of-options git reads it as a pathspec', async () => {
      // Emitting `--track` behind `--end-of-options <ref>` made git fatal
      // ("'--track' cannot be used with updating paths"). No caller reaches
      // plain checkout with `track` (remote-branch checkout uses
      // forceCreate); the flag is dropped rather than emitted broken.
      await gitService.checkout(mockRepo, 'branch', { track: 'origin/branch' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['checkout', '--end-of-options', 'branch']);
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
      assert.deepStrictEqual(cmd.args, ['checkout', '--end-of-options', 'main']);
    });
  });

  // ============================================
  // checkout() forceCreate path (Bug F)
  // ============================================
  describe('checkout() forceCreate (-B) argument ordering', () => {
    it('plain forceCreate produces: git checkout -B <ref>', async () => {
      await gitService.checkout(mockRepo, 'main', { forceCreate: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // `-B <ref>` adjacency mirrors the `-b` precedent (git parser
      // contract). No startpoint when `track` is omitted.
      assert.deepStrictEqual(cmd.args, ['checkout', '-B', 'main']);
    });

    it('forceCreate with track produces: git checkout -B <ref> --track <startPoint>', async () => {
      await gitService.checkout(mockRepo, 'main', {
        forceCreate: true,
        track: 'origin/main',
      });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // The `track` value doubles as the single startpoint positional:
      // `git checkout -B main --track origin/main` resets `main` to
      // `origin/main` AND records it as upstream. `--end-of-options` is
      // deliberately absent — with `--track`, git would reinterpret a
      // post-separator token as a pathspec ("'--track' cannot be used
      // with updating paths"). Verified against git 2.50.1.
      assert.deepStrictEqual(cmd.args, ['checkout', '-B', 'main', '--track', 'origin/main']);
    });

    it('forceCreate with force produces: git checkout -B <ref> -f', async () => {
      await gitService.checkout(mockRepo, 'main', { forceCreate: true, force: true });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // `-f` lands AFTER the `-B <ref>` pair so the branch name stays
      // adjacent to `-B`.
      assert.deepStrictEqual(cmd.args, ['checkout', '-B', 'main', '-f']);
    });

    it('forceCreate + force + track: -B <ref> -f --track <startPoint>', async () => {
      await gitService.checkout(mockRepo, 'main', {
        forceCreate: true,
        force: true,
        track: 'origin/main',
      });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['checkout', '-B', 'main', '-f', '--track', 'origin/main']);
    });

    it('mutex: forceCreate wins over createBranch (emits -B, not -b)', async () => {
      await gitService.checkout(mockRepo, 'main', {
        forceCreate: true,
        createBranch: true,
        track: 'origin/main',
      });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // forceCreate is the strictly-more-permissive operation, so it wins.
      assert.ok(cmd.args.includes('-B'), 'must emit -B when forceCreate is set');
      assert.ok(!cmd.args.includes('-b'), 'must NOT emit -b when forceCreate wins the mutex');
      assert.deepStrictEqual(cmd.args, ['checkout', '-B', 'main', '--track', 'origin/main']);
    });

    it('refuses a startpoint beginning with "-" (argv-injection guard)', async () => {
      // The validation reject is a typed Err (checkout returns a Result); the
      // security invariant (no exec for a hostile startpoint) is preserved.
      const result = await gitService.checkout(mockRepo, 'main', {
        forceCreate: true,
        track: '--upload-pack=x',
      });
      assert.ok(result.isErr());
      assert.match(result.error.message, /Invalid start point/);
      assert.strictEqual(mockGitCli.getAllCommands().length, 0, 'no git command should run');
    });

    it('createBranch refuses a branch name beginning with "-" (argv-injection guard)', async () => {
      const result = await gitService.checkout(mockRepo, '--upload-pack=x', { createBranch: true });
      assert.ok(result.isErr());
      assert.match(result.error.message, /Invalid branch name/);
      assert.strictEqual(mockGitCli.getAllCommands().length, 0, 'no git command should run');
    });

    it('createBranch refuses a startpoint beginning with "-"/"." ', async () => {
      const result = await gitService.checkout(mockRepo, 'feature', {
        createBranch: true,
        track: '.evil',
      });
      assert.ok(result.isErr());
      assert.match(result.error.message, /Invalid start point/);
      assert.strictEqual(mockGitCli.getAllCommands().length, 0, 'no git command should run');
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
      // Refs follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['push', '--end-of-options', 'origin', 'main']);
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
      // Refs follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['push', '--end-of-options', 'origin', ':feature']);
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
      // Refs follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['pull', '--rebase', '--end-of-options', 'origin', 'main']);
    });

    it('pull without rebase: git pull <remote> <branch> (no --rebase flag)', async () => {
      await gitService.pull(mockRepo, { rebase: false, remote: 'origin', branch: 'main' });
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // Refs follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['pull', '--end-of-options', 'origin', 'main']);
      assert.ok(!cmd.args.includes('--rebase'));
    });
  });

  // ============================================
  // fetch() argument construction
  // ============================================
  describe('fetch() argument construction', () => {
    // Updated refs come from a before/after ref snapshot, so a fetch is
    // bracketed by two `for-each-ref` reads — the fetch is no longer the LAST
    // command. It also no longer passes `--porcelain` (which requires git
    // ≥ 2.41 and broke fetch on older gits).
    const fetchCmd = (): string[] => {
      const call = mockGitCli.executedCommands.find(
        (c) => c.args.find((a) => !a.startsWith('-')) === 'fetch'
      );
      assert.ok(call, 'a fetch must have run');
      return call.args;
    };

    it('fetch all: git fetch --all (no --porcelain)', async () => {
      await gitService.fetch(mockRepo);
      assert.deepStrictEqual(fetchCmd(), ['fetch', '--all']);
    });

    it('fetch specific remote: git fetch --end-of-options <remote>', async () => {
      await gitService.fetch(mockRepo, 'origin');
      // The remote name is user-controlled (`.git/config`), so it's spliced
      // behind `--end-of-options` to defend against argv injection.
      assert.deepStrictEqual(fetchCmd(), ['fetch', '--end-of-options', 'origin']);
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
      // startPoint follows `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['branch', 'new-feature', '--end-of-options', 'main']);
    });

    it('delete branch: git branch -d <name>', async () => {
      await gitService.deleteBranch(mockRepo, 'old-feature');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // Name follows `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['branch', '-d', '--end-of-options', 'old-feature']);
    });

    it('force delete branch: git branch -D <name>', async () => {
      await gitService.deleteBranch(mockRepo, 'old-feature', true);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // Name follows `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['branch', '-D', '--end-of-options', 'old-feature']);
    });

    it('rename branch: git branch -m <old> <new>', async () => {
      await gitService.renameBranch(mockRepo, 'old-name', 'new-name');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // Names follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, [
        'branch',
        '-m',
        '--end-of-options',
        'old-name',
        'new-name',
      ]);
    });
  });

  // ============================================
  // merge/rebase
  // ============================================
  describe('merge/rebase', () => {
    it('merge: git merge <branch>', async () => {
      await gitService.mergeBranch(mockRepo, 'feature');
      const cmds = mockGitCli.getAllCommands();
      // Refs follow `--end-of-options`.
      assert.deepStrictEqual(cmds[0].args, ['merge', '--end-of-options', 'feature']);
    });

    it('rebase: git rebase --autostash <onto>', async () => {
      await gitService.rebaseBranch(mockRepo, 'main');
      const cmds = mockGitCli.getAllCommands();
      // `--autostash` is spliced between the subcommand and `--end-of-options`
      // so a dirty tree is stashed and re-applied around the replay.
      assert.deepStrictEqual(cmds[0].args, ['rebase', '--autostash', '--end-of-options', 'main']);
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
      // Tag name follows `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['tag', '-d', '--end-of-options', 'v1.0.0']);
    });

    it('push tag: git push origin refs/tags/<name>', async () => {
      await gitService.pushTag(mockRepo, 'v1.0.0');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // Refs follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['push', '--end-of-options', 'origin', 'refs/tags/v1.0.0']);
    });

    it('push tag to specific remote', async () => {
      await gitService.pushTag(mockRepo, 'v1.0.0', 'upstream');
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // Refs follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, [
        'push',
        '--end-of-options',
        'upstream',
        'refs/tags/v1.0.0',
      ]);
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

    it('stash apply: working-tree only by default; --index on explicit request', async () => {
      await gitService.stashApply(mockRepo, 2);
      assert.deepStrictEqual(mockGitCli.getLastCommand()?.args, ['stash', 'apply', 'stash@{2}']);
      await gitService.stashApply(mockRepo, 2, true);
      assert.deepStrictEqual(mockGitCli.getLastCommand()?.args, [
        'stash',
        'apply',
        '--index',
        'stash@{2}',
      ]);
    });

    it('stash pop: working-tree only by default; --index on explicit request', async () => {
      await gitService.stashPop(mockRepo, 0);
      assert.deepStrictEqual(mockGitCli.getLastCommand()?.args, ['stash', 'pop', 'stash@{0}']);
      await gitService.stashPop(mockRepo, 0, true);
      assert.deepStrictEqual(mockGitCli.getLastCommand()?.args, [
        'stash',
        'pop',
        '--index',
        'stash@{0}',
      ]);
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
  describe('cherry-pick --end-of-options operations', () => {
    it('cherry-pick single: git cherry-pick <hash>', async () => {
      await gitService.cherryPick(mockRepo, ['abc123']);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      assert.deepStrictEqual(cmd.args, ['cherry-pick', '--end-of-options', 'abc123']);
    });

    it('cherry-pick multiple: git cherry-pick <hash1> <hash2>', async () => {
      await gitService.cherryPick(mockRepo, ['abc123', 'def456']);
      const cmd = mockGitCli.getLastCommand();
      assert.ok(cmd);
      // Refs follow `--end-of-options`.
      assert.deepStrictEqual(cmd.args, ['cherry-pick', '--end-of-options', 'abc123', 'def456']);
    });

    it('cherry-pick empty array returns success without executing', async () => {
      const result = (await gitService.cherryPick(mockRepo, []))._unsafeUnwrap();
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
      const result = await gitService.commit(mockRepo, '');
      assert.ok(result.isErr());
      assert.ok(result._unsafeUnwrapErr().message.includes('empty'));
    });

    it('rejects whitespace-only commit message', async () => {
      const result = await gitService.commit(mockRepo, '   ');
      assert.ok(result.isErr());
      assert.ok(result._unsafeUnwrapErr().message.includes('empty'));
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
