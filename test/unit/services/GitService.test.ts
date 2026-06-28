/**
 * Unit tests for GitService commit operations.
 *
 * Tests cover:
 * - commit() with CommitOptions support
 * - amend() for amending previous commits
 * - stage() for file staging
 * - unstage() for file unstaging
 * - Empty commit message validation
 */

import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository, ICommitOptions } from '../../../src/git-core/interfaces/IGitService';
import { isConflictError } from '../../../src/sync/PullDialog';
import { Uri } from '../../mocks/vscode';

// Mock GitCli for testing
class MockGitCli {
  public executedCommands: { args: string[]; options: unknown }[] = [];
  public mockResults: Map<string, { exitCode: number; stdout: string; stderr: string }> = new Map();
  public mockResultsByPrefix: Map<string, { exitCode: number; stdout: string; stderr: string }> =
    new Map();
  private _onCommandExecuted = {
    event: (): { dispose: () => void } => ({ dispose: (): void => {} }),
  };

  get onCommandExecuted(): () => { dispose: () => void } {
    return this._onCommandExecuted.event;
  }

  async exec(
    args: string[],
    options: { cwd?: string; throwOnError?: boolean; input?: string } = {}
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> {
    this.executedCommands.push({ args, options });

    // Check for mock results by exact match
    const commandKey = args.join(' ');
    let mockResult = this.mockResults.get(commandKey);

    // If no exact match, try prefix matching
    if (!mockResult) {
      for (const [prefix, result] of this.mockResultsByPrefix) {
        if (commandKey.startsWith(prefix)) {
          mockResult = result;
          break;
        }
      }
    }

    if (mockResult) {
      if (options.throwOnError && mockResult.exitCode !== 0) {
        throw new Error(`Git command failed: ${mockResult.stderr}`);
      }
      return { ...mockResult, combined: mockResult.stdout + mockResult.stderr };
    }

    // Default success response
    return { exitCode: 0, stdout: '', stderr: '', combined: '' };
  }

  async getRepositoryRoot(path: string): Promise<string | undefined> {
    return path;
  }

  dispose(): void {}

  // Helper to set mock result for a command (exact match)
  setMockResult(
    command: string,
    result: { exitCode: number; stdout: string; stderr: string }
  ): void {
    this.mockResults.set(command, result);
  }

  // Helper to set mock result for commands starting with a prefix
  setMockResultByPrefix(
    prefix: string,
    result: { exitCode: number; stdout: string; stderr: string }
  ): void {
    this.mockResultsByPrefix.set(prefix, result);
  }

  // Helper to get the last executed command
  getLastCommand(): { args: string[]; options: unknown } | undefined {
    return this.executedCommands[this.executedCommands.length - 1];
  }

  // Helper to clear executed commands
  clearCommands(): void {
    this.executedCommands = [];
  }
}

describe('GitService - Commit Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('commit()', () => {
    describe('Basic commit functionality', () => {
      it('should execute git commit with message', async () => {
        await gitService.commit(mockRepo, 'Test commit message', {});

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['commit', '-m', 'Test commit message']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.commit(mockRepo, 'Test commit', {});

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });
    });

    describe('Empty message validation', () => {
      it('should throw error for empty commit message', async () => {
        {
          const __r = await gitService.commit(mockRepo, '', {});
          assert.ok(__r.isErr());
        }
      });

      it('should throw error for whitespace-only commit message', async () => {
        {
          const __r = await gitService.commit(mockRepo, '   ', {});
          assert.ok(__r.isErr());
        }
      });

      it('should throw error for newline-only commit message', async () => {
        {
          const __r = await gitService.commit(mockRepo, '\n\n', {});
          assert.ok(__r.isErr());
        }
      });

      it('should throw error for tab-only commit message', async () => {
        {
          const __r = await gitService.commit(mockRepo, '\t\t', {});
          assert.ok(__r.isErr());
        }
      });

      it('should allow empty message when allowEmpty option is true', async () => {
        await gitService.commit(mockRepo, '', { allowEmpty: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--allow-empty'), 'Should include --allow-empty flag');
      });

      it('should allow empty message when amending', async () => {
        await gitService.commit(mockRepo, '', { amend: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--amend'), 'Should include --amend flag');
      });
    });

    describe('Amend option', () => {
      it('should include --amend flag when amend option is true', async () => {
        await gitService.commit(mockRepo, 'Amended message', { amend: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--amend'), 'Should include --amend flag');
      });

      it('should not include --amend flag when amend option is false', async () => {
        await gitService.commit(mockRepo, 'Normal commit', { amend: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--amend'), 'Should not include --amend flag');
      });

      it('should not include --amend flag when amend option is undefined', async () => {
        await gitService.commit(mockRepo, 'Normal commit', {});

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--amend'), 'Should not include --amend flag');
      });
    });

    describe('Sign-off option', () => {
      it('should include --signoff flag when signOff option is true', async () => {
        await gitService.commit(mockRepo, 'Signed commit', { signOff: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--signoff'), 'Should include --signoff flag');
      });

      it('should not include --signoff flag when signOff option is false', async () => {
        await gitService.commit(mockRepo, 'Unsigned commit', { signOff: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--signoff'), 'Should not include --signoff flag');
      });

      it('should not include --signoff flag when signOff option is undefined', async () => {
        await gitService.commit(mockRepo, 'Normal commit', {});

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--signoff'), 'Should not include --signoff flag');
      });
    });

    describe('noVerify option', () => {
      it('should include --no-verify flag when noVerify option is true', async () => {
        await gitService.commit(mockRepo, 'Skip hooks commit', { noVerify: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--no-verify'), 'Should include --no-verify flag');
      });

      it('should not include --no-verify flag when noVerify option is false', async () => {
        await gitService.commit(mockRepo, 'Normal commit', { noVerify: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--no-verify'), 'Should not include --no-verify flag');
      });
    });

    describe('allowEmpty option', () => {
      it('should include --allow-empty flag when allowEmpty option is true', async () => {
        await gitService.commit(mockRepo, 'Empty commit', { allowEmpty: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--allow-empty'), 'Should include --allow-empty flag');
      });

      it('should not include --allow-empty flag when allowEmpty option is false', async () => {
        await gitService.commit(mockRepo, 'Normal commit', { allowEmpty: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          !lastCommand.args.includes('--allow-empty'),
          'Should not include --allow-empty flag'
        );
      });
    });

    describe('Combined options', () => {
      it('should include all flags when all options are true', async () => {
        const options: ICommitOptions = {
          amend: true,
          signOff: true,
          noVerify: true,
          allowEmpty: true,
        };

        await gitService.commit(mockRepo, 'Full options commit', options);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--amend'), 'Should include --amend flag');
        assert.ok(lastCommand.args.includes('--signoff'), 'Should include --signoff flag');
        assert.ok(lastCommand.args.includes('--no-verify'), 'Should include --no-verify flag');
        assert.ok(lastCommand.args.includes('--allow-empty'), 'Should include --allow-empty flag');
      });

      it('should maintain correct argument order', async () => {
        const options: ICommitOptions = {
          amend: true,
          signOff: true,
          noVerify: true,
          allowEmpty: true,
        };

        await gitService.commit(mockRepo, 'Test message', options);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');

        // Verify the message comes after 'commit' and '-m'
        const commitIndex = lastCommand.args.indexOf('commit');
        const mIndex = lastCommand.args.indexOf('-m');
        const messageIndex = lastCommand.args.indexOf('Test message');

        assert.strictEqual(commitIndex, 0, 'commit should be first');
        assert.strictEqual(mIndex, 1, '-m should be second');
        assert.strictEqual(messageIndex, 2, 'message should be third');
      });
    });
  });

  describe('amend()', () => {
    it('should call commit with amend option set to true', async () => {
      await gitService.amend(mockRepo, 'Amended message');

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.ok(lastCommand.args.includes('--amend'), 'Should include --amend flag');
      assert.ok(lastCommand.args.includes('Amended message'), 'Should include the amended message');
    });

    it('should allow empty message when amending', async () => {
      // amend() calls commit() with amend: true, which should allow empty messages
      await gitService.amend(mockRepo, '');

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.ok(lastCommand.args.includes('--amend'), 'Should include --amend flag');
    });
  });

  describe('stage()', () => {
    it('should execute git add with file paths', async () => {
      await gitService.stage(mockRepo, ['file1.ts', 'file2.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, ['add', '--', 'file1.ts', 'file2.ts']);
    });

    it('should execute git add with single file', async () => {
      await gitService.stage(mockRepo, ['single-file.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, ['add', '--', 'single-file.ts']);
    });

    it('should pass the correct working directory', async () => {
      await gitService.stage(mockRepo, ['file.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
    });

    it('should handle paths with spaces', async () => {
      await gitService.stage(mockRepo, ['path with spaces/file.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, ['add', '--', 'path with spaces/file.ts']);
    });

    it('should handle multiple files in different directories', async () => {
      await gitService.stage(mockRepo, ['src/file1.ts', 'test/file2.ts', 'lib/file3.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, [
        'add',
        '--',
        'src/file1.ts',
        'test/file2.ts',
        'lib/file3.ts',
      ]);
    });
  });

  describe('unstage()', () => {
    it('should execute git reset HEAD with file paths', async () => {
      await gitService.unstage(mockRepo, ['file1.ts', 'file2.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, ['reset', 'HEAD', '--', 'file1.ts', 'file2.ts']);
    });

    it('should execute git reset HEAD with single file', async () => {
      await gitService.unstage(mockRepo, ['single-file.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, ['reset', 'HEAD', '--', 'single-file.ts']);
    });

    it('should pass the correct working directory', async () => {
      await gitService.unstage(mockRepo, ['file.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
    });

    it('should handle paths with spaces', async () => {
      await gitService.unstage(mockRepo, ['path with spaces/file.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, ['reset', 'HEAD', '--', 'path with spaces/file.ts']);
    });

    it('should handle multiple files in different directories', async () => {
      await gitService.unstage(mockRepo, ['src/file1.ts', 'test/file2.ts', 'lib/file3.ts']);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, [
        'reset',
        'HEAD',
        '--',
        'src/file1.ts',
        'test/file2.ts',
        'lib/file3.ts',
      ]);
    });
  });
});

/**
 * Unit tests for GitService branch operations.
 *
 * Tests cover:
 * - getBranches() for listing local and remote branches
 * - createBranch() with optional start point
 * - checkout() with CheckoutOptions
 * - deleteBranch() with force option
 * - renameBranch()
 */
describe('GitService - Branch Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('getBranches()', () => {
    describe('Listing local and remote branches', () => {
      it('should execute git branch -a with format option', async () => {
        mockGitCli.setMockResult(
          'branch -a --format %(refname)\x1f%(objectname)\x1f%(upstream:short)\x1f%(HEAD)',
          {
            exitCode: 0,
            stdout: '',
            stderr: '',
          }
        );

        await gitService.getBranches(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual(lastCommand.args[0], 'branch');
        assert.strictEqual(lastCommand.args[1], '-a');
        assert.strictEqual(lastCommand.args[2], '--format');
      });

      it('should pass the correct working directory', async () => {
        await gitService.getBranches(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return empty array when command fails', async () => {
        mockGitCli.setMockResult(
          'branch -a --format %(refname)\x1f%(objectname)\x1f%(upstream:short)\x1f%(HEAD)',
          {
            exitCode: 1,
            stdout: '',
            stderr: 'error',
          }
        );

        const branches = await gitService.getBranches(mockRepo);
        assert.deepStrictEqual(branches, []);
      });

      it('should parse local branches correctly', async () => {
        mockGitCli.setMockResult(
          'branch -a --format %(refname)\x1f%(objectname)\x1f%(upstream:short)\x1f%(HEAD)',
          {
            exitCode: 0,
            stdout:
              'refs/heads/main\x1fabc123def456\x1forigin/main\x1f*\nrefs/heads/feature\x1fdef789abc012\x1f\x1f\n',
            stderr: '',
          }
        );

        const branches = await gitService.getBranches(mockRepo);

        assert.strictEqual(branches.length, 2);
        assert.strictEqual(branches[0].name, 'main');
        assert.strictEqual(branches[0].type, 'local');
        assert.strictEqual(branches[0].isHead, true);
        assert.strictEqual(branches[1].name, 'feature');
        assert.strictEqual(branches[1].type, 'local');
        assert.strictEqual(branches[1].isHead, false);
      });

      it('should parse remote branches correctly', async () => {
        mockGitCli.setMockResult(
          'branch -a --format %(refname)\x1f%(objectname)\x1f%(upstream:short)\x1f%(HEAD)',
          {
            exitCode: 0,
            stdout:
              'refs/remotes/origin/main\x1fabc123def456\x1f\x1f\nrefs/remotes/origin/develop\x1fdef789abc012\x1f\x1f\n',
            stderr: '',
          }
        );

        const branches = await gitService.getBranches(mockRepo);

        assert.strictEqual(branches.length, 2);
        assert.strictEqual(branches[0].name, 'origin/main');
        assert.strictEqual(branches[0].type, 'remote');
        assert.strictEqual(branches[1].name, 'origin/develop');
        assert.strictEqual(branches[1].type, 'remote');
      });

      it('should parse upstream information correctly', async () => {
        mockGitCli.setMockResult(
          'branch -a --format %(refname)\x1f%(objectname)\x1f%(upstream:short)\x1f%(HEAD)',
          {
            exitCode: 0,
            stdout: 'refs/heads/main\x1fabc123def456\x1forigin/main\x1f*\n',
            stderr: '',
          }
        );

        const branches = await gitService.getBranches(mockRepo);

        assert.strictEqual(branches.length, 1);
        assert.ok(branches[0].upstream, 'Should have upstream');
        assert.strictEqual(branches[0].upstream?.remote, 'origin');
        assert.strictEqual(branches[0].upstream?.name, 'main');
      });
    });
  });

  describe('getContainingBranches()', () => {
    const HASH = '1234567890abcdef1234567890abcdef12345678';
    const CMD = `branch -a --contains ${HASH} --format %(refname)`;

    it('runs git branch -a --contains <hash> --format %(refname)', async () => {
      await gitService.getContainingBranches(mockRepo, HASH);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, [
        'branch',
        '-a',
        '--contains',
        HASH,
        '--format',
        '%(refname)',
      ]);
    });

    it('passes the repo root as the working directory', async () => {
      await gitService.getContainingBranches(mockRepo, HASH);

      const lastCommand = mockGitCli.getLastCommand();
      assert.strictEqual((lastCommand?.options as { cwd: string }).cwd, '/test/repo');
    });

    it('returns the sorted local + remote branch names that contain the commit', async () => {
      mockGitCli.setMockResult(CMD, {
        exitCode: 0,
        stdout: 'refs/heads/main\nrefs/heads/feature/x\nrefs/remotes/origin/main\n',
        stderr: '',
      });

      const branches = await gitService.getContainingBranches(mockRepo, HASH);
      assert.deepStrictEqual(branches, ['feature/x', 'main', 'origin/main']);
    });

    it('returns an empty list when no branch contains the commit', async () => {
      mockGitCli.setMockResult(CMD, { exitCode: 0, stdout: '', stderr: '' });

      const branches = await gitService.getContainingBranches(mockRepo, HASH);
      assert.deepStrictEqual(branches, []);
    });

    it('degrades to an empty list when the git command fails', async () => {
      mockGitCli.setMockResult(CMD, { exitCode: 1, stdout: '', stderr: 'boom' });

      const branches = await gitService.getContainingBranches(mockRepo, HASH);
      assert.deepStrictEqual(branches, []);
    });

    it('rejects a non-hex commit ref without running git (injection guard)', async () => {
      const branches = await gitService.getContainingBranches(mockRepo, '--upload-pack=evil');
      assert.deepStrictEqual(branches, []);
      assert.strictEqual(
        mockGitCli.getLastCommand(),
        undefined,
        'no git command should run for an invalid ref'
      );
    });
  });

  describe('createBranch()', () => {
    describe('Creating branch from current HEAD', () => {
      it('should execute git branch with branch name', async () => {
        await gitService.createBranch(mockRepo, 'new-feature');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['branch', 'new-feature']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.createBranch(mockRepo, 'new-feature');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('surfaces an Err on error', async () => {
        mockGitCli.setMockResult('branch new-feature', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: A branch named 'new-feature' already exists.",
        });

        const result = await gitService.createBranch(mockRepo, 'new-feature');
        assert.ok(result.isErr(), 'createBranch must surface a failed Result');
        assert.match(result.error.message, /Git command failed/);
      });
    });

    describe('Creating branch from start point', () => {
      it('should execute git branch with branch name and start point', async () => {
        await gitService.createBranch(mockRepo, 'new-feature', 'develop');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          'new-feature',
          '--end-of-options',
          'develop',
        ]);
      });

      it('should create branch from commit hash', async () => {
        await gitService.createBranch(mockRepo, 'hotfix', 'abc123def456');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          'hotfix',
          '--end-of-options',
          'abc123def456',
        ]);
      });

      it('should create branch from tag', async () => {
        await gitService.createBranch(mockRepo, 'release-branch', 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          'release-branch',
          '--end-of-options',
          'v1.0.0',
        ]);
      });

      it('should create branch from remote branch', async () => {
        await gitService.createBranch(mockRepo, 'local-feature', 'origin/feature');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          'local-feature',
          '--end-of-options',
          'origin/feature',
        ]);
      });
    });
  });

  describe('checkout()', () => {
    describe('Basic checkout', () => {
      it('should execute git checkout with ref', async () => {
        await gitService.checkout(mockRepo, 'feature-branch');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'checkout',
          '--end-of-options',
          'feature-branch',
        ]);
      });

      it('should pass the correct working directory', async () => {
        await gitService.checkout(mockRepo, 'main');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should checkout commit hash', async () => {
        await gitService.checkout(mockRepo, 'abc123def456');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['checkout', '--end-of-options', 'abc123def456']);
      });

      it('should checkout tag', async () => {
        await gitService.checkout(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['checkout', '--end-of-options', 'v1.0.0']);
      });
    });

    describe('Checkout with createBranch option', () => {
      it('should include -b flag when createBranch is true', async () => {
        await gitService.checkout(mockRepo, 'new-branch', { createBranch: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('-b'), 'Should include -b flag');
        assert.ok(lastCommand.args.includes('new-branch'), 'Should include branch name');
      });

      it('should not include -b flag when createBranch is false', async () => {
        await gitService.checkout(mockRepo, 'existing-branch', { createBranch: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('-b'), 'Should not include -b flag');
      });
    });

    describe('Checkout with force option', () => {
      it('should include -f flag when force is true', async () => {
        await gitService.checkout(mockRepo, 'branch', { force: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('-f'), 'Should include -f flag');
      });

      it('should not include -f flag when force is false', async () => {
        await gitService.checkout(mockRepo, 'branch', { force: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('-f'), 'Should not include -f flag');
      });
    });

    describe('Checkout with track option', () => {
      it('should include --track with remote branch when track is specified', async () => {
        await gitService.checkout(mockRepo, 'local-branch', { track: 'origin/remote-branch' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--track'), 'Should include --track flag');
        assert.ok(
          lastCommand.args.includes('origin/remote-branch'),
          'Should include remote branch'
        );
      });
    });

    describe('Checkout with combined options', () => {
      it('should include all flags when multiple options are set', async () => {
        await gitService.checkout(mockRepo, 'new-branch', {
          createBranch: true,
          force: true,
          track: 'origin/feature',
        });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('-b'), 'Should include -b flag');
        assert.ok(lastCommand.args.includes('-f'), 'Should include -f flag');
        assert.ok(lastCommand.args.includes('--track'), 'Should include --track flag');
        assert.ok(lastCommand.args.includes('origin/feature'), 'Should include remote branch');
      });
    });
  });

  describe('deleteBranch()', () => {
    describe('Basic branch deletion', () => {
      it('should execute git branch -d with branch name', async () => {
        await gitService.deleteBranch(mockRepo, 'old-feature');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Name follows `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          '-d',
          '--end-of-options',
          'old-feature',
        ]);
      });

      it('should pass the correct working directory', async () => {
        await gitService.deleteBranch(mockRepo, 'old-feature');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw error when deleting unmerged branch without force', async () => {
        // Argv shape now `branch -d --end-of-options unmerged-branch`.
        mockGitCli.setMockResult('branch -d --end-of-options unmerged-branch', {
          exitCode: 1,
          stdout: '',
          stderr: "error: The branch 'unmerged-branch' is not fully merged.",
        });

        const result = await gitService.deleteBranch(mockRepo, 'unmerged-branch');
        assert.ok(
          result.isErr(),
          'deleteBranch must surface a failed Result for an unmerged branch'
        );
        assert.match(result.error.message, /Git command failed/);
      });
    });

    describe('Force branch deletion', () => {
      it('should execute git branch -D when force is true', async () => {
        await gitService.deleteBranch(mockRepo, 'unmerged-branch', true);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Name follows `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          '-D',
          '--end-of-options',
          'unmerged-branch',
        ]);
      });

      it('should execute git branch -d when force is false', async () => {
        await gitService.deleteBranch(mockRepo, 'merged-branch', false);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Name follows `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          '-d',
          '--end-of-options',
          'merged-branch',
        ]);
      });

      it('should execute git branch -d when force is undefined', async () => {
        await gitService.deleteBranch(mockRepo, 'merged-branch');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Name follows `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          '-d',
          '--end-of-options',
          'merged-branch',
        ]);
      });
    });
  });

  describe('renameBranch()', () => {
    describe('Basic branch renaming', () => {
      it('should execute git branch -m with old and new names', async () => {
        await gitService.renameBranch(mockRepo, 'old-name', 'new-name');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Names follow `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          '-m',
          '--end-of-options',
          'old-name',
          'new-name',
        ]);
      });

      it('should pass the correct working directory', async () => {
        await gitService.renameBranch(mockRepo, 'old-name', 'new-name');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw error when branch does not exist', async () => {
        // Argv shape now `branch -m --end-of-options...`.
        mockGitCli.setMockResult('branch -m --end-of-options nonexistent new-name', {
          exitCode: 128,
          stdout: '',
          stderr: 'error: refname refs/heads/nonexistent not found',
        });

        const result = await gitService.renameBranch(mockRepo, 'nonexistent', 'new-name');
        assert.ok(
          result.isErr(),
          'renameBranch must surface a failed Result when branch is missing'
        );
        assert.match(result.error.message, /Git command failed/);
      });

      it('should throw error when new name already exists', async () => {
        // Argv shape now `branch -m --end-of-options...`.
        mockGitCli.setMockResult('branch -m --end-of-options old-name existing-name', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: A branch named 'existing-name' already exists.",
        });

        const result = await gitService.renameBranch(mockRepo, 'old-name', 'existing-name');
        assert.ok(result.isErr(), 'renameBranch must surface a failed Result when target exists');
        assert.match(result.error.message, /Git command failed/);
      });

      it('should handle branch names with special characters', async () => {
        await gitService.renameBranch(mockRepo, 'feature/old-name', 'feature/new-name');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Names follow `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, [
          'branch',
          '-m',
          '--end-of-options',
          'feature/old-name',
          'feature/new-name',
        ]);
      });
    });
  });

  // setBranchUpstream argv structure.
  describe('setBranchUpstream() — Wave K WK-3', () => {
    it('setBranchUpstream-1: argv structure (branch + --set-upstream-to=<ref> + --end-of-options + localName)', async () => {
      await gitService.setBranchUpstream(mockRepo, 'feature', 'origin/feature');

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      // Shape — splice `--end-of-options` between flag and the
      // user-controlled local-branch name. `--set-upstream-to=…` carries
      // the upstream ref inline so it remains a single token (matching
      // git's parser).
      assert.deepStrictEqual(lastCommand.args, [
        'branch',
        '--set-upstream-to=origin/feature',
        '--end-of-options',
        'feature',
      ]);
    });

    it('refuses local names starting with -', async () => {
      const result = await gitService.setBranchUpstream(mockRepo, '-evil', 'origin/main');
      assert.ok(result.isErr(), 'Should refuse leading-dash names (CLI-flag injection guard)');
      assert.match(result.error.message, /Invalid branch name/);
    });

    it('refuses local names starting with .', async () => {
      const result = await gitService.setBranchUpstream(mockRepo, '.hidden', 'origin/main');
      assert.ok(result.isErr());
      assert.match(result.error.message, /Invalid branch name/);
    });

    it('refuses upstream refs starting with -', async () => {
      const result = await gitService.setBranchUpstream(mockRepo, 'feature', '-evil');
      assert.ok(result.isErr());
      assert.match(result.error.message, /Invalid upstream ref/);
    });

    // SK-3 — symmetric leading-`.` guard on upstreamRef.
    // createBranch / deleteBranch / renameBranch all reject BOTH `-`
    // and `.` per validateBranchName; setBranchUpstream's upstreamRef
    // must match (git-check-ref-format forbids leading `.` segments).
    it('refuses upstream refs starting with .', async () => {
      const result = await gitService.setBranchUpstream(mockRepo, 'feature', '.hidden');
      assert.ok(
        result.isErr(),
        'leading `.` upstream refs must refuse (git-check-ref-format parity)'
      );
      assert.match(result.error.message, /Invalid upstream ref/);
    });
  });
});

/**
 * Unit tests for GitService hunk and line staging operations.
 *
 * Tests cover:
 * - stageHunk() for staging individual hunks
 * - stageLines() for staging specific lines
 * - unstageHunk() for unstaging hunks
 */
describe('GitService - Hunk and Line Staging Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('stageHunk()', () => {
    describe('Basic hunk staging', () => {
      it('should execute git apply --cached with patch input', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          header: '@@ -1,3 +1,4 @@',
          lines: [
            { type: 'context' as const, content: 'line 1' },
            { type: 'add' as const, content: 'new line' },
            { type: 'context' as const, content: 'line 2' },
            { type: 'context' as const, content: 'line 3' },
          ],
        };

        await gitService.stageHunk(mockRepo, 'test.ts', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['apply', '--cached', '-']);
      });

      it('should pass the correct working directory', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          header: '@@ -1,1 +1,2 @@',
          lines: [
            { type: 'context' as const, content: 'existing' },
            { type: 'add' as const, content: 'new' },
          ],
        };

        await gitService.stageHunk(mockRepo, 'test.ts', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should generate correct patch for additions', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          header: '@@ -1,2 +1,3 @@',
          lines: [
            { type: 'context' as const, content: 'line 1' },
            { type: 'add' as const, content: 'added line' },
            { type: 'context' as const, content: 'line 2' },
          ],
        };

        await gitService.stageHunk(mockRepo, 'src/file.ts', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        const input = (lastCommand.options as { input: string }).input;
        assert.ok(input, 'Should have input');
        assert.ok(
          input.includes('diff --git a/src/file.ts b/src/file.ts'),
          'Should have diff header'
        );
        assert.ok(input.includes('+added line'), 'Should have added line');
        assert.ok(input.includes(' line 1'), 'Should have context line');
      });

      it('should generate correct patch for deletions', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 2,
          header: '@@ -1,3 +1,2 @@',
          lines: [
            { type: 'context' as const, content: 'line 1' },
            { type: 'delete' as const, content: 'deleted line' },
            { type: 'context' as const, content: 'line 2' },
          ],
        };

        await gitService.stageHunk(mockRepo, 'src/file.ts', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        const input = (lastCommand.options as { input: string }).input;
        assert.ok(input, 'Should have input');
        assert.ok(input.includes('-deleted line'), 'Should have deleted line');
      });

      it('should generate correct patch for mixed changes', async () => {
        const hunk = {
          oldStart: 5,
          oldLines: 4,
          newStart: 5,
          newLines: 5,
          header: '@@ -5,4 +5,5 @@',
          lines: [
            { type: 'context' as const, content: 'context before' },
            { type: 'delete' as const, content: 'old line' },
            { type: 'add' as const, content: 'new line 1' },
            { type: 'add' as const, content: 'new line 2' },
            { type: 'context' as const, content: 'context after' },
          ],
        };

        await gitService.stageHunk(mockRepo, 'test.ts', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        const input = (lastCommand.options as { input: string }).input;
        assert.ok(input, 'Should have input');
        assert.ok(input.includes('-old line'), 'Should have deleted line');
        assert.ok(input.includes('+new line 1'), 'Should have first added line');
        assert.ok(input.includes('+new line 2'), 'Should have second added line');
      });

      it('should handle files in subdirectories', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          header: '@@ -1,1 +1,2 @@',
          lines: [
            { type: 'context' as const, content: 'line' },
            { type: 'add' as const, content: 'new' },
          ],
        };

        await gitService.stageHunk(mockRepo, 'src/components/Button.tsx', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        const input = (lastCommand.options as { input: string }).input;
        assert.ok(input, 'Should have input');
        assert.ok(input.includes('a/src/components/Button.tsx'), 'Should have correct path');
        assert.ok(input.includes('b/src/components/Button.tsx'), 'Should have correct path');
      });
    });
  });

  describe('unstageHunk()', () => {
    describe('Basic hunk unstaging', () => {
      it('should execute git apply --cached -R with patch input', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          header: '@@ -1,3 +1,4 @@',
          lines: [
            { type: 'context' as const, content: 'line 1' },
            { type: 'add' as const, content: 'new line' },
            { type: 'context' as const, content: 'line 2' },
            { type: 'context' as const, content: 'line 3' },
          ],
        };

        await gitService.unstageHunk(mockRepo, 'test.ts', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['apply', '--cached', '-R', '-']);
      });

      it('should pass the correct working directory', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          header: '@@ -1,1 +1,2 @@',
          lines: [
            { type: 'context' as const, content: 'existing' },
            { type: 'add' as const, content: 'new' },
          ],
        };

        await gitService.unstageHunk(mockRepo, 'test.ts', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should generate the same patch as stageHunk for reverse application', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          header: '@@ -1,2 +1,3 @@',
          lines: [
            { type: 'context' as const, content: 'line 1' },
            { type: 'add' as const, content: 'added line' },
            { type: 'context' as const, content: 'line 2' },
          ],
        };

        await gitService.unstageHunk(mockRepo, 'src/file.ts', hunk);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        const input = (lastCommand.options as { input: string }).input;
        assert.ok(input, 'Should have input');
        assert.ok(
          input.includes('diff --git a/src/file.ts b/src/file.ts'),
          'Should have diff header'
        );
        assert.ok(input.includes('+added line'), 'Should have added line (will be reversed)');
      });
    });
  });

  describe('revertHunk() (#P2 working-tree discard hunk)', () => {
    const hunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      header: '@@ -1,2 +1,3 @@',
      lines: [
        { type: 'context' as const, content: 'line 1' },
        { type: 'add' as const, content: 'added line' },
        { type: 'context' as const, content: 'line 2' },
      ],
    };

    it('reverse-applies to the WORKING TREE (no --cached, unlike unstageHunk)', async () => {
      await gitService.revertHunk(mockRepo, 'src/file.ts', hunk);

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      // IntelliJ "Revert Chunk" discards the working-tree change: git apply -R
      // WITHOUT --cached (that distinguishes it from unstageHunk).
      assert.deepStrictEqual(lastCommand.args, ['apply', '-R', '-']);
    });

    it('passes the repo root as cwd', async () => {
      await gitService.revertHunk(mockRepo, 'src/file.ts', hunk);
      const lastCommand = mockGitCli.getLastCommand();
      assert.strictEqual((lastCommand!.options as { cwd: string }).cwd, '/test/repo');
    });

    it('feeds the same hunk patch that stageHunk generates', async () => {
      await gitService.revertHunk(mockRepo, 'src/file.ts', hunk);
      const input = (mockGitCli.getLastCommand()!.options as { input: string }).input;
      assert.ok(input.includes('diff --git a/src/file.ts b/src/file.ts'), 'has diff header');
      assert.ok(input.includes('+added line'), 'has the added line (reversed on apply)');
    });
  });

  describe('stageLines()', () => {
    describe('Basic line staging', () => {
      it('should execute git apply --cached with patch input', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 4,
          header: '@@ -1,2 +1,4 @@',
          lines: [
            { type: 'context' as const, content: 'line 1' },
            { type: 'add' as const, content: 'new line 1' },
            { type: 'add' as const, content: 'new line 2' },
            { type: 'context' as const, content: 'line 2' },
          ],
        };

        await gitService.stageLines(
          mockRepo,
          'test.ts',
          { addLines: new Set([2]), deleteLines: new Set() },
          hunk
        );

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['apply', '--cached', '-']);
      });

      it('should pass the correct working directory', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          header: '@@ -1,1 +1,2 @@',
          lines: [
            { type: 'context' as const, content: 'existing' },
            { type: 'add' as const, content: 'new' },
          ],
        };

        await gitService.stageLines(
          mockRepo,
          'test.ts',
          { addLines: new Set([2]), deleteLines: new Set() },
          hunk
        );

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should not execute any command when lines array is empty', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          header: '@@ -1,2 +1,3 @@',
          lines: [
            { type: 'context' as const, content: 'line 1' },
            { type: 'add' as const, content: 'new line' },
            { type: 'context' as const, content: 'line 2' },
          ],
        };

        mockGitCli.clearCommands();
        await gitService.stageLines(
          mockRepo,
          'test.ts',
          { addLines: new Set(), deleteLines: new Set() },
          hunk
        );

        assert.strictEqual(mockGitCli.executedCommands.length, 0, 'No commands should be executed');
      });

      it('should handle files in subdirectories', async () => {
        const hunk = {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          header: '@@ -1,1 +1,2 @@',
          lines: [
            { type: 'context' as const, content: 'line' },
            { type: 'add' as const, content: 'new' },
          ],
        };

        await gitService.stageLines(
          mockRepo,
          'src/components/Button.tsx',
          { addLines: new Set([2]), deleteLines: new Set() },
          hunk
        );

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        const input = (lastCommand.options as { input: string }).input;
        assert.ok(input, 'Should have input');
        assert.ok(input.includes('a/src/components/Button.tsx'), 'Should have correct path');
        assert.ok(input.includes('b/src/components/Button.tsx'), 'Should have correct path');
      });
    });
  });
});

/**
 * Unit tests for GitService merge and rebase operations.
 *
 * Tests cover:
 * - mergeBranch() with conflict detection
 * - rebaseBranch() with conflict detection
 */
describe('GitService - Merge and Rebase Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('mergeBranch()', () => {
    describe('Successful merge', () => {
      it('should execute git merge with branch name', async () => {
        mockGitCli.setMockResult('merge --end-of-options feature-branch', {
          exitCode: 0,
          stdout: "Merge made by the 'ort' strategy.",
          stderr: '',
        });
        mockGitCli.setMockResult('rev-parse HEAD', {
          exitCode: 0,
          stdout: 'def456789abc\n',
          stderr: '',
        });

        await gitService.mergeBranch(mockRepo, 'feature-branch');

        // Find the merge command in executed commands
        const mergeCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'merge');
        assert.ok(mergeCommand, 'Merge command should have been executed');
        assert.deepStrictEqual(mergeCommand.args, ['merge', '--end-of-options', 'feature-branch']);
      });

      it('should pass the correct working directory', async () => {
        mockGitCli.setMockResult('merge --end-of-options feature-branch', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });
        mockGitCli.setMockResult('rev-parse HEAD', {
          exitCode: 0,
          stdout: 'abc123\n',
          stderr: '',
        });

        await gitService.mergeBranch(mockRepo, 'feature-branch');

        const mergeCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'merge');
        assert.ok(mergeCommand, 'Merge command should have been executed');
        assert.strictEqual((mergeCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return success with merge commit hash on successful merge', async () => {
        mockGitCli.setMockResult('merge --end-of-options feature-branch', {
          exitCode: 0,
          stdout: "Merge made by the 'ort' strategy.",
          stderr: '',
        });
        mockGitCli.setMockResult('rev-parse HEAD', {
          exitCode: 0,
          stdout: 'def456789abc\n',
          stderr: '',
        });

        const result = await gitService.mergeBranch(mockRepo, 'feature-branch');

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.mergeCommit, 'def456789abc');
        assert.strictEqual(result.conflicts, undefined);
      });

      it('should handle fast-forward merge', async () => {
        mockGitCli.setMockResult('merge --end-of-options feature-branch', {
          exitCode: 0,
          stdout: 'Fast-forward',
          stderr: '',
        });
        mockGitCli.setMockResult('rev-parse HEAD', {
          exitCode: 0,
          stdout: 'newhead123\n',
          stderr: '',
        });

        const result = await gitService.mergeBranch(mockRepo, 'feature-branch');

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.mergeCommit, 'newhead123');
      });
    });

    describe('Merge with conflicts', () => {
      it('should return failure with conflicts when merge fails', async () => {
        mockGitCli.setMockResult('merge --end-of-options feature-branch', {
          exitCode: 1,
          stdout: '',
          stderr: 'CONFLICT (content): Merge conflict in file.ts',
        });
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU file.ts\nUU another.ts\n',
          stderr: '',
        });

        const result = await gitService.mergeBranch(mockRepo, 'feature-branch');

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.deepStrictEqual(result.conflicts, ['file.ts', 'another.ts']);
        assert.strictEqual(result.mergeCommit, undefined);
      });

      it('should detect conflicts with different status codes', async () => {
        mockGitCli.setMockResult('merge --end-of-options conflicting-branch', {
          exitCode: 1,
          stdout: '',
          stderr: 'Automatic merge failed',
        });
        // UU = both modified, AA = both added, DD = both deleted
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU both-modified.ts\nAA both-added.ts\nUD deleted-by-them.ts\n',
          stderr: '',
        });

        const result = await gitService.mergeBranch(mockRepo, 'conflicting-branch');

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        // All files with U in either position should be detected as conflicts
        assert.ok(result.conflicts.includes('both-modified.ts'));
        assert.ok(result.conflicts.includes('deleted-by-them.ts'));
      });

      it('should return empty conflicts array when merge fails but no conflicts', async () => {
        mockGitCli.setMockResult('merge --end-of-options invalid-branch', {
          exitCode: 128,
          stdout: '',
          stderr: 'merge: invalid-branch - not something we can merge',
        });
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'M modified.ts\n',
          stderr: '',
        });

        const result = await gitService.mergeBranch(mockRepo, 'invalid-branch');

        assert.strictEqual(result.success, false);
        assert.deepStrictEqual(result.conflicts, []);
      });
    });

    describe('Merge with different branch types', () => {
      it('should merge remote branch', async () => {
        mockGitCli.setMockResult('merge --end-of-options origin/feature', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });
        mockGitCli.setMockResult('rev-parse HEAD', {
          exitCode: 0,
          stdout: 'abc123\n',
          stderr: '',
        });

        const result = await gitService.mergeBranch(mockRepo, 'origin/feature');

        assert.strictEqual(result.success, true);
        const mergeCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'merge');
        assert.ok(mergeCommand);
        assert.deepStrictEqual(mergeCommand.args, ['merge', '--end-of-options', 'origin/feature']);
      });

      it('should merge commit hash', async () => {
        mockGitCli.setMockResult('merge --end-of-options abc123def456', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });
        mockGitCli.setMockResult('rev-parse HEAD', {
          exitCode: 0,
          stdout: 'newhead\n',
          stderr: '',
        });

        const result = await gitService.mergeBranch(mockRepo, 'abc123def456');

        assert.strictEqual(result.success, true);
      });

      it('should merge tag', async () => {
        mockGitCli.setMockResult('merge --end-of-options v1.0.0', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });
        mockGitCli.setMockResult('rev-parse HEAD', {
          exitCode: 0,
          stdout: 'tagcommit\n',
          stderr: '',
        });

        const result = await gitService.mergeBranch(mockRepo, 'v1.0.0');

        assert.strictEqual(result.success, true);
      });
    });

    describe('options: --no-verify / --allow-unrelated-histories (#P2)', () => {
      function mergeArgs(): string[] {
        return mockGitCli.executedCommands.find((c) => c.args[0] === 'merge')!.args;
      }

      it('adds --no-verify before the ref guard', async () => {
        await gitService.mergeBranch(mockRepo, 'feature', { noVerify: true });
        assert.deepStrictEqual(mergeArgs(), [
          'merge',
          '--no-verify',
          '--end-of-options',
          'feature',
        ]);
      });

      it('adds --allow-unrelated-histories', async () => {
        await gitService.mergeBranch(mockRepo, 'feature', { allowUnrelatedHistories: true });
        assert.deepStrictEqual(mergeArgs(), [
          'merge',
          '--allow-unrelated-histories',
          '--end-of-options',
          'feature',
        ]);
      });

      it('combines them after the strategy flag, in declaration order', async () => {
        await gitService.mergeBranch(mockRepo, 'feature', {
          noFf: true,
          noVerify: true,
          allowUnrelatedHistories: true,
        });
        assert.deepStrictEqual(mergeArgs(), [
          'merge',
          '--no-ff',
          '--no-verify',
          '--allow-unrelated-histories',
          '--end-of-options',
          'feature',
        ]);
      });
    });
  });

  describe('rebaseBranch()', () => {
    describe('Successful rebase', () => {
      it('should execute git rebase with onto branch', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options main', {
          exitCode: 0,
          stdout: 'Successfully rebased and updated refs/heads/feature.',
          stderr: '',
        });

        await gitService.rebaseBranch(mockRepo, 'main');

        const rebaseCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'rebase');
        assert.ok(rebaseCommand, 'Rebase command should have been executed');
        // `--autostash` is spliced before `--end-of-options` so git stashes a
        // dirty tree before replaying and re-applies it after, instead of
        // dead-ending on "cannot rebase: you have unstaged changes".
        assert.deepStrictEqual(rebaseCommand.args, [
          'rebase',
          '--autostash',
          '--end-of-options',
          'main',
        ]);
      });

      it('should pass the correct working directory', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options main', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.rebaseBranch(mockRepo, 'main');

        const rebaseCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'rebase');
        assert.ok(rebaseCommand, 'Rebase command should have been executed');
        assert.strictEqual((rebaseCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return success on successful rebase', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options main', {
          exitCode: 0,
          stdout: 'Successfully rebased and updated refs/heads/feature.',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'main');

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.conflicts, undefined);
      });

      it('should handle rebase with no changes needed', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options main', {
          exitCode: 0,
          stdout: 'Current branch feature is up to date.',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'main');

        assert.strictEqual(result.success, true);
      });
    });

    describe('Rebase with conflicts', () => {
      it('should return failure with conflicts when rebase fails', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options main', {
          exitCode: 1,
          stdout: '',
          stderr: 'CONFLICT (content): Merge conflict in file.ts',
        });
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU file.ts\nUU another.ts\n',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'main');

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.deepStrictEqual(result.conflicts, ['file.ts', 'another.ts']);
      });

      it('should detect conflicts with different status codes', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options develop', {
          exitCode: 1,
          stdout: '',
          stderr: 'Automatic merge failed',
        });
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU both-modified.ts\nDU deleted-by-us.ts\n',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'develop');

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.deepStrictEqual(result.conflicts, ['both-modified.ts', 'deleted-by-us.ts']);
      });

      it('reports an exit-0 autostash pop conflict as a non-continuable conflict', async () => {
        // With `--autostash`, git stashes a dirty tree, replays cleanly, then
        // pops the stash. If that pop collides with the rebased changes git
        // leaves unmerged files in the tree but STILL exits 0. The rebase is
        // already complete (no rebase in progress), so the conflict is listed
        // (resolve dialog opens) but marked non-continuable — continue/abort
        // must not be offered, since they would dead-end.
        mockGitCli.setMockResult('rebase --autostash --end-of-options main', {
          exitCode: 0,
          stdout: 'Applying autostash resulted in conflicts.',
          stderr: '',
        });
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU shared.ts\n',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'main');

        assert.strictEqual(result.success, false);
        assert.deepStrictEqual(result.conflicts, ['shared.ts']);
        assert.strictEqual(result.rebaseInProgress, false);
        assert.strictEqual(result.failureReason, undefined);
      });

      it('returns success when rebase exits 0 with a clean tree', async () => {
        // The exit-0 unmerged-files guard must not regress the common case:
        // a clean autostash round-trip reports no unmerged files and succeeds.
        mockGitCli.setMockResult('rebase --autostash --end-of-options main', {
          exitCode: 0,
          stdout: 'Successfully rebased and updated refs/heads/feature.',
          stderr: '',
        });
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'main');

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.conflicts, undefined);
      });

      it('should return empty conflicts array when rebase fails but no conflicts', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options invalid-branch', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: invalid upstream 'invalid-branch'",
        });
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'M modified.ts\n',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'invalid-branch');

        assert.strictEqual(result.success, false);
        assert.deepStrictEqual(result.conflicts, []);
      });
    });

    describe('Rebase with different branch types', () => {
      it('should rebase onto remote branch', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options origin/main', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'origin/main');

        assert.strictEqual(result.success, true);
        const rebaseCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'rebase');
        assert.ok(rebaseCommand);
        assert.deepStrictEqual(rebaseCommand.args, [
          'rebase',
          '--autostash',
          '--end-of-options',
          'origin/main',
        ]);
      });

      it('should rebase onto commit hash', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options abc123def456', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'abc123def456');

        assert.strictEqual(result.success, true);
      });

      it('should rebase onto tag', async () => {
        mockGitCli.setMockResult('rebase --autostash --end-of-options v1.0.0', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = await gitService.rebaseBranch(mockRepo, 'v1.0.0');

        assert.strictEqual(result.success, true);
      });
    });
  });
});

/**
 * Unit tests for GitService branch comparison operations.
 *
 * Tests cover:
 * - compareBranches() for comparing two branches
 * - Calculating commits unique to each branch
 * - Calculating files that differ between branches
 * - Calculating ahead/behind counts
 */
describe('GitService - Branch Comparison Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('compareBranches()', () => {
    describe('Ahead/behind count calculation', () => {
      it('should calculate ahead/behind counts correctly', async () => {
        // Mock the rev-list --left-right --count command
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...develop', {
          exitCode: 0,
          stdout: '3\t2\n',
          stderr: '',
        });

        // Mock the log commands for commits ahead and behind using prefix matching
        // Format: hash|shortHash|authorName|authorEmail|authorDate|committerName|committerEmail|commitDate|parents|subject\nbody
        mockGitCli.setMockResultByPrefix('log --format=%H%h%an%ae%aI%cn%ce%cI%P%s', {
          exitCode: 0,
          stdout:
            'abc123abc1Authorauthor@test.com2024-01-01T00:00:00ZCommittercommitter@test.com2024-01-01T00:00:00ZCommit 1\n\x00' +
            'def456def4Authorauthor@test.com2024-01-02T00:00:00ZCommittercommitter@test.com2024-01-02T00:00:00ZCommit 2\n\x00' +
            'ghi789ghi7Authorauthor@test.com2024-01-03T00:00:00ZCommittercommitter@test.com2024-01-03T00:00:00ZCommit 3\n\x00',
          stderr: '',
        });

        // Mock the diff command — `-z` splits on `\0`.
        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...develop', {
          exitCode: 0,
          stdout: 'file1.ts\0file2.ts\0',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'develop');

        assert.strictEqual(result.aheadCount, 3, 'Should have 3 commits ahead');
        assert.strictEqual(result.behindCount, 2, 'Should have 2 commits behind');
      });

      it('should handle zero ahead/behind counts', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...main', {
          exitCode: 0,
          stdout: '0\t0\n',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...main', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'main');

        assert.strictEqual(result.aheadCount, 0);
        assert.strictEqual(result.behindCount, 0);
        assert.deepStrictEqual(result.commitsAhead, []);
        assert.deepStrictEqual(result.commitsBehind, []);
      });

      it('should handle only ahead commits (no behind)', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options feature...main', {
          exitCode: 0,
          stdout: '2\t0\n',
          stderr: '',
        });

        // Format: hash|shortHash|authorName|authorEmail|authorDate|committerName|committerEmail|commitDate|parents|subject\nbody
        mockGitCli.setMockResultByPrefix('log --format=%H%h%an%ae%aI%cn%ce%cI%P%s', {
          exitCode: 0,
          stdout:
            'abc123abc1Authorauthor@test.com2024-01-01T00:00:00ZCommittercommitter@test.com2024-01-01T00:00:00ZFeature commit 1\n\x00' +
            'def456def4Authorauthor@test.com2024-01-02T00:00:00ZCommittercommitter@test.com2024-01-02T00:00:00ZFeature commit 2\n\x00',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options feature...main', {
          exitCode: 0,
          stdout: 'feature.ts\0',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'feature', 'main');

        assert.strictEqual(result.aheadCount, 2);
        assert.strictEqual(result.behindCount, 0);
        assert.strictEqual(result.commitsAhead.length, 2);
        assert.deepStrictEqual(result.commitsBehind, []);
      });

      it('should handle only behind commits (no ahead)', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...feature', {
          exitCode: 0,
          stdout: '0\t3\n',
          stderr: '',
        });

        // Format: hash|shortHash|authorName|authorEmail|authorDate|committerName|committerEmail|commitDate|parents|subject\nbody
        mockGitCli.setMockResultByPrefix('log --format=%H%h%an%ae%aI%cn%ce%cI%P%s', {
          exitCode: 0,
          stdout:
            'abc123abc1Authorauthor@test.com2024-01-01T00:00:00ZCommittercommitter@test.com2024-01-01T00:00:00ZBehind commit 1\n\x00' +
            'def456def4Authorauthor@test.com2024-01-02T00:00:00ZCommittercommitter@test.com2024-01-02T00:00:00ZBehind commit 2\n\x00' +
            'ghi789ghi7Authorauthor@test.com2024-01-03T00:00:00ZCommittercommitter@test.com2024-01-03T00:00:00ZBehind commit 3\n\x00',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...feature', {
          exitCode: 0,
          stdout: 'file.ts\0',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'feature');

        assert.strictEqual(result.aheadCount, 0);
        assert.strictEqual(result.behindCount, 3);
        assert.deepStrictEqual(result.commitsAhead, []);
        assert.strictEqual(result.commitsBehind.length, 3);
      });
    });

    describe('Commits unique to each branch', () => {
      it('should return commits unique to branch1 (ahead)', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...develop', {
          exitCode: 0,
          stdout: '2\t0\n',
          stderr: '',
        });

        // Format: hash|shortHash|authorName|authorEmail|authorDate|committerName|committerEmail|commitDate|parents|subject\nbody
        mockGitCli.setMockResultByPrefix('log --format=%H%h%an%ae%aI%cn%ce%cI%P%s', {
          exitCode: 0,
          stdout:
            'abc123fullabc1John Doejohn@test.com2024-01-01T10:00:00ZJohn Doejohn@test.com2024-01-01T10:00:00ZFirst unique commit\n\x00' +
            'def456fulldef4Jane Doejane@test.com2024-01-02T10:00:00ZJane Doejane@test.com2024-01-02T10:00:00ZSecond unique commit\n\x00',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...develop', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'develop');

        assert.strictEqual(result.commitsAhead.length, 2);
        assert.strictEqual(result.commitsAhead[0].message, 'First unique commit');
        assert.strictEqual(result.commitsAhead[0].author.name, 'John Doe');
        assert.strictEqual(result.commitsAhead[1].message, 'Second unique commit');
        assert.strictEqual(result.commitsAhead[1].author.name, 'Jane Doe');
      });

      it('should return commits unique to branch2 (behind)', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...develop', {
          exitCode: 0,
          stdout: '0\t2\n',
          stderr: '',
        });

        // Format: hash|shortHash|authorName|authorEmail|authorDate|committerName|committerEmail|commitDate|parents|subject\nbody
        mockGitCli.setMockResultByPrefix('log --format=%H%h%an%ae%aI%cn%ce%cI%P%s', {
          exitCode: 0,
          stdout:
            'xyz789fullxyz7Dev Authordev@test.com2024-01-03T10:00:00ZDev Authordev@test.com2024-01-03T10:00:00ZDevelop commit 1\n\x00' +
            'uvw012fulluvw0Dev Authordev@test.com2024-01-04T10:00:00ZDev Authordev@test.com2024-01-04T10:00:00ZDevelop commit 2\n\x00',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...develop', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'develop');

        assert.strictEqual(result.commitsBehind.length, 2);
        assert.strictEqual(result.commitsBehind[0].message, 'Develop commit 1');
        assert.strictEqual(result.commitsBehind[1].message, 'Develop commit 2');
      });
    });

    describe('Files that differ between branches', () => {
      it('should return list of changed files', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...develop', {
          exitCode: 0,
          stdout: '1\t1\n',
          stderr: '',
        });

        // Format: hash|shortHash|authorName|authorEmail|authorDate|committerName|committerEmail|commitDate|parents|subject\nbody
        mockGitCli.setMockResultByPrefix('log --format=%H%h%an%ae%aI%cn%ce%cI%P%s', {
          exitCode: 0,
          stdout:
            'abc123abc1Authora@test.com2024-01-01T00:00:00ZAuthora@test.com2024-01-01T00:00:00ZCommit\n\x00',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...develop', {
          exitCode: 0,
          stdout: 'src/file1.ts\0src/file2.ts\0test/file3.test.ts\0README.md\0',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'develop');

        assert.strictEqual(result.changedFiles.length, 4);
        assert.ok(result.changedFiles.includes('src/file1.ts'));
        assert.ok(result.changedFiles.includes('src/file2.ts'));
        assert.ok(result.changedFiles.includes('test/file3.test.ts'));
        assert.ok(result.changedFiles.includes('README.md'));
      });

      it('should return empty array when no files differ', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...main', {
          exitCode: 0,
          stdout: '0\t0\n',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...main', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'main');

        assert.deepStrictEqual(result.changedFiles, []);
      });

      it('should handle files with spaces in names', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...develop', {
          exitCode: 0,
          stdout: '0\t0\n',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...develop', {
          exitCode: 0,
          stdout: 'path with spaces/file name.ts\0normal-file.ts\0',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'develop');

        assert.strictEqual(result.changedFiles.length, 2);
        assert.ok(result.changedFiles.includes('path with spaces/file name.ts'));
        assert.ok(result.changedFiles.includes('normal-file.ts'));
      });
    });

    describe('Comparing with remote branches', () => {
      it('should compare local branch with remote tracking branch', async () => {
        mockGitCli.setMockResult(
          'rev-list --left-right --count --end-of-options main...origin/main',
          {
            exitCode: 0,
            stdout: '5\t2\n',
            stderr: '',
          }
        );

        // Format: hash|shortHash|authorName|authorEmail|authorDate|committerName|committerEmail|commitDate|parents|subject\nbody
        mockGitCli.setMockResultByPrefix('log --format=%H%h%an%ae%aI%cn%ce%cI%P%s', {
          exitCode: 0,
          stdout:
            'local1loc1Authora@test.com2024-01-01T00:00:00ZAuthora@test.com2024-01-01T00:00:00ZLocal commit 1\n\x00' +
            'local2loc2Authora@test.com2024-01-02T00:00:00ZAuthora@test.com2024-01-02T00:00:00ZLocal commit 2\n\x00' +
            'local3loc3Authora@test.com2024-01-03T00:00:00ZAuthora@test.com2024-01-03T00:00:00ZLocal commit 3\n\x00' +
            'local4loc4Authora@test.com2024-01-04T00:00:00ZAuthora@test.com2024-01-04T00:00:00ZLocal commit 4\n\x00' +
            'local5loc5Authora@test.com2024-01-05T00:00:00ZAuthora@test.com2024-01-05T00:00:00ZLocal commit 5\n\x00',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...origin/main', {
          exitCode: 0,
          stdout: 'remote-changes.ts\0',
          stderr: '',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'origin/main');

        assert.strictEqual(result.aheadCount, 5, 'Should be 5 commits ahead of remote');
        assert.strictEqual(result.behindCount, 2, 'Should be 2 commits behind remote');
        // Note: With prefix matching, both ahead and behind will use the same mock
        // so we verify the counts are correct
      });
    });

    describe('Error handling', () => {
      it('should handle rev-list command failure gracefully', async () => {
        mockGitCli.setMockResult(
          'rev-list --left-right --count --end-of-options main...nonexistent',
          {
            exitCode: 128,
            stdout: '',
            stderr: "fatal: ambiguous argument 'nonexistent': unknown revision",
          }
        );

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...nonexistent', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: ambiguous argument 'nonexistent': unknown revision",
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'nonexistent');

        // Should return zeros when command fails
        assert.strictEqual(result.aheadCount, 0);
        assert.strictEqual(result.behindCount, 0);
        assert.deepStrictEqual(result.commitsAhead, []);
        assert.deepStrictEqual(result.commitsBehind, []);
        assert.deepStrictEqual(result.changedFiles, []);
      });

      it('should handle diff command failure gracefully', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...develop', {
          exitCode: 0,
          stdout: '1\t1\n',
          stderr: '',
        });

        // Format: hash|shortHash|authorName|authorEmail|authorDate|committerName|committerEmail|commitDate|parents|subject\nbody
        mockGitCli.setMockResultByPrefix('log --format=%H%h%an%ae%aI%cn%ce%cI%P%s', {
          exitCode: 0,
          stdout:
            'abc123abc1Authora@test.com2024-01-01T00:00:00ZAuthora@test.com2024-01-01T00:00:00ZCommit\n\x00',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...develop', {
          exitCode: 1,
          stdout: '',
          stderr: 'error',
        });

        const result = await gitService.compareBranches(mockRepo, 'main', 'develop');

        // Should still return commit info even if diff fails
        assert.strictEqual(result.aheadCount, 1);
        assert.strictEqual(result.behindCount, 1);
        assert.deepStrictEqual(result.changedFiles, []);
      });
    });

    describe('Working directory', () => {
      it('should pass the correct working directory to all commands', async () => {
        mockGitCli.setMockResult('rev-list --left-right --count --end-of-options main...develop', {
          exitCode: 0,
          stdout: '0\t0\n',
          stderr: '',
        });

        mockGitCli.setMockResult('diff --name-only -z --end-of-options main...develop', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.compareBranches(mockRepo, 'main', 'develop');

        // Check that all commands used the correct working directory
        for (const cmd of mockGitCli.executedCommands) {
          assert.strictEqual(
            (cmd.options as { cwd: string }).cwd,
            '/test/repo',
            `Command ${cmd.args.join(' ')} should use correct cwd`
          );
        }
      });
    });
  });
});

/**
 * Unit tests for GitService stash operations.
 *
 * Tests cover:
 * - stash() with message and StashOptions
 * - stashList() for listing stashes
 * - stashApply() for applying stash without removing
 * - stashPop() for applying and removing stash
 * - stashDrop() for removing stashes
 * - stashShow() for viewing stash contents/diff
 */
describe('GitService - Stash Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('stash()', () => {
    describe('Basic stash functionality', () => {
      it('should execute git stash push without message', async () => {
        await gitService.stash(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'push']);
      });

      it('should execute git stash push with message', async () => {
        await gitService.stash(mockRepo, 'WIP: feature implementation');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'stash',
          'push',
          '-m',
          'WIP: feature implementation',
        ]);
      });

      it('should pass the correct working directory', async () => {
        await gitService.stash(mockRepo, 'test stash');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error', async () => {
        mockGitCli.setMockResult('stash push -m test', {
          exitCode: 1,
          stdout: '',
          stderr: 'No local changes to save',
        });

        {
          const __r = await gitService.stash(mockRepo, 'test');
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /Git command failed/);
        }
      });
    });

    describe('Include untracked files option', () => {
      it('should include --include-untracked flag when includeUntracked is true', async () => {
        await gitService.stash(mockRepo, 'stash with untracked', { includeUntracked: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('--include-untracked'),
          'Should include --include-untracked flag'
        );
      });

      it('should not include --include-untracked flag when includeUntracked is false', async () => {
        await gitService.stash(mockRepo, 'stash without untracked', { includeUntracked: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          !lastCommand.args.includes('--include-untracked'),
          'Should not include --include-untracked flag'
        );
      });
    });

    describe('Keep index option', () => {
      it('should include --keep-index flag when keepIndex is true', async () => {
        await gitService.stash(mockRepo, 'stash keeping index', { keepIndex: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--keep-index'), 'Should include --keep-index flag');
      });

      it('should not include --keep-index flag when keepIndex is false', async () => {
        await gitService.stash(mockRepo, 'stash not keeping index', { keepIndex: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          !lastCommand.args.includes('--keep-index'),
          'Should not include --keep-index flag'
        );
      });
    });

    describe('Combined options', () => {
      it('should include all flags when all options are set', async () => {
        await gitService.stash(mockRepo, 'full options stash', {
          includeUntracked: true,
          keepIndex: true,
        });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('--include-untracked'),
          'Should include --include-untracked flag'
        );
        assert.ok(lastCommand.args.includes('--keep-index'), 'Should include --keep-index flag');
        assert.ok(lastCommand.args.includes('-m'), 'Should include -m flag');
        assert.ok(
          lastCommand.args.includes('full options stash'),
          'Should include the stash message'
        );
      });
    });
  });

  describe('stashList()', () => {
    describe('Listing stashes', () => {
      it('should execute git stash list', async () => {
        await gitService.stashList(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'stash',
          'list',
          '--format=%gd\x1f%ci\x1f%gs\x1f%H',
        ]);
      });

      it('should pass the correct working directory', async () => {
        await gitService.stashList(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return empty array when no stashes exist', async () => {
        mockGitCli.setMockResult('stash list --format=%gd\x1f%ci\x1f%gs\x1f%H', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const stashes = await gitService.stashList(mockRepo);
        assert.deepStrictEqual(stashes, []);
      });

      it('should parse stash list correctly', async () => {
        mockGitCli.setMockResult('stash list --format=%gd\x1f%ci\x1f%gs\x1f%H', {
          exitCode: 0,
          stdout:
            'stash@{0}\x1f2024-05-01 12:00:00 +0000\x1fWIP on main: abc1234 Some commit message\nstash@{1}\x1f2023-01-02 03:04:05 +0000\x1fOn feature: def5678 Another message\n',
          stderr: '',
        });

        const stashes = await gitService.stashList(mockRepo);

        assert.strictEqual(stashes.length, 2);
        assert.strictEqual(stashes[0].index, 0);
        assert.strictEqual(stashes[0].message, 'abc1234 Some commit message');
        assert.strictEqual(stashes[0].branch, 'main');
        assert.strictEqual(stashes[1].index, 1);
        assert.strictEqual(stashes[1].message, 'def5678 Another message');
        assert.strictEqual(stashes[1].branch, 'feature');
      });

      it('should return empty array when command fails', async () => {
        mockGitCli.setMockResult('stash list', {
          exitCode: 1,
          stdout: '',
          stderr: 'error',
        });

        const stashes = await gitService.stashList(mockRepo);
        assert.deepStrictEqual(stashes, []);
      });
    });
  });

  describe('stashApply()', () => {
    describe('Applying stash without removing', () => {
      it('should execute git stash apply with index', async () => {
        await gitService.stashApply(mockRepo, 0);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'apply', '--index', 'stash@{0}']);
      });

      it('should apply stash at specific index', async () => {
        await gitService.stashApply(mockRepo, 2);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'apply', '--index', 'stash@{2}']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.stashApply(mockRepo, 0);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error', async () => {
        mockGitCli.setMockResult('stash apply --index stash@{0}', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: Your local changes would be overwritten',
        });

        {
          const __r = await gitService.stashApply(mockRepo, 0);
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /Git command failed/);
        }
      });
    });
  });

  describe('stashPop()', () => {
    describe('Applying and removing stash', () => {
      it('should execute git stash pop with index', async () => {
        await gitService.stashPop(mockRepo, 0);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'pop', '--index', 'stash@{0}']);
      });

      it('should pop stash at specific index', async () => {
        await gitService.stashPop(mockRepo, 1);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'pop', '--index', 'stash@{1}']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.stashPop(mockRepo, 0);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error', async () => {
        mockGitCli.setMockResult('stash pop --index stash@{0}', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: Your local changes would be overwritten',
        });

        {
          const __r = await gitService.stashPop(mockRepo, 0);
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /Git command failed/);
        }
      });
    });
  });

  describe('stashDrop()', () => {
    describe('Removing stashes', () => {
      it('should execute git stash drop with index', async () => {
        await gitService.stashDrop(mockRepo, 0);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'drop', 'stash@{0}']);
      });

      it('should drop stash at specific index', async () => {
        await gitService.stashDrop(mockRepo, 3);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'drop', 'stash@{3}']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.stashDrop(mockRepo, 0);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error', async () => {
        mockGitCli.setMockResult('stash drop stash@{99}', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: stash@{99} is not a valid reference',
        });

        {
          const __r = await gitService.stashDrop(mockRepo, 99);
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /Git command failed/);
        }
      });
    });
  });

  describe('stashShow()', () => {
    describe('Viewing stash contents/diff', () => {
      it('should execute git stash show -p with index', async () => {
        mockGitCli.setMockResult('stash show -p stash@{0}', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.stashShow(mockRepo, 0);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'show', '-p', 'stash@{0}']);
      });

      it('should show stash at specific index', async () => {
        mockGitCli.setMockResult('stash show -p stash@{2}', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.stashShow(mockRepo, 2);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['stash', 'show', '-p', 'stash@{2}']);
      });

      it('should pass the correct working directory', async () => {
        mockGitCli.setMockResult('stash show -p stash@{0}', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.stashShow(mockRepo, 0);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should parse diff output correctly', async () => {
        const diffOutput = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,3 +1,4 @@
 line 1
+new line
 line 2
 line 3
`;
        mockGitCli.setMockResult('stash show -p stash@{0}', {
          exitCode: 0,
          stdout: diffOutput,
          stderr: '',
        });

        const diffs = await gitService.stashShow(mockRepo, 0);

        assert.strictEqual(diffs.length, 1);
        assert.strictEqual(diffs[0].path, 'src/file.ts');
        assert.strictEqual(diffs[0].hunks.length, 1);
        assert.ok(
          diffs[0].hunks[0].lines.some((l) => l.type === 'add' && l.content === 'new line')
        );
      });

      it('should return empty array for empty stash', async () => {
        mockGitCli.setMockResult('stash show -p stash@{0}', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const diffs = await gitService.stashShow(mockRepo, 0);
        assert.deepStrictEqual(diffs, []);
      });

      it('should throw on error', async () => {
        mockGitCli.setMockResult('stash show -p stash@{99}', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: stash@{99} is not a valid reference',
        });

        await assert.rejects(
          async () => gitService.stashShow(mockRepo, 99),
          /Git command failed/,
          'Should throw error when stash show fails'
        );
      });

      it('should handle multiple files in stash', async () => {
        const diffOutput = `diff --git a/src/file1.ts b/src/file1.ts
--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,2 +1,3 @@
 line 1
+added in file1
 line 2
diff --git a/src/file2.ts b/src/file2.ts
--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1,2 +1,3 @@
 line a
+added in file2
 line b
`;
        mockGitCli.setMockResult('stash show -p stash@{0}', {
          exitCode: 0,
          stdout: diffOutput,
          stderr: '',
        });

        const diffs = await gitService.stashShow(mockRepo, 0);

        assert.strictEqual(diffs.length, 2);
        assert.strictEqual(diffs[0].path, 'src/file1.ts');
        assert.strictEqual(diffs[1].path, 'src/file2.ts');
      });
    });
  });

  // ─── ────────────────────────────────────────────────────────────────

  describe('stashBranch()', () => {
    it('runs `git stash branch <name> stash@{<index>}` for the given index', async () => {
      await gitService.stashBranch(mockRepo, 2, 'feature/stashed-work');

      const last = mockGitCli.getLastCommand();
      assert.ok(last);
      assert.deepStrictEqual(last.args, [
        'stash',
        'branch',
        '--end-of-options',
        'feature/stashed-work',
        'stash@{2}',
      ]);
    });

    it('uses the correct working directory', async () => {
      await gitService.stashBranch(mockRepo, 0, 'wip');
      const last = mockGitCli.getLastCommand();
      assert.strictEqual((last!.options as { cwd: string }).cwd, '/test/repo');
    });

    it('errs when the branch name is empty', async () => {
      {
        const __r = await gitService.stashBranch(mockRepo, 0, '');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /Branch name cannot be empty/);
      }
      {
        const __r = await gitService.stashBranch(mockRepo, 0, '   ');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /Branch name cannot be empty/);
      }
    });

    it('errs when the index is negative or non-integer', async () => {
      {
        const __r = await gitService.stashBranch(mockRepo, -1, 'x');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /Invalid stash index/);
      }
      {
        const __r = await gitService.stashBranch(mockRepo, 1.5, 'x');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /Invalid stash index/);
      }
    });

    it('errs on branch names starting with - (CLI-flag injection guard)', async () => {
      // `stashBranch` lands `branchName` as a leading positional; a `-`-leading
      // name (e.g. `--output=…`) would be parsed by git as a flag. Mirrors the
      // createBranch / createTag leading-dash guard.
      const __r = await gitService.stashBranch(mockRepo, 0, '--track');
      assert.ok(__r.isErr());
      assert.match(__r._unsafeUnwrapErr().message, /Invalid branch name/);
    });

    it('errs on branch names starting with . (git-check-ref-format parity)', async () => {
      const __r = await gitService.stashBranch(mockRepo, 0, '.hidden');
      assert.ok(__r.isErr());
      assert.match(__r._unsafeUnwrapErr().message, /Invalid branch name/);
    });

    it('trims whitespace around the branch name', async () => {
      await gitService.stashBranch(mockRepo, 0, '  feature/x  ');
      const last = mockGitCli.getLastCommand();
      assert.deepStrictEqual(last!.args, [
        'stash',
        'branch',
        '--end-of-options',
        'feature/x',
        'stash@{0}',
      ]);
    });

    it('surfaces "branch already exists" errors from git', async () => {
      mockGitCli.setMockResult('stash branch --end-of-options existing-branch stash@{0}', {
        exitCode: 128,
        stdout: '',
        stderr: "fatal: A branch named 'existing-branch' already exists.",
      });
      const __r = await gitService.stashBranch(mockRepo, 0, 'existing-branch');
      assert.ok(__r.isErr());
      assert.match(__r._unsafeUnwrapErr().message, /already exists/);
    });

    it('surfaces conflict errors from git during apply', async () => {
      mockGitCli.setMockResult('stash branch --end-of-options wip stash@{0}', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT (content): Merge conflict in file.txt',
      });
      const __r = await gitService.stashBranch(mockRepo, 0, 'wip');
      assert.ok(__r.isErr());
      assert.match(__r._unsafeUnwrapErr().message, /conflict|CONFLICT/);
    });

    it('surfaces "bad stash" errors for invalid indexes at the git level', async () => {
      mockGitCli.setMockResult('stash branch --end-of-options wip stash@{99}', {
        exitCode: 128,
        stdout: '',
        stderr: "fatal: bad revision 'stash@{99}'",
      });
      const __r = await gitService.stashBranch(mockRepo, 99, 'wip');
      assert.ok(__r.isErr());
      assert.match(__r._unsafeUnwrapErr().message, /bad revision|stash@\{99\}/);
    });
  });

  describe('stashRename()', () => {
    /**
     * The implementation uses three git calls:
     *   rev-parse stash@{i} → <hash>
     *   stash store -m <newMessage> <hash>
     *   stash drop stash@{i+1}
     *
     * We stub the rev-parse to return a known hash so the downstream calls
     * can be verified deterministically.
     */
    const TEST_HASH = 'abc1234def5678901234567890123456789abcde';

    beforeEach(() => {
      mockGitCli.setMockResult(`rev-parse stash@{0}`, {
        exitCode: 0,
        stdout: TEST_HASH + '\n',
        stderr: '',
      });
      mockGitCli.setMockResult(`rev-parse stash@{2}`, {
        exitCode: 0,
        stdout: TEST_HASH + '\n',
        stderr: '',
      });
    });

    it('issues rev-parse, stash store, and stash drop in that order', async () => {
      await gitService.stashRename(mockRepo, 2, 'WIP: new name');

      const commands = mockGitCli.executedCommands.map((c) => c.args.join(' '));
      const revIdx = commands.indexOf('rev-parse stash@{2}');
      const storeIdx = commands.findIndex((c) => c.startsWith('stash store -m WIP: new name '));
      const dropIdx = commands.indexOf('stash drop stash@{3}');

      assert.ok(revIdx >= 0, `rev-parse should run, got commands: ${commands.join(' | ')}`);
      assert.ok(storeIdx >= 0, `stash store should run, got: ${commands.join(' | ')}`);
      assert.ok(dropIdx >= 0, `stash drop stash@{3} should run, got: ${commands.join(' | ')}`);
      assert.ok(revIdx < storeIdx && storeIdx < dropIdx, 'order must be rev-parse → store → drop');
    });

    it('stores with the provided message and resolved commit hash', async () => {
      await gitService.stashRename(mockRepo, 0, 'renamed subject');
      const storeCall = mockGitCli.executedCommands.find(
        (c) => c.args[0] === 'stash' && c.args[1] === 'store'
      );
      assert.ok(storeCall);
      assert.deepStrictEqual(storeCall.args, [
        'stash',
        'store',
        '-m',
        'renamed subject',
        TEST_HASH,
      ]);
    });

    it('drops stash@{index+1} after storing (accounting for the shift)', async () => {
      await gitService.stashRename(mockRepo, 2, 'x');
      const dropCall = mockGitCli.executedCommands.find(
        (c) => c.args[0] === 'stash' && c.args[1] === 'drop'
      );
      assert.ok(dropCall);
      assert.deepStrictEqual(dropCall.args, ['stash', 'drop', 'stash@{3}']);
    });

    it('errs on negative or non-integer index before any git call', async () => {
      {
        const __r = await gitService.stashRename(mockRepo, -1, 'x');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /Invalid stash index/);
      }
      {
        const __r = await gitService.stashRename(mockRepo, 1.5, 'x');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /Invalid stash index/);
      }
    });

    it('surfaces rev-parse failures for invalid indexes', async () => {
      mockGitCli.setMockResult('rev-parse stash@{99}', {
        exitCode: 128,
        stdout: '',
        stderr: "fatal: bad revision 'stash@{99}'",
      });
      const __r = await gitService.stashRename(mockRepo, 99, 'x');
      assert.ok(__r.isErr());
      assert.match(__r._unsafeUnwrapErr().message, /bad revision/);
    });

    it('rolls back the duplicate entry if drop fails', async () => {
      // Make the drop fail; the impl should then attempt to drop stash@{0}
      // to undo the store.
      mockGitCli.setMockResult('stash drop stash@{1}', {
        exitCode: 1,
        stdout: '',
        stderr: 'could not drop',
      });

      const __r = await gitService.stashRename(mockRepo, 0, 'x');
      assert.ok(__r.isErr());
      assert.match(__r._unsafeUnwrapErr().message, /could not drop/);

      // Verify rollback drop ran.
      const commands = mockGitCli.executedCommands.map((c) => c.args.join(' '));
      const rollback = commands.lastIndexOf('stash drop stash@{0}');
      assert.ok(
        rollback >= 0,
        `rollback drop stash@{0} must have been attempted, got: ${commands.join(' | ')}`
      );
    });
  });
});

/**
 * Unit tests for GitService remote management operations.
 *
 * Tests cover:
 * - getRemotes() for listing remotes with URLs
 * - addRemote() for adding new remotes
 * - removeRemote() for removing remotes
 */
describe('GitService - Remote Management Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('getRemotes()', () => {
    describe('Listing remotes with URLs', () => {
      it('should execute git remote -v command', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getRemotes(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['remote', '-v']);
      });

      it('should pass the correct working directory', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getRemotes(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return empty array when no remotes exist', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const remotes = (await gitService.getRemotes(mockRepo))._unsafeUnwrap();
        assert.deepStrictEqual(remotes, []);
      });

      it('should return Err when command fails (not a silent empty list)', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 1,
          stdout: '',
          stderr: 'error',
        });

        const result = await gitService.getRemotes(mockRepo);
        assert.ok(result.isErr());
      });

      it('should parse single remote with fetch and push URLs', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 0,
          stdout:
            'origin\thttps://github.com/user/repo.git (fetch)\norigin\thttps://github.com/user/repo.git (push)\n',
          stderr: '',
        });

        const remotes = (await gitService.getRemotes(mockRepo))._unsafeUnwrap();

        assert.strictEqual(remotes.length, 1);
        assert.strictEqual(remotes[0].name, 'origin');
        assert.strictEqual(remotes[0].fetchUrl, 'https://github.com/user/repo.git');
        assert.strictEqual(remotes[0].pushUrl, 'https://github.com/user/repo.git');
      });

      it('should parse multiple remotes', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 0,
          stdout:
            'origin\thttps://github.com/user/repo.git (fetch)\n' +
            'origin\thttps://github.com/user/repo.git (push)\n' +
            'upstream\thttps://github.com/other/repo.git (fetch)\n' +
            'upstream\thttps://github.com/other/repo.git (push)\n',
          stderr: '',
        });

        const remotes = (await gitService.getRemotes(mockRepo))._unsafeUnwrap();

        assert.strictEqual(remotes.length, 2);
        assert.strictEqual(remotes[0].name, 'origin');
        assert.strictEqual(remotes[0].fetchUrl, 'https://github.com/user/repo.git');
        assert.strictEqual(remotes[1].name, 'upstream');
        assert.strictEqual(remotes[1].fetchUrl, 'https://github.com/other/repo.git');
      });

      it('should handle remotes with different fetch and push URLs', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 0,
          stdout:
            'origin\thttps://github.com/user/repo.git (fetch)\n' +
            'origin\tgit@github.com:user/repo.git (push)\n',
          stderr: '',
        });

        const remotes = (await gitService.getRemotes(mockRepo))._unsafeUnwrap();

        assert.strictEqual(remotes.length, 1);
        assert.strictEqual(remotes[0].name, 'origin');
        assert.strictEqual(remotes[0].fetchUrl, 'https://github.com/user/repo.git');
        assert.strictEqual(remotes[0].pushUrl, 'git@github.com:user/repo.git');
      });

      it('should handle SSH URLs', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 0,
          stdout:
            'origin\tgit@github.com:user/repo.git (fetch)\norigin\tgit@github.com:user/repo.git (push)\n',
          stderr: '',
        });

        const remotes = (await gitService.getRemotes(mockRepo))._unsafeUnwrap();

        assert.strictEqual(remotes.length, 1);
        assert.strictEqual(remotes[0].name, 'origin');
        assert.strictEqual(remotes[0].fetchUrl, 'git@github.com:user/repo.git');
        assert.strictEqual(remotes[0].pushUrl, 'git@github.com:user/repo.git');
      });

      it('should handle file:// URLs', async () => {
        mockGitCli.setMockResult('remote -v', {
          exitCode: 0,
          stdout:
            'local\tfile:///path/to/repo.git (fetch)\nlocal\tfile:///path/to/repo.git (push)\n',
          stderr: '',
        });

        const remotes = (await gitService.getRemotes(mockRepo))._unsafeUnwrap();

        assert.strictEqual(remotes.length, 1);
        assert.strictEqual(remotes[0].name, 'local');
        assert.strictEqual(remotes[0].fetchUrl, 'file:///path/to/repo.git');
        assert.strictEqual(remotes[0].pushUrl, 'file:///path/to/repo.git');
      });
    });
  });

  describe('addRemote()', () => {
    describe('Adding new remote', () => {
      it('should execute git remote add with name and URL', async () => {
        await gitService.addRemote(mockRepo, 'upstream', 'https://github.com/other/repo.git');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'remote',
          'add',
          'upstream',
          'https://github.com/other/repo.git',
        ]);
      });

      it('should pass the correct working directory', async () => {
        await gitService.addRemote(mockRepo, 'upstream', 'https://github.com/other/repo.git');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error when remote already exists', async () => {
        mockGitCli.setMockResult('remote add origin https://github.com/user/repo.git', {
          exitCode: 3,
          stdout: '',
          stderr: 'error: remote origin already exists.',
        });

        {
          const __r = await gitService.addRemote(
            mockRepo,
            'origin',
            'https://github.com/user/repo.git'
          );
          assert.ok(__r.isErr());
        }
      });

      it('should add remote with SSH URL', async () => {
        await gitService.addRemote(mockRepo, 'origin', 'git@github.com:user/repo.git');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'remote',
          'add',
          'origin',
          'git@github.com:user/repo.git',
        ]);
      });

      it('should add remote with file:// URL', async () => {
        await gitService.addRemote(mockRepo, 'local', 'file:///path/to/repo.git');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'remote',
          'add',
          'local',
          'file:///path/to/repo.git',
        ]);
      });

      it('should handle remote names with hyphens', async () => {
        await gitService.addRemote(mockRepo, 'my-remote', 'https://github.com/user/repo.git');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'remote',
          'add',
          'my-remote',
          'https://github.com/user/repo.git',
        ]);
      });

      it('should handle remote names with underscores', async () => {
        await gitService.addRemote(mockRepo, 'my_remote', 'https://github.com/user/repo.git');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'remote',
          'add',
          'my_remote',
          'https://github.com/user/repo.git',
        ]);
      });

      it('rejects a remote name that looks like a flag (argv-injection guard)', async () => {
        {
          const __r = await gitService.addRemote(mockRepo, '--upload-pack=evil', 'https://x/y.git');
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /invalid remote name/i);
        }
      });

      it('rejects a URL that looks like a flag', async () => {
        {
          const __r = await gitService.addRemote(mockRepo, 'origin', '--foo');
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /invalid remote url/i);
        }
      });
    });
  });

  describe('removeRemote()', () => {
    describe('Removing remote', () => {
      it('should execute git remote remove with name', async () => {
        await gitService.removeRemote(mockRepo, 'upstream');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['remote', 'remove', 'upstream']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.removeRemote(mockRepo, 'upstream');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error when remote does not exist', async () => {
        mockGitCli.setMockResult('remote remove nonexistent', {
          exitCode: 2,
          stdout: '',
          stderr: "error: No such remote: 'nonexistent'",
        });

        {
          const __r = await gitService.removeRemote(mockRepo, 'nonexistent');
          assert.ok(__r.isErr());
        }
      });

      it('should remove remote with hyphenated name', async () => {
        await gitService.removeRemote(mockRepo, 'my-remote');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['remote', 'remove', 'my-remote']);
      });

      it('should remove remote with underscored name', async () => {
        await gitService.removeRemote(mockRepo, 'my_remote');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['remote', 'remove', 'my_remote']);
      });

      it('rejects a remote name that looks like a flag (argv-injection guard)', async () => {
        {
          const __r = await gitService.removeRemote(mockRepo, '--upload-pack=evil');
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /invalid remote name/i);
        }
      });
    });
  });

  describe('Remote management integration', () => {
    it('should be able to add and then list a remote', async () => {
      // First add a remote
      await gitService.addRemote(mockRepo, 'upstream', 'https://github.com/other/repo.git');

      // Verify add command was executed
      const addCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'remote' && cmd.args[1] === 'add'
      );
      assert.ok(addCommand, 'Add command should have been executed');

      // Now mock the getRemotes response to include the new remote
      mockGitCli.setMockResult('remote -v', {
        exitCode: 0,
        stdout:
          'origin\thttps://github.com/user/repo.git (fetch)\n' +
          'origin\thttps://github.com/user/repo.git (push)\n' +
          'upstream\thttps://github.com/other/repo.git (fetch)\n' +
          'upstream\thttps://github.com/other/repo.git (push)\n',
        stderr: '',
      });

      // List remotes
      const remotes = (await gitService.getRemotes(mockRepo))._unsafeUnwrap();

      assert.strictEqual(remotes.length, 2);
      assert.ok(
        remotes.some((r) => r.name === 'upstream'),
        'Should include the added remote'
      );
    });

    it('should be able to remove and then verify remote is gone', async () => {
      // First remove a remote
      await gitService.removeRemote(mockRepo, 'upstream');

      // Verify remove command was executed
      const removeCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'remote' && cmd.args[1] === 'remove'
      );
      assert.ok(removeCommand, 'Remove command should have been executed');

      // Now mock the getRemotes response without the removed remote
      mockGitCli.setMockResult('remote -v', {
        exitCode: 0,
        stdout:
          'origin\thttps://github.com/user/repo.git (fetch)\n' +
          'origin\thttps://github.com/user/repo.git (push)\n',
        stderr: '',
      });

      // List remotes
      const remotes = (await gitService.getRemotes(mockRepo))._unsafeUnwrap();

      assert.strictEqual(remotes.length, 1);
      assert.ok(
        !remotes.some((r) => r.name === 'upstream'),
        'Should not include the removed remote'
      );
    });
  });

  describe('setRemoteUrl() (#P2 Configure Remotes)', () => {
    it('executes git remote set-url with the new URL', async () => {
      await gitService.setRemoteUrl(mockRepo, 'origin', 'https://github.com/user/moved.git');
      const cmd = mockGitCli.getLastCommand();
      assert.deepStrictEqual(cmd!.args, [
        'remote',
        'set-url',
        'origin',
        'https://github.com/user/moved.git',
      ]);
      assert.strictEqual((cmd!.options as { cwd: string }).cwd, '/test/repo');
    });

    it('rejects a remote name that looks like a flag (argv-injection guard)', async () => {
      {
        const __r = await gitService.setRemoteUrl(
          mockRepo,
          '--upload-pack=evil',
          'https://x/y.git'
        );
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /invalid remote name/i);
      }
    });

    it('rejects a URL that looks like a flag', async () => {
      {
        const __r = await gitService.setRemoteUrl(mockRepo, 'origin', '--foo');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /invalid remote url/i);
      }
    });
  });

  describe('renameRemote() (#P2 Configure Remotes)', () => {
    it('executes git remote rename old new', async () => {
      await gitService.renameRemote(mockRepo, 'origin', 'upstream');
      const cmd = mockGitCli.getLastCommand();
      assert.deepStrictEqual(cmd!.args, ['remote', 'rename', 'origin', 'upstream']);
    });

    it('rejects a flag-like new name', async () => {
      {
        const __r = await gitService.renameRemote(mockRepo, 'origin', '-x');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /invalid remote name/i);
      }
    });
  });
});

/**
 * Unit tests for GitService fetch, pull, push operations.
 *
 * Tests cover:
 * - fetch() for all remotes or specific remote
 * - pull() with rebase option
 * - push() with PushOptions (force, upstream)
 */
describe('GitService - Fetch, Pull, Push Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
        upstream: {
          remote: 'origin',
          name: 'main',
        },
      },
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://github.com/user/repo.git',
          pushUrl: 'https://github.com/user/repo.git',
        },
      ],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('fetch()', () => {
    describe('Fetch from all remotes', () => {
      it('should execute git fetch --porcelain --all when no remote is specified', async () => {
        await gitService.fetch(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['fetch', '--porcelain', '--all']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.fetch(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error when fetch fails', async () => {
        mockGitCli.setMockResult('fetch --porcelain --all', {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: unable to access remote',
        });

        {
          const __r = await gitService.fetch(mockRepo);
          assert.ok(__r.isErr());
        }
      });
    });

    describe('Fetch from specific remote', () => {
      it('should execute git fetch with specific remote name', async () => {
        await gitService.fetch(mockRepo, 'origin');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Remote name is user-controlled, so it sits behind --end-of-options.
        assert.deepStrictEqual(lastCommand.args, [
          'fetch',
          '--porcelain',
          '--end-of-options',
          'origin',
        ]);
      });

      it('should fetch from upstream remote', async () => {
        await gitService.fetch(mockRepo, 'upstream');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'fetch',
          '--porcelain',
          '--end-of-options',
          'upstream',
        ]);
      });

      it('should throw on error when fetching from non-existent remote', async () => {
        mockGitCli.setMockResult('fetch --porcelain --end-of-options nonexistent', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: 'nonexistent' does not appear to be a git repository",
        });

        {
          const __r = await gitService.fetch(mockRepo, 'nonexistent');
          assert.ok(__r.isErr());
        }
      });
    });
  });

  describe('pull()', () => {
    describe('Basic pull', () => {
      it('should execute git pull without options', async () => {
        await gitService.pull(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['pull']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.pull(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error when pull fails', async () => {
        mockGitCli.setMockResult('pull', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: Your local changes would be overwritten by merge',
        });

        {
          const __r = await gitService.pull(mockRepo);
          assert.ok(__r.isErr());
        }
      });

      it('an exit-0 autostash pop conflict surfaces a typed Err that isConflictError routes', async () => {
        // With `--autostash` git integrates cleanly (exit 0) then pops the
        // stash. A pop collision leaves unmerged files while git STILL exits 0,
        // so `_pull` synthesises a CONFLICT failure. It must classify as a
        // conflict — carrying the marker on the message AND `.result.combined`
        // so `isConflictError` (which duck-types `.result.combined`, falling
        // back to `.message`) routes it to the Resolve flow rather than a
        // generic "Failed to pull" toast.
        mockGitCli.setMockResult('pull --autostash', { exitCode: 0, stdout: '', stderr: '' });
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU conflicted.ts\n',
          stderr: '',
        });

        const result = await gitService.pull(mockRepo, { autostash: true });

        assert.ok(result.isErr(), 'an autostash pop conflict must surface an Err');
        const error = result._unsafeUnwrapErr();
        assert.match(error.message, /CONFLICT:/, 'the message MUST keep the CONFLICT: marker');
        assert.strictEqual(
          isConflictError(error),
          true,
          'the synthesised autostash conflict must route through isConflictError'
        );
      });
    });

    describe('Pull with rebase option', () => {
      it('should include --rebase flag when rebase option is true', async () => {
        await gitService.pull(mockRepo, { rebase: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--rebase'), 'Should include --rebase flag');
      });

      it('should not include --rebase flag when rebase option is false', async () => {
        await gitService.pull(mockRepo, { rebase: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--rebase'), 'Should not include --rebase flag');
      });

      it('should not include --rebase flag when rebase option is undefined', async () => {
        await gitService.pull(mockRepo, {});

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--rebase'), 'Should not include --rebase flag');
      });
    });

    describe('Pull with remote and branch options', () => {
      it('should include remote when specified', async () => {
        await gitService.pull(mockRepo, { remote: 'upstream' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('upstream'), 'Should include remote name');
      });

      it('should include branch when specified', async () => {
        await gitService.pull(mockRepo, { branch: 'develop' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('develop'), 'Should include branch name');
      });

      it('should include both remote and branch when specified', async () => {
        await gitService.pull(mockRepo, { remote: 'upstream', branch: 'develop' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'pull',
          '--end-of-options',
          'upstream',
          'develop',
        ]);
      });

      it('should include rebase, remote, and branch when all specified', async () => {
        await gitService.pull(mockRepo, { rebase: true, remote: 'upstream', branch: 'develop' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'pull',
          '--rebase',
          '--end-of-options',
          'upstream',
          'develop',
        ]);
      });
    });

    describe('Pull with autostash option', () => {
      it('splices --autostash before --end-of-options so a dirty tree no longer dead-ends pull', async () => {
        await gitService.pull(mockRepo, { autostash: true, remote: 'origin', branch: 'main' });

        const pullCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'pull');
        assert.ok(pullCommand, 'Pull command should have been executed');
        assert.deepStrictEqual(pullCommand.args, [
          'pull',
          '--autostash',
          '--end-of-options',
          'origin',
          'main',
        ]);
      });

      it('does not include --autostash when the option is omitted', async () => {
        await gitService.pull(mockRepo, { remote: 'origin', branch: 'main' });

        const pullCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'pull');
        assert.ok(pullCommand, 'Pull command should have been executed');
        assert.ok(!pullCommand.args.includes('--autostash'), 'Should not include --autostash flag');
      });

      it('combines --autostash with a strategy flag in flag order', async () => {
        await gitService.pull(mockRepo, { autostash: true, rebase: true });

        const pullCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'pull');
        assert.ok(pullCommand, 'Pull command should have been executed');
        assert.deepStrictEqual(pullCommand.args, ['pull', '--rebase', '--autostash']);
      });

      it('throws a CONFLICT error when an exit-0 autostash pop leaves unmerged files', async () => {
        // With --autostash git integrates cleanly (exit 0) then pops the stash;
        // if that pop collides git leaves unmerged files but STILL exits 0, so
        // the post-status check must surface it as a conflict.
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU shared.ts\n',
          stderr: '',
        });

        {
          const __r = await gitService.pull(mockRepo, { autostash: true });
          assert.ok(__r.isErr());
        }
      });

      it('does not read porcelain status after a non-autostash pull', async () => {
        await gitService.pull(mockRepo, { remote: 'origin', branch: 'main' });

        const statusCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'status');
        assert.strictEqual(statusCommand, undefined, 'Should not run status without autostash');
      });

      it('resolves cleanly when an autostash pull exits 0 with no unmerged files', async () => {
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await assert.doesNotReject(async () => gitService.pull(mockRepo, { autostash: true }));
      });
    });
  });

  describe('push()', () => {
    describe('Basic push', () => {
      it('should execute git push without options', async () => {
        await gitService.push(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['push']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.push(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw on error when push fails', async () => {
        mockGitCli.setMockResult('push', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: failed to push some refs',
        });

        {
          const __r = await gitService.push(mockRepo);
          assert.ok(__r.isErr());
        }
      });
    });

    describe('Push with force option', () => {
      it('should include --force flag when force option is true', async () => {
        await gitService.push(mockRepo, { force: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--force'), 'Should include --force flag');
      });

      it('should not include --force flag when force option is false', async () => {
        await gitService.push(mockRepo, { force: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--force'), 'Should not include --force flag');
      });

      it('should not include --force flag when force option is undefined', async () => {
        await gitService.push(mockRepo, {});

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--force'), 'Should not include --force flag');
      });
    });

    describe('Push with forceWithLease option', () => {
      it('should include --force-with-lease flag when forceWithLease option is true', async () => {
        await gitService.push(mockRepo, { forceWithLease: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('--force-with-lease'),
          'Should include --force-with-lease flag'
        );
      });

      it('should prefer --force over --force-with-lease when both are true', async () => {
        await gitService.push(mockRepo, { force: true, forceWithLease: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--force'), 'Should include --force flag');
        assert.ok(
          !lastCommand.args.includes('--force-with-lease'),
          'Should not include --force-with-lease flag when --force is used'
        );
      });
    });

    describe('Push with set-upstream option', () => {
      it('should include --set-upstream flag when setUpstream option is true', async () => {
        await gitService.push(mockRepo, { setUpstream: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('--set-upstream'),
          'Should include --set-upstream flag'
        );
      });

      it('should not include --set-upstream flag when setUpstream option is false', async () => {
        await gitService.push(mockRepo, { setUpstream: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          !lastCommand.args.includes('--set-upstream'),
          'Should not include --set-upstream flag'
        );
      });

      it('should include --set-upstream with remote and branch', async () => {
        await gitService.push(mockRepo, { setUpstream: true, remote: 'origin', branch: 'feature' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('--set-upstream'),
          'Should include --set-upstream flag'
        );
        assert.ok(lastCommand.args.includes('origin'), 'Should include remote name');
        assert.ok(lastCommand.args.includes('feature'), 'Should include branch name');
      });
    });

    describe('Push with tags option', () => {
      it('should include --tags flag when tags option is true', async () => {
        await gitService.push(mockRepo, { tags: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--tags'), 'Should include --tags flag');
      });

      it('should not include --tags flag when tags option is false', async () => {
        await gitService.push(mockRepo, { tags: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--tags'), 'Should not include --tags flag');
      });
    });

    describe('Push with remote and branch options', () => {
      it('should include remote when specified', async () => {
        await gitService.push(mockRepo, { remote: 'upstream' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('upstream'), 'Should include remote name');
      });

      it('should include branch when specified', async () => {
        await gitService.push(mockRepo, { branch: 'feature' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('feature'), 'Should include branch name');
      });

      it('should include both remote and branch when specified', async () => {
        await gitService.push(mockRepo, { remote: 'upstream', branch: 'feature' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'push',
          '--end-of-options',
          'upstream',
          'feature',
        ]);
      });
    });

    describe('Push with combined options', () => {
      it('should include all flags when multiple options are set', async () => {
        await gitService.push(mockRepo, {
          force: true,
          setUpstream: true,
          tags: true,
          remote: 'origin',
          branch: 'main',
        });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--force'), 'Should include --force flag');
        assert.ok(
          lastCommand.args.includes('--set-upstream'),
          'Should include --set-upstream flag'
        );
        assert.ok(lastCommand.args.includes('--tags'), 'Should include --tags flag');
        assert.ok(lastCommand.args.includes('origin'), 'Should include remote name');
        assert.ok(lastCommand.args.includes('main'), 'Should include branch name');
      });

      it('should maintain correct argument order', async () => {
        await gitService.push(mockRepo, {
          force: true,
          setUpstream: true,
          remote: 'origin',
          branch: 'main',
        });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');

        // Verify the order: push, flags, remote, branch
        const pushIndex = lastCommand.args.indexOf('push');
        const forceIndex = lastCommand.args.indexOf('--force');
        const setUpstreamIndex = lastCommand.args.indexOf('--set-upstream');
        const originIndex = lastCommand.args.indexOf('origin');
        const mainIndex = lastCommand.args.indexOf('main');

        assert.strictEqual(pushIndex, 0, 'push should be first');
        assert.ok(forceIndex > pushIndex, '--force should come after push');
        assert.ok(setUpstreamIndex > pushIndex, '--set-upstream should come after push');
        assert.ok(originIndex > setUpstreamIndex, 'remote should come after flags');
        assert.ok(mainIndex > originIndex, 'branch should come after remote');
      });
    });
  });

  describe('Integration scenarios', () => {
    it('should be able to fetch then pull', async () => {
      // First fetch
      await gitService.fetch(mockRepo);

      // Verify fetch command was executed
      const fetchCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'fetch');
      assert.ok(fetchCommand, 'Fetch command should have been executed');

      // Then pull
      await gitService.pull(mockRepo);

      // Verify pull command was executed
      const pullCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'pull');
      assert.ok(pullCommand, 'Pull command should have been executed');
    });

    it('should be able to push after committing', async () => {
      // First commit
      await gitService.commit(mockRepo, 'Test commit', {});

      // Verify commit command was executed
      const commitCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'commit');
      assert.ok(commitCommand, 'Commit command should have been executed');

      // Then push
      await gitService.push(mockRepo);

      // Verify push command was executed
      const pushCommand = mockGitCli.executedCommands.find((cmd) => cmd.args[0] === 'push');
      assert.ok(pushCommand, 'Push command should have been executed');
    });

    it('should be able to push with set-upstream for new branch', async () => {
      // Create a new branch
      await gitService.createBranch(mockRepo, 'new-feature');

      // Checkout the new branch
      await gitService.checkout(mockRepo, 'new-feature');

      // Push with set-upstream
      await gitService.push(mockRepo, {
        setUpstream: true,
        remote: 'origin',
        branch: 'new-feature',
      });

      // Verify push command was executed with correct options
      const pushCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'push' && cmd.args.includes('--set-upstream')
      );
      assert.ok(pushCommand, 'Push command with --set-upstream should have been executed');
      assert.ok(pushCommand.args.includes('origin'), 'Should include origin');
      assert.ok(pushCommand.args.includes('new-feature'), 'Should include new-feature');
    });

    it('should be able to pull with rebase from specific remote', async () => {
      await gitService.pull(mockRepo, { rebase: true, remote: 'upstream', branch: 'main' });

      const lastCommand = mockGitCli.getLastCommand();
      assert.ok(lastCommand, 'Command should have been executed');
      assert.deepStrictEqual(lastCommand.args, [
        'pull',
        '--rebase',
        '--end-of-options',
        'upstream',
        'main',
      ]);
    });
  });
});

/**
 * Unit tests for GitService tag operations.
 *
 * Tests cover:
 * - getTags() for listing all tags
 * - createTag() with annotated/lightweight logic
 * - deleteTag() for deleting local tags
 * - pushTag() for pushing tags to remote
 * - checkout() for checking out tags in detached HEAD state
 */
describe('GitService - Tag Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [{ name: 'origin', fetchUrl: 'https://github.com/test/repo.git' }],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('getTags()', () => {
    describe('Listing all tags', () => {
      it('should execute git tag -l with format option', async () => {
        mockGitCli.setMockResultByPrefix('tag -l --format', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getTags(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual(lastCommand.args[0], 'tag');
        assert.strictEqual(lastCommand.args[1], '-l');
        assert.strictEqual(lastCommand.args[2], '--format');
      });

      it('should pass the correct working directory', async () => {
        await gitService.getTags(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return empty array when command fails', async () => {
        mockGitCli.setMockResultByPrefix('tag -l --format', {
          exitCode: 1,
          stdout: '',
          stderr: 'error',
        });

        const tags = await gitService.getTags(mockRepo);
        assert.deepStrictEqual(tags, []);
      });

      it('should return empty array when no tags exist', async () => {
        mockGitCli.setMockResultByPrefix('tag -l --format', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const tags = await gitService.getTags(mockRepo);
        assert.deepStrictEqual(tags, []);
      });
    });

    describe('Tag details', () => {
      it('should parse lightweight tags correctly', async () => {
        // Default separator is `\x1f` (matches getTagFormat).
        const sep = '\x1f';
        mockGitCli.setMockResultByPrefix('tag -l --format', {
          exitCode: 0,
          stdout: `refs/tags/v1.0.0${sep}abc123def456${sep}commit${sep}${sep}${sep}${sep}\n`,
          stderr: '',
        });

        const tags = await gitService.getTags(mockRepo);

        assert.strictEqual(tags.length, 1);
        assert.strictEqual(tags[0].name, 'v1.0.0');
        assert.strictEqual(tags[0].commit, 'abc123def456');
        assert.strictEqual(tags[0].isAnnotated, false);
        assert.strictEqual(tags[0].tagger, undefined);
        assert.strictEqual(tags[0].message, undefined);
      });

      it('should parse annotated tags with tagger and message', async () => {
        // Default separator is `\x1f`.
        const sep = '\x1f';
        mockGitCli.setMockResultByPrefix('tag -l --format', {
          exitCode: 0,
          stdout: `refs/tags/v2.0.0${sep}def789abc012${sep}tag${sep}John Doe${sep}john@example.com${sep}2024-01-15T10:30:00+00:00${sep}Release version 2.0.0\n`,
          stderr: '',
        });

        const tags = await gitService.getTags(mockRepo);

        assert.strictEqual(tags.length, 1);
        assert.strictEqual(tags[0].name, 'v2.0.0');
        assert.strictEqual(tags[0].commit, 'def789abc012');
        assert.strictEqual(tags[0].isAnnotated, true);
        assert.ok(tags[0].tagger, 'Should have tagger');
        assert.strictEqual(tags[0].tagger?.name, 'John Doe');
        assert.strictEqual(tags[0].tagger?.email, 'john@example.com');
        assert.strictEqual(tags[0].message, 'Release version 2.0.0');
        assert.ok(tags[0].date, 'Should have date');
      });

      it('should parse multiple tags correctly', async () => {
        // Default separator is `\x1f`.
        const sep = '\x1f';
        mockGitCli.setMockResultByPrefix('tag -l --format', {
          exitCode: 0,
          stdout: `refs/tags/v1.0.0${sep}abc123${sep}commit${sep}${sep}${sep}${sep}\nrefs/tags/v2.0.0${sep}def456${sep}tag${sep}Jane Doe${sep}jane@example.com${sep}2024-02-20T14:00:00+00:00${sep}Major release\n`,
          stderr: '',
        });

        const tags = await gitService.getTags(mockRepo);

        assert.strictEqual(tags.length, 2);
        assert.strictEqual(tags[0].name, 'v1.0.0');
        assert.strictEqual(tags[0].isAnnotated, false);
        assert.strictEqual(tags[1].name, 'v2.0.0');
        assert.strictEqual(tags[1].isAnnotated, true);
      });
    });
  });

  describe('createTag()', () => {
    describe('Creating lightweight tag', () => {
      it('should execute git tag with just the name for lightweight tag', async () => {
        await gitService.createTag(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Tag name follows `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, ['tag', '--end-of-options', 'v1.0.0']);
      });

      it('should create lightweight tag at specific ref', async () => {
        await gitService.createTag(mockRepo, 'v1.0.0', undefined, 'abc123');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Tag name + ref follow `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, ['tag', '--end-of-options', 'v1.0.0', 'abc123']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.createTag(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });
    });

    describe('Creating annotated tag with message', () => {
      it('should execute git tag -a with message for annotated tag', async () => {
        await gitService.createTag(mockRepo, 'v2.0.0', 'Release version 2.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Annotated tag layout: `tag -a -m <msg> --end-of-options <name>`.
        // The `-m` flag must precede `--end-of-options` (verified: git refuses
        // to parse `-m <msg>` as a flag once the separator is set).
        assert.deepStrictEqual(lastCommand.args, [
          'tag',
          '-a',
          '-m',
          'Release version 2.0.0',
          '--end-of-options',
          'v2.0.0',
        ]);
      });

      it('should create annotated tag at specific ref', async () => {
        await gitService.createTag(mockRepo, 'v2.0.0', 'Release version 2.0.0', 'def456');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Annotated tag layout: `tag -a -m <msg> --end-of-options <name> [<ref>]`.
        assert.deepStrictEqual(lastCommand.args, [
          'tag',
          '-a',
          '-m',
          'Release version 2.0.0',
          '--end-of-options',
          'v2.0.0',
          'def456',
        ]);
      });

      it('should handle multi-line messages', async () => {
        const message = 'Release version 2.0.0\n\nThis is a major release with new features.';
        await gitService.createTag(mockRepo, 'v2.0.0', message);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('-a'), 'Should include -a flag');
        assert.ok(lastCommand.args.includes('-m'), 'Should include -m flag');
        assert.ok(lastCommand.args.includes(message), 'Should include the full message');
      });
    });

    describe('Force overwrite (#P2 — IntelliJ GitTagDialog -f)', () => {
      it('adds -f for a lightweight tag, before the ref guard', async () => {
        await gitService.createTag(mockRepo, 'v1.0.0', undefined, undefined, true);
        assert.deepStrictEqual(mockGitCli.getLastCommand()!.args, [
          'tag',
          '-f',
          '--end-of-options',
          'v1.0.0',
        ]);
      });

      it('adds -f alongside -a/-m for an annotated tag', async () => {
        await gitService.createTag(mockRepo, 'v2.0.0', 'msg', 'abc123', true);
        assert.deepStrictEqual(mockGitCli.getLastCommand()!.args, [
          'tag',
          '-f',
          '-a',
          '-m',
          'msg',
          '--end-of-options',
          'v2.0.0',
          'abc123',
        ]);
      });

      it('omits -f when force is falsy (legacy behavior unchanged)', async () => {
        await gitService.createTag(mockRepo, 'v1.0.0', undefined, undefined, false);
        assert.ok(!mockGitCli.getLastCommand()!.args.includes('-f'));
      });
    });

    describe('Error handling', () => {
      it('should throw error when tag already exists', async () => {
        // Argv shape now `tag --end-of-options v1.0.0`.
        mockGitCli.setMockResult('tag --end-of-options v1.0.0', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: tag 'v1.0.0' already exists",
        });

        {
          const __r = await gitService.createTag(mockRepo, 'v1.0.0');
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /Git command failed/);
        }
      });

      it('should throw error for invalid tag name', async () => {
        // Argv shape now `tag --end-of-options invalid..name`.
        mockGitCli.setMockResult('tag --end-of-options invalid..name', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: 'invalid..name' is not a valid tag name",
        });

        {
          const __r = await gitService.createTag(mockRepo, 'invalid..name');
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /Git command failed/);
        }
      });
    });
  });

  describe('deleteTag()', () => {
    describe('Deleting local tag', () => {
      it('should execute git tag -d with tag name', async () => {
        await gitService.deleteTag(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Name follows `--end-of-options`.
        assert.deepStrictEqual(lastCommand.args, ['tag', '-d', '--end-of-options', 'v1.0.0']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.deleteTag(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw error when tag does not exist', async () => {
        // Argv shape now `tag -d --end-of-options nonexistent`.
        mockGitCli.setMockResult('tag -d --end-of-options nonexistent', {
          exitCode: 1,
          stdout: '',
          stderr: "error: tag 'nonexistent' not found.",
        });

        {
          const __r = await gitService.deleteTag(mockRepo, 'nonexistent');
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /Git command failed/);
        }
      });
    });
  });

  describe('pushTag()', () => {
    describe('Pushing tag to remote', () => {
      it('should execute git push with tag ref to default remote', async () => {
        await gitService.pushTag(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'push',
          '--end-of-options',
          'origin',
          'refs/tags/v1.0.0',
        ]);
      });

      it('should execute git push with tag ref to specified remote', async () => {
        await gitService.pushTag(mockRepo, 'v1.0.0', 'upstream');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'push',
          '--end-of-options',
          'upstream',
          'refs/tags/v1.0.0',
        ]);
      });

      it('should pass the correct working directory', async () => {
        await gitService.pushTag(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw error when push fails', async () => {
        mockGitCli.setMockResult('push --end-of-options origin refs/tags/v1.0.0', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: failed to push some refs',
        });

        {
          const __r = await gitService.pushTag(mockRepo, 'v1.0.0');
          assert.ok(__r.isErr());
          assert.match(__r._unsafeUnwrapErr().message, /Git command failed/);
        }
      });
    });
  });

  describe('deleteRemoteTag() (#P3 delete tag from remote)', () => {
    it('pushes a colon-prefixed tag ref to delete it on the default remote', async () => {
      await gitService.deleteRemoteTag(mockRepo, 'v1.0.0');
      assert.deepStrictEqual(mockGitCli.getLastCommand()!.args, [
        'push',
        '--end-of-options',
        'origin',
        ':refs/tags/v1.0.0',
      ]);
    });

    it('targets the specified remote', async () => {
      await gitService.deleteRemoteTag(mockRepo, 'v1.0.0', 'upstream');
      assert.deepStrictEqual(mockGitCli.getLastCommand()!.args, [
        'push',
        '--end-of-options',
        'upstream',
        ':refs/tags/v1.0.0',
      ]);
    });

    it('rejects a flag-like tag name (argv-injection guard)', async () => {
      {
        const __r = await gitService.deleteRemoteTag(mockRepo, '-x');
        assert.ok(__r.isErr());
        assert.match(__r._unsafeUnwrapErr().message, /invalid tag name/i);
      }
    });
  });

  describe('checkout() with tags', () => {
    describe('Checkout tag in detached HEAD state', () => {
      it('should execute git checkout with tag name', async () => {
        await gitService.checkout(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['checkout', '--end-of-options', 'v1.0.0']);
      });

      it('should checkout tag resulting in detached HEAD', async () => {
        // When checking out a tag, Git puts the repository in detached HEAD state
        // The checkout command is the same, but the result is detached HEAD
        await gitService.checkout(mockRepo, 'v2.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // `checkout` now splices `--end-of-options` between flags and refs.
        assert.deepStrictEqual(lastCommand.args, ['checkout', '--end-of-options', 'v2.0.0']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.checkout(mockRepo, 'v1.0.0');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });
    });
  });

  describe('Tag workflow integration', () => {
    it('should be able to create and then delete a tag', async () => {
      // Create a tag
      await gitService.createTag(mockRepo, 'v1.0.0', 'Initial release');

      // Verify create command was executed
      const createCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'tag' && cmd.args.includes('-a')
      );
      assert.ok(createCommand, 'Create tag command should have been executed');

      // Delete the tag
      await gitService.deleteTag(mockRepo, 'v1.0.0');

      // Verify delete command was executed
      const deleteCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'tag' && cmd.args.includes('-d')
      );
      assert.ok(deleteCommand, 'Delete tag command should have been executed');
    });

    it('should be able to create and then push a tag', async () => {
      // Create a tag
      await gitService.createTag(mockRepo, 'v1.0.0');

      // Verify create command was executed
      // Argv shape now `tag --end-of-options v1.0.0`.
      const createCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'tag' && cmd.args.includes('v1.0.0')
      );
      assert.ok(createCommand, 'Create tag command should have been executed');

      // Push the tag
      await gitService.pushTag(mockRepo, 'v1.0.0');

      // Verify push command was executed
      const pushCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'push' && cmd.args.includes('refs/tags/v1.0.0')
      );
      assert.ok(pushCommand, 'Push tag command should have been executed');
    });

    it('should be able to create tag at specific commit and checkout', async () => {
      // Create a tag at a specific commit
      await gitService.createTag(mockRepo, 'v1.0.0', 'Release', 'abc123');

      // Verify create command was executed with ref
      const createCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'tag' && cmd.args.includes('abc123')
      );
      assert.ok(createCommand, 'Create tag command should have been executed with ref');

      // Checkout the tag
      await gitService.checkout(mockRepo, 'v1.0.0');

      // Verify checkout command was executed.
      // `checkout` splices `--end-of-options`, so the ref is at args[2].
      const checkoutCommand = mockGitCli.executedCommands.find(
        (cmd) => cmd.args[0] === 'checkout' && cmd.args.includes('v1.0.0')
      );
      assert.ok(checkoutCommand, 'Checkout command should have been executed');
    });
  });
});

/**
 * Unit tests for GitService cherry-pick operations.
 *
 * Tests cover:
 * - cherryPick() for single and multiple commits
 * - Cherry-pick conflict handling
 * - cherryPickAbort() for aborting cherry-pick
 * - cherryPickContinue() for continuing after conflict resolution
 */
describe('GitService - Cherry-Pick Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('cherryPick()', () => {
    describe('Cherry-pick single commit', () => {
      it('should execute git cherry-pick with single commit hash', async () => {
        const result = (await gitService.cherryPick(mockRepo, ['abc123def456']))._unsafeUnwrap();

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'cherry-pick',
          '--end-of-options',
          'abc123def456',
        ]);
        assert.strictEqual(result.success, true);
      });

      it('should pass the correct working directory', async () => {
        await gitService.cherryPick(mockRepo, ['abc123']);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return success when cherry-pick succeeds', async () => {
        mockGitCli.setMockResult('cherry-pick --end-of-options abc123', {
          exitCode: 0,
          stdout: '[main abc123] Cherry-picked commit\n',
          stderr: '',
        });

        const result = (await gitService.cherryPick(mockRepo, ['abc123']))._unsafeUnwrap();

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.conflicts, undefined);
      });
    });

    describe('Cherry-pick multiple commits', () => {
      it('should execute git cherry-pick with multiple commit hashes in order', async () => {
        const commits = ['commit1', 'commit2', 'commit3'];
        await gitService.cherryPick(mockRepo, commits);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'cherry-pick',
          '--end-of-options',
          'commit1',
          'commit2',
          'commit3',
        ]);
      });

      it('should preserve commit order when cherry-picking multiple commits', async () => {
        const commits = ['first', 'second', 'third'];
        await gitService.cherryPick(mockRepo, commits);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Refs follow `--end-of-options`. Verify order is preserved.
        assert.deepStrictEqual(lastCommand.args, [
          'cherry-pick',
          '--end-of-options',
          'first',
          'second',
          'third',
        ]);
      });

      it('should return success when all commits are cherry-picked', async () => {
        mockGitCli.setMockResult('cherry-pick --end-of-options commit1 commit2', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = (
          await gitService.cherryPick(mockRepo, ['commit1', 'commit2'])
        )._unsafeUnwrap();

        assert.strictEqual(result.success, true);
      });
    });

    describe('Cherry-pick with empty commits array', () => {
      it('should return success immediately for empty commits array', async () => {
        const result = (await gitService.cherryPick(mockRepo, []))._unsafeUnwrap();

        assert.strictEqual(result.success, true);
        // No command should be executed
        assert.strictEqual(mockGitCli.executedCommands.length, 0);
      });
    });

    describe('Cherry-pick conflict handling', () => {
      it('should return conflicts when cherry-pick fails due to conflicts', async () => {
        // Mock cherry-pick failure
        mockGitCli.setMockResult('cherry-pick --end-of-options conflicting-commit', {
          exitCode: 1,
          stdout: '',
          stderr:
            'error: could not apply abc123... commit message\nhint: after resolving the conflicts',
        });

        // Mock status showing conflicted files
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU conflicted-file.ts\nUU another-conflict.ts\n',
          stderr: '',
        });

        const result = (
          await gitService.cherryPick(mockRepo, ['conflicting-commit'])
        )._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.strictEqual(result.conflicts.length, 2);
        assert.ok(result.conflicts.includes('conflicted-file.ts'));
        assert.ok(result.conflicts.includes('another-conflict.ts'));
      });

      it('should detect conflicts with different conflict markers', async () => {
        // Mock cherry-pick failure
        mockGitCli.setMockResult('cherry-pick --end-of-options abc123', {
          exitCode: 1,
          stdout: '',
          stderr: 'CONFLICT (content): Merge conflict in file.ts',
        });

        // Mock status with various conflict states
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU both-modified.ts\nUA added-by-us.ts\nAU added-by-them.ts\n',
          stderr: '',
        });

        const result = (await gitService.cherryPick(mockRepo, ['abc123']))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.strictEqual(result.conflicts.length, 3);
      });

      it('should return empty conflicts array when failure is not due to conflicts', async () => {
        // Mock cherry-pick failure without conflicts
        mockGitCli.setMockResult('cherry-pick --end-of-options invalid-commit', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: bad revision 'invalid-commit'",
        });

        // Mock status showing no conflicts
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'M modified-file.ts\n',
          stderr: '',
        });

        const result = (await gitService.cherryPick(mockRepo, ['invalid-commit']))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts array');
        assert.strictEqual(result.conflicts.length, 0);
      });
    });

    describe('-x cherry-picked-from suffix (#P2)', () => {
      it('adds -x before the ref guard when addCherryPickedFrom is set', async () => {
        await gitService.cherryPick(mockRepo, ['abc123'], { addCherryPickedFrom: true });
        assert.deepStrictEqual(mockGitCli.getLastCommand()!.args, [
          'cherry-pick',
          '-x',
          '--end-of-options',
          'abc123',
        ]);
      });

      it('omits -x by default (legacy behavior unchanged)', async () => {
        await gitService.cherryPick(mockRepo, ['abc123']);
        assert.ok(!mockGitCli.getLastCommand()!.args.includes('-x'));
      });

      it('does NOT add -x when --no-commit is in effect (no commit to annotate)', async () => {
        await gitService.cherryPick(mockRepo, ['abc123'], {
          addCherryPickedFrom: true,
          noCommit: true,
        });
        const args = mockGitCli.getLastCommand()!.args;
        assert.ok(args.includes('--no-commit'), 'no-commit present');
        assert.ok(!args.includes('-x'), '-x suppressed when not committing');
      });
    });
  });

  describe('cherryPickAbort()', () => {
    describe('Abort cherry-pick operation', () => {
      it('should execute git cherry-pick --abort', async () => {
        await gitService.cherryPickAbort(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['cherry-pick', '--abort']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.cherryPickAbort(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw error when no cherry-pick in progress', async () => {
        mockGitCli.setMockResult('cherry-pick --abort', {
          exitCode: 128,
          stdout: '',
          stderr: 'error: no cherry-pick in progress',
        });

        const abortResult = await gitService.cherryPickAbort(mockRepo);
        assert.ok(abortResult.isErr(), 'Should return Err when no cherry-pick in progress');
        assert.match(abortResult._unsafeUnwrapErr().message, /Git command failed/);
      });

      it('should restore working directory to pre-cherry-pick state', async () => {
        // This test verifies the command is executed correctly
        // The actual restoration is handled by Git
        mockGitCli.setMockResult('cherry-pick --abort', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.cherryPickAbort(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['cherry-pick', '--abort']);
      });
    });
  });

  describe('cherryPickContinue()', () => {
    describe('Continue cherry-pick after conflict resolution', () => {
      it('should execute git cherry-pick --continue', async () => {
        await gitService.cherryPickContinue(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['cherry-pick', '--continue']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.cherryPickContinue(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return success when continue succeeds', async () => {
        mockGitCli.setMockResult('cherry-pick --continue', {
          exitCode: 0,
          stdout: '[main abc123] Cherry-picked commit\n',
          stderr: '',
        });

        const result = (await gitService.cherryPickContinue(mockRepo))._unsafeUnwrap();

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.conflicts, undefined);
      });

      it('should return conflicts when continue encounters more conflicts', async () => {
        // When cherry-picking multiple commits, continuing might hit another conflict
        mockGitCli.setMockResult('cherry-pick --continue', {
          exitCode: 1,
          stdout: '',
          stderr:
            'error: could not apply def456... second commit\nhint: after resolving the conflicts',
        });

        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU new-conflict.ts\n',
          stderr: '',
        });

        const result = (await gitService.cherryPickContinue(mockRepo))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.strictEqual(result.conflicts.length, 1);
        assert.ok(result.conflicts.includes('new-conflict.ts'));
      });

      it('should handle continue when conflicts are not resolved', async () => {
        mockGitCli.setMockResult('cherry-pick --continue', {
          exitCode: 128,
          stdout: '',
          stderr: 'error: Committing is not possible because you have unmerged files.',
        });

        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU unresolved-file.ts\n',
          stderr: '',
        });

        const result = (await gitService.cherryPickContinue(mockRepo))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.ok(result.conflicts.includes('unresolved-file.ts'));
      });
    });
  });

  describe('Cherry-pick workflow integration', () => {
    it('should handle complete cherry-pick workflow: pick -> conflict -> abort', async () => {
      // Cherry-pick causes conflict
      mockGitCli.setMockResult('cherry-pick --end-of-options conflict-commit', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT',
      });
      mockGitCli.setMockResult('status --porcelain -z', {
        exitCode: 0,
        stdout: 'UU file.ts\n',
        stderr: '',
      });

      const pickResult = (
        await gitService.cherryPick(mockRepo, ['conflict-commit'])
      )._unsafeUnwrap();
      assert.strictEqual(pickResult.success, false);
      assert.ok(pickResult.conflicts?.includes('file.ts'));

      // Abort the cherry-pick
      mockGitCli.setMockResult('cherry-pick --abort', {
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      await gitService.cherryPickAbort(mockRepo);

      // Verify abort was called
      const abortCommand = mockGitCli.executedCommands.find((cmd) => cmd.args.includes('--abort'));
      assert.ok(abortCommand, 'Abort command should have been executed');
    });

    it('should handle complete cherry-pick workflow: pick -> conflict -> resolve -> continue', async () => {
      // Cherry-pick causes conflict
      mockGitCli.setMockResult('cherry-pick --end-of-options conflict-commit', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT',
      });
      mockGitCli.setMockResultByPrefix('status --porcelain', {
        exitCode: 0,
        stdout: 'UU file.ts\n',
        stderr: '',
      });

      const pickResult = (
        await gitService.cherryPick(mockRepo, ['conflict-commit'])
      )._unsafeUnwrap();
      assert.strictEqual(pickResult.success, false);

      // User resolves conflicts (simulated by changing status mock)
      mockGitCli.mockResults.delete('status --porcelain -z');
      mockGitCli.mockResultsByPrefix.delete('status --porcelain');
      mockGitCli.setMockResult('cherry-pick --continue', {
        exitCode: 0,
        stdout: '[main abc123] Cherry-picked commit\n',
        stderr: '',
      });

      // Continue the cherry-pick
      const continueResult = (await gitService.cherryPickContinue(mockRepo))._unsafeUnwrap();
      assert.strictEqual(continueResult.success, true);
    });

    it('should handle cherry-picking multiple commits with conflict in middle', async () => {
      // Cherry-pick multiple commits, second one conflicts
      mockGitCli.setMockResult('cherry-pick --end-of-options commit1 commit2 commit3', {
        exitCode: 1,
        stdout: '',
        stderr: 'error: could not apply commit2',
      });
      mockGitCli.setMockResult('status --porcelain -z', {
        exitCode: 0,
        stdout: 'UU conflicted.ts\n',
        stderr: '',
      });

      const result = (
        await gitService.cherryPick(mockRepo, ['commit1', 'commit2', 'commit3'])
      )._unsafeUnwrap();

      assert.strictEqual(result.success, false);
      assert.ok(result.conflicts?.includes('conflicted.ts'));
    });
  });
});

/**
 * Unit tests for GitService revert operations.
 *
 * Tests cover:
 * - revert() for single and multiple commits
 * - Revert conflict handling
 * - revertAbort() for aborting revert
 * - revertContinue() for continuing after conflict resolution
 */
describe('GitService - Revert Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('revert()', () => {
    describe('Revert single commit', () => {
      it('should execute git revert with single commit hash', async () => {
        const result = (await gitService.revert(mockRepo, ['abc123def456']))._unsafeUnwrap();

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, [
          'revert',
          '--no-edit',
          '--end-of-options',
          'abc123def456',
        ]);
        assert.strictEqual(result.success, true);
      });

      it('should pass the correct working directory', async () => {
        await gitService.revert(mockRepo, ['abc123']);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return success when revert succeeds', async () => {
        mockGitCli.setMockResult('revert --no-edit --end-of-options abc123', {
          exitCode: 0,
          stdout: '[main def456] Revert "Original commit message"\n',
          stderr: '',
        });

        const result = (await gitService.revert(mockRepo, ['abc123']))._unsafeUnwrap();

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.conflicts, undefined);
      });

      it('should create a new commit that undoes the changes', async () => {
        // Verify the revert command uses --no-edit to auto-generate commit message
        await gitService.revert(mockRepo, ['abc123']);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--no-edit'), 'Should use --no-edit flag');
      });
    });

    describe('Revert multiple commits', () => {
      it('should execute git revert with multiple commit hashes in order', async () => {
        const commits = ['commit1', 'commit2', 'commit3'];
        await gitService.revert(mockRepo, commits);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Refs follow `--no-edit --end-of-options`.
        assert.deepStrictEqual(lastCommand.args, [
          'revert',
          '--no-edit',
          '--end-of-options',
          'commit1',
          'commit2',
          'commit3',
        ]);
      });

      it('should preserve commit order when reverting multiple commits', async () => {
        const commits = ['first', 'second', 'third'];
        await gitService.revert(mockRepo, commits);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        // Refs follow `--no-edit --end-of-options`.
        assert.deepStrictEqual(lastCommand.args, [
          'revert',
          '--no-edit',
          '--end-of-options',
          'first',
          'second',
          'third',
        ]);
      });

      it('should return success when all commits are reverted', async () => {
        mockGitCli.setMockResult('revert --no-edit --end-of-options commit1 commit2', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const result = (await gitService.revert(mockRepo, ['commit1', 'commit2']))._unsafeUnwrap();

        assert.strictEqual(result.success, true);
      });
    });

    describe('Revert with empty commits array', () => {
      it('should return success immediately for empty commits array', async () => {
        const result = (await gitService.revert(mockRepo, []))._unsafeUnwrap();

        assert.strictEqual(result.success, true);
        // No command should be executed
        assert.strictEqual(mockGitCli.executedCommands.length, 0);
      });
    });

    describe('Revert conflict handling', () => {
      it('should return conflicts when revert fails due to conflicts', async () => {
        // Mock revert failure
        mockGitCli.setMockResult('revert --no-edit --end-of-options conflicting-commit', {
          exitCode: 1,
          stdout: '',
          stderr:
            'error: could not revert abc123... commit message\nhint: after resolving the conflicts',
        });

        // Mock status showing conflicted files
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU conflicted-file.ts\nUU another-conflict.ts\n',
          stderr: '',
        });

        const result = (await gitService.revert(mockRepo, ['conflicting-commit']))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.strictEqual(result.conflicts.length, 2);
        assert.ok(result.conflicts.includes('conflicted-file.ts'));
        assert.ok(result.conflicts.includes('another-conflict.ts'));
      });

      it('should detect conflicts with different conflict markers', async () => {
        // Mock revert failure
        mockGitCli.setMockResult('revert --no-edit --end-of-options abc123', {
          exitCode: 1,
          stdout: '',
          stderr: 'CONFLICT (content): Merge conflict in file.ts',
        });

        // Mock status with various conflict states
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU both-modified.ts\nUA added-by-us.ts\nAU added-by-them.ts\n',
          stderr: '',
        });

        const result = (await gitService.revert(mockRepo, ['abc123']))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.strictEqual(result.conflicts.length, 3);
      });

      it('should return empty conflicts array when failure is not due to conflicts', async () => {
        // Mock revert failure without conflicts
        mockGitCli.setMockResult('revert --no-edit --end-of-options invalid-commit', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: bad revision 'invalid-commit'",
        });

        // Mock status showing no conflicts
        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'M modified-file.ts\n',
          stderr: '',
        });

        const result = (await gitService.revert(mockRepo, ['invalid-commit']))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts array');
        assert.strictEqual(result.conflicts.length, 0);
      });
    });
  });

  describe('revertAbort()', () => {
    describe('Abort revert operation', () => {
      it('should execute git revert --abort', async () => {
        await gitService.revertAbort(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['revert', '--abort']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.revertAbort(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should throw error when no revert in progress', async () => {
        mockGitCli.setMockResult('revert --abort', {
          exitCode: 128,
          stdout: '',
          stderr: 'error: no revert in progress',
        });

        const abortResult = await gitService.revertAbort(mockRepo);
        assert.ok(abortResult.isErr(), 'Should return Err when no revert in progress');
        assert.match(abortResult._unsafeUnwrapErr().message, /Git command failed/);
      });

      it('should restore working directory to pre-revert state', async () => {
        // This test verifies the command is executed correctly
        // The actual restoration is handled by Git
        mockGitCli.setMockResult('revert --abort', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.revertAbort(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['revert', '--abort']);
      });
    });
  });

  describe('revertContinue()', () => {
    describe('Continue revert after conflict resolution', () => {
      it('should execute git revert --continue', async () => {
        await gitService.revertContinue(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.deepStrictEqual(lastCommand.args, ['revert', '--continue']);
      });

      it('should pass the correct working directory', async () => {
        await gitService.revertContinue(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return success when continue succeeds', async () => {
        mockGitCli.setMockResult('revert --continue', {
          exitCode: 0,
          stdout: '[main def456] Revert "Original commit"\n',
          stderr: '',
        });

        const result = (await gitService.revertContinue(mockRepo))._unsafeUnwrap();

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.conflicts, undefined);
      });

      it('should return conflicts when continue encounters more conflicts', async () => {
        // When reverting multiple commits, continuing might hit another conflict
        mockGitCli.setMockResult('revert --continue', {
          exitCode: 1,
          stdout: '',
          stderr:
            'error: could not revert def456... second commit\nhint: after resolving the conflicts',
        });

        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU new-conflict.ts\n',
          stderr: '',
        });

        const result = (await gitService.revertContinue(mockRepo))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.strictEqual(result.conflicts.length, 1);
        assert.ok(result.conflicts.includes('new-conflict.ts'));
      });

      it('should handle continue when conflicts are not resolved', async () => {
        mockGitCli.setMockResult('revert --continue', {
          exitCode: 128,
          stdout: '',
          stderr: 'error: Committing is not possible because you have unmerged files.',
        });

        mockGitCli.setMockResult('status --porcelain -z', {
          exitCode: 0,
          stdout: 'UU unresolved-file.ts\n',
          stderr: '',
        });

        const result = (await gitService.revertContinue(mockRepo))._unsafeUnwrap();

        assert.strictEqual(result.success, false);
        assert.ok(result.conflicts, 'Should have conflicts');
        assert.ok(result.conflicts.includes('unresolved-file.ts'));
      });
    });
  });

  describe('Revert workflow integration', () => {
    it('should handle complete revert workflow: revert -> conflict -> abort', async () => {
      // Revert causes conflict
      mockGitCli.setMockResult('revert --no-edit --end-of-options conflict-commit', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT',
      });
      mockGitCli.setMockResult('status --porcelain -z', {
        exitCode: 0,
        stdout: 'UU file.ts\n',
        stderr: '',
      });

      const revertResult = (await gitService.revert(mockRepo, ['conflict-commit']))._unsafeUnwrap();
      assert.strictEqual(revertResult.success, false);
      assert.ok(revertResult.conflicts?.includes('file.ts'));

      // Abort the revert
      mockGitCli.setMockResult('revert --abort', {
        exitCode: 0,
        stdout: '',
        stderr: '',
      });

      await gitService.revertAbort(mockRepo);

      // Verify abort was called
      const abortCommand = mockGitCli.executedCommands.find((cmd) => cmd.args.includes('--abort'));
      assert.ok(abortCommand, 'Abort command should have been executed');
    });

    it('should handle complete revert workflow: revert -> conflict -> resolve -> continue', async () => {
      // Revert causes conflict
      mockGitCli.setMockResult('revert --no-edit --end-of-options conflict-commit', {
        exitCode: 1,
        stdout: '',
        stderr: 'CONFLICT',
      });
      mockGitCli.setMockResultByPrefix('status --porcelain', {
        exitCode: 0,
        stdout: 'UU file.ts\n',
        stderr: '',
      });

      const revertResult = (await gitService.revert(mockRepo, ['conflict-commit']))._unsafeUnwrap();
      assert.strictEqual(revertResult.success, false);

      // User resolves conflicts (simulated by changing status mock)
      mockGitCli.mockResults.delete('status --porcelain -z');
      mockGitCli.mockResultsByPrefix.delete('status --porcelain');
      mockGitCli.setMockResult('revert --continue', {
        exitCode: 0,
        stdout: '[main def456] Revert "Original commit"\n',
        stderr: '',
      });

      // Continue the revert
      const continueResult = (await gitService.revertContinue(mockRepo))._unsafeUnwrap();
      assert.strictEqual(continueResult.success, true);
    });

    it('should handle reverting multiple commits with conflict in middle', async () => {
      // Revert multiple commits, second one conflicts
      mockGitCli.setMockResult('revert --no-edit --end-of-options commit1 commit2 commit3', {
        exitCode: 1,
        stdout: '',
        stderr: 'error: could not revert commit2',
      });
      mockGitCli.setMockResult('status --porcelain -z', {
        exitCode: 0,
        stdout: 'UU conflicted.ts\n',
        stderr: '',
      });

      const result = (
        await gitService.revert(mockRepo, ['commit1', 'commit2', 'commit3'])
      )._unsafeUnwrap();

      assert.strictEqual(result.success, false);
      assert.ok(result.conflicts?.includes('conflicted.ts'));
    });
  });
});

/**
 * Unit tests for GitService log/history operations.
 *
 * Tests cover:
 * - getLog() with LogOptions filtering
 * - getCommit() for single commit details
 * - getFileHistory() for file-specific history
 * - Parsing log output into ICommit models
 */
describe('GitService - Log Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  // Sample log output in the expected format (multiple commits separated by null character)
  const multipleCommitsOutput = [
    'abc123def456abc123John Doejohn@example.com2024-01-15T10:30:00ZJohn Doejohn@example.com2024-01-15T10:30:00Zparent123First commit\nFirst body\0',
    'def456abc789def456Jane Smithjane@example.com2024-01-14T09:00:00ZJane Smithjane@example.com2024-01-14T09:00:00Zparent456Second commit\nSecond body\0',
    'ghi789def012ghi789Bob Wilsonbob@example.com2024-01-13T08:00:00ZBob Wilsonbob@example.com2024-01-13T08:00:00ZThird commit\n\0',
  ].join('');

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('getLog()', () => {
    describe('Basic log retrieval', () => {
      it('should execute git log with format option', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual(lastCommand.args[0], 'log');
        assert.ok(lastCommand.args[1].startsWith('--format='), 'Should include format option');
        assert.ok(lastCommand.args.includes('-z'), 'Should include -z for null-separated output');
      });

      it('should pass the correct working directory', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should return empty array when command fails', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 1,
          stdout: '',
          stderr: 'fatal: not a git repository',
        });

        const commits = await gitService.getLog(mockRepo);
        assert.deepStrictEqual(commits, []);
      });

      it('should parse commit output correctly', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: multipleCommitsOutput,
          stderr: '',
        });

        const commits = await gitService.getLog(mockRepo);

        assert.strictEqual(commits.length, 3);

        // Verify first commit
        assert.strictEqual(commits[0].hash, 'abc123def456');
        assert.strictEqual(commits[0].shortHash, 'abc123');
        assert.strictEqual(commits[0].message, 'First commit');
        assert.strictEqual(commits[0].author.name, 'John Doe');
        assert.strictEqual(commits[0].author.email, 'john@example.com');
        assert.deepStrictEqual(commits[0].parents, ['parent123']);

        // Verify second commit
        assert.strictEqual(commits[1].hash, 'def456abc789');
        assert.strictEqual(commits[1].shortHash, 'def456');
        assert.strictEqual(commits[1].message, 'Second commit');
        assert.strictEqual(commits[1].author.name, 'Jane Smith');

        // Verify third commit (no parent - initial commit)
        assert.strictEqual(commits[2].hash, 'ghi789def012');
        assert.strictEqual(commits[2].message, 'Third commit');
        assert.deepStrictEqual(commits[2].parents, []);
      });
    });

    describe('Log filtering by maxCount and skip', () => {
      it('should include -n option when maxCount is specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { maxCount: 10 });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('-n10'), 'Should include -n10 option');
      });

      it('should include --skip option when skip is specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { skip: 5 });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--skip=5'), 'Should include --skip=5 option');
      });

      it('should include both maxCount and skip when both are specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { maxCount: 20, skip: 10 });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('-n20'), 'Should include -n20 option');
        assert.ok(lastCommand.args.includes('--skip=10'), 'Should include --skip=10 option');
      });
    });

    describe('Log topology ordering', () => {
      // Why: post-rebase / squash / cherry-pick give commits a fresh
      // committerDate of "now". Without --topo-order, git's default
      // date-driven walk interleaves divergent branches between a
      // commit and its real parent, which the graph algorithm reads
      // as a linear ancestry — exactly the user-visible "linear after
      // squash" bug. The graph caller MUST set topoOrder; this test
      // pins that the flag makes it onto the wire.
      it('should include --topo-order when topoOrder option is true', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { topoOrder: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('--topo-order'),
          `Should include --topo-order; got args: ${lastCommand.args.join(' ')}`
        );
      });

      it('should NOT include --topo-order by default (non-graph callers keep git default ordering)', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo);

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          !lastCommand.args.includes('--topo-order'),
          `Default callers should NOT get --topo-order; got args: ${lastCommand.args.join(' ')}`
        );
      });

      it('should NOT include --topo-order when topoOrder is explicitly false', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { topoOrder: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          !lastCommand.args.includes('--topo-order'),
          `topoOrder:false should NOT add --topo-order; got args: ${lastCommand.args.join(' ')}`
        );
      });
    });

    describe('Log filtering by author', () => {
      it('should include --author option when author is specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { author: 'John Doe' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--author=John Doe'), 'Should include --author option');
      });

      it('should filter by author email', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { author: 'john@example.com' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('--author=john@example.com'),
          'Should include --author option with email'
        );
      });
    });

    describe('Log filtering by date range', () => {
      it('should include --since option when since date is specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const sinceDate = new Date('2024-01-01T00:00:00Z');
        await gitService.getLog(mockRepo, { since: sinceDate });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.some((arg: string) => arg.startsWith('--since=')),
          'Should include --since option'
        );
      });

      it('should include --until option when until date is specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const untilDate = new Date('2024-12-31T23:59:59Z');
        await gitService.getLog(mockRepo, { until: untilDate });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.some((arg: string) => arg.startsWith('--until=')),
          'Should include --until option'
        );
      });

      it('should include both since and until when date range is specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const sinceDate = new Date('2024-01-01T00:00:00Z');
        const untilDate = new Date('2024-06-30T23:59:59Z');
        await gitService.getLog(mockRepo, { since: sinceDate, until: untilDate });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.some((arg: string) => arg.startsWith('--since=')),
          'Should include --since option'
        );
        assert.ok(
          lastCommand.args.some((arg: string) => arg.startsWith('--until=')),
          'Should include --until option'
        );
      });
    });

    describe('Log filtering by path', () => {
      it('should include path after -- when path is specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { path: 'src/file.ts' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--'), 'Should include -- separator');
        assert.ok(lastCommand.args.includes('src/file.ts'), 'Should include path');
      });

      it('should handle paths with spaces', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { path: 'src/my file.ts' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('src/my file.ts'), 'Should include path with spaces');
      });

      it('should handle directory paths', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { path: 'src/components/' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('src/components/'), 'Should include directory path');
      });
    });

    describe('Log filtering by commit message search', () => {
      it('should include --grep option when grep is specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { grep: 'fix bug' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--grep=fix bug'), 'Should include --grep option');
      });

      it('should handle regex patterns in grep', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { grep: 'fix.*bug' });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('--grep=fix.*bug'),
          'Should include --grep option with regex'
        );
      });
    });

    describe('Log with --all option', () => {
      it('should include --all option when all is true', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { all: true });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('--all'), 'Should include --all option');
        assert.ok(lastCommand.args.includes('--exclude=refs/stash'), 'Should exclude stash refs');
      });

      it('should not include --all option when all is false', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getLog(mockRepo, { all: false });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(!lastCommand.args.includes('--all'), 'Should not include --all option');
      });
    });

    describe('Combined filter options', () => {
      it('should include all filter options when multiple are specified', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const sinceDate = new Date('2024-01-01T00:00:00Z');
        await gitService.getLog(mockRepo, {
          maxCount: 50,
          author: 'John Doe',
          since: sinceDate,
          grep: 'feature',
          path: 'src/',
        });

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(lastCommand.args.includes('-n50'), 'Should include maxCount');
        assert.ok(lastCommand.args.includes('--author=John Doe'), 'Should include author');
        assert.ok(
          lastCommand.args.some((arg: string) => arg.startsWith('--since=')),
          'Should include since'
        );
        assert.ok(lastCommand.args.includes('--grep=feature'), 'Should include grep');
        assert.ok(lastCommand.args.includes('--'), 'Should include -- separator');
        assert.ok(lastCommand.args.includes('src/'), 'Should include path');
      });
    });
  });

  describe('getCommit()', () => {
    describe('Single commit retrieval', () => {
      it('should execute git show with commit hash', async () => {
        const commitOutput =
          'abc123def456abc123John Doejohn@example.com2024-01-15T10:30:00ZJohn Doejohn@example.com2024-01-15T10:30:00Zparent123Test commit\nCommit body\0';

        mockGitCli.setMockResultByPrefix('show -s --format=', {
          exitCode: 0,
          stdout: commitOutput,
          stderr: '',
        });

        await gitService.getCommit(mockRepo, 'abc123def456');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual(lastCommand.args[0], 'show');
        assert.strictEqual(lastCommand.args[1], '-s');
        assert.ok(lastCommand.args[2].startsWith('--format='), 'Should include format option');
        assert.ok(lastCommand.args.includes('-z'), 'Should include -z option');
        assert.ok(lastCommand.args.includes('abc123def456'), 'Should include commit hash');
      });

      it('should pass the correct working directory', async () => {
        const commitOutput =
          'abc123def456abc123John Doejohn@example.com2024-01-15T10:30:00ZJohn Doejohn@example.com2024-01-15T10:30:00Zparent123Test commit\n\0';

        mockGitCli.setMockResultByPrefix('show -s --format=', {
          exitCode: 0,
          stdout: commitOutput,
          stderr: '',
        });

        await gitService.getCommit(mockRepo, 'abc123');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual((lastCommand.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should parse commit details correctly', async () => {
        const commitOutput =
          'abc123def456789abc123dJohn Doejohn@example.com2024-01-15T10:30:00ZJane Smithjane@example.com2024-01-15T11:00:00Zparent1 parent2Merge feature branch\nThis is the commit body with details.\0';

        mockGitCli.setMockResultByPrefix('show -s --format=', {
          exitCode: 0,
          stdout: commitOutput,
          stderr: '',
        });

        const commit = await gitService.getCommit(mockRepo, 'abc123def456789');

        assert.strictEqual(commit.hash, 'abc123def456789');
        assert.strictEqual(commit.shortHash, 'abc123d');
        assert.strictEqual(commit.message, 'Merge feature branch');
        assert.strictEqual(commit.body, 'This is the commit body with details.');
        assert.strictEqual(commit.author.name, 'John Doe');
        assert.strictEqual(commit.author.email, 'john@example.com');
        assert.strictEqual(commit.committer.name, 'Jane Smith');
        assert.strictEqual(commit.committer.email, 'jane@example.com');
        assert.deepStrictEqual(commit.parents, ['parent1', 'parent2']);
      });

      it('should throw error when commit is not found', async () => {
        mockGitCli.setMockResultByPrefix('show -s --format=', {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: bad object nonexistent123',
        });

        await assert.rejects(
          async () => gitService.getCommit(mockRepo, 'nonexistent123'),
          /Git command failed/,
          'Should throw error for non-existent commit'
        );
      });

      it('should handle short commit hash', async () => {
        const commitOutput =
          'abc123def456abc123John Doejohn@example.com2024-01-15T10:30:00ZJohn Doejohn@example.com2024-01-15T10:30:00ZInitial commit\n\0';

        mockGitCli.setMockResultByPrefix('show -s --format=', {
          exitCode: 0,
          stdout: commitOutput,
          stderr: '',
        });

        const commit = await gitService.getCommit(mockRepo, 'abc123');

        assert.strictEqual(commit.hash, 'abc123def456');
        assert.strictEqual(commit.shortHash, 'abc123');
      });

      it('should handle commit with no body', async () => {
        const commitOutput =
          'abc123def456abc123John Doejohn@example.com2024-01-15T10:30:00ZJohn Doejohn@example.com2024-01-15T10:30:00Zparent123Simple commit\n\0';

        mockGitCli.setMockResultByPrefix('show -s --format=', {
          exitCode: 0,
          stdout: commitOutput,
          stderr: '',
        });

        const commit = await gitService.getCommit(mockRepo, 'abc123def456');

        assert.strictEqual(commit.message, 'Simple commit');
        assert.strictEqual(commit.body, undefined);
      });

      it('should handle initial commit with no parents', async () => {
        const commitOutput =
          'abc123def456abc123John Doejohn@example.com2024-01-15T10:30:00ZJohn Doejohn@example.com2024-01-15T10:30:00ZInitial commit\n\0';

        mockGitCli.setMockResultByPrefix('show -s --format=', {
          exitCode: 0,
          stdout: commitOutput,
          stderr: '',
        });

        const commit = await gitService.getCommit(mockRepo, 'abc123def456');

        assert.deepStrictEqual(commit.parents, []);
      });

      it('should handle merge commit with multiple parents', async () => {
        const commitOutput =
          'abc123def456abc123John Doejohn@example.com2024-01-15T10:30:00ZJohn Doejohn@example.com2024-01-15T10:30:00Zparent1 parent2 parent3Octopus merge\n\0';

        mockGitCli.setMockResultByPrefix('show -s --format=', {
          exitCode: 0,
          stdout: commitOutput,
          stderr: '',
        });

        const commit = await gitService.getCommit(mockRepo, 'abc123def456');

        assert.deepStrictEqual(commit.parents, ['parent1', 'parent2', 'parent3']);
      });
    });
  });

  describe('getFileHistory()', () => {
    describe('File-specific history retrieval', () => {
      it('should call getLog with path option', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getFileHistory(mockRepo, 'src/file.ts');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.strictEqual(lastCommand.args[0], 'log');
        assert.ok(lastCommand.args.includes('--'), 'Should include -- separator');
        assert.ok(lastCommand.args.includes('src/file.ts'), 'Should include file path');
      });

      it('should return commits that modified the file', async () => {
        const fileHistoryOutput = [
          'abc123def456abc123John Doejohn@example.com2024-01-15T10:30:00ZJohn Doejohn@example.com2024-01-15T10:30:00Zparent123Updated file.ts\n\0',
          'def456abc789def456Jane Smithjane@example.com2024-01-10T09:00:00ZJane Smithjane@example.com2024-01-10T09:00:00Zparent456Created file.ts\n\0',
        ].join('');

        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: fileHistoryOutput,
          stderr: '',
        });

        const commits = await gitService.getFileHistory(mockRepo, 'src/file.ts');

        assert.strictEqual(commits.length, 2);
        assert.strictEqual(commits[0].message, 'Updated file.ts');
        assert.strictEqual(commits[1].message, 'Created file.ts');
      });

      it('should return empty array for file with no history', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        const commits = await gitService.getFileHistory(mockRepo, 'nonexistent.ts');

        assert.deepStrictEqual(commits, []);
      });

      it('should handle paths with special characters', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getFileHistory(mockRepo, 'src/[special]/file.ts');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('src/[special]/file.ts'),
          'Should include path with special characters'
        );
      });

      it('should handle nested directory paths', async () => {
        mockGitCli.setMockResultByPrefix('log --format=', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getFileHistory(mockRepo, 'src/components/ui/Button.tsx');

        const lastCommand = mockGitCli.getLastCommand();
        assert.ok(lastCommand, 'Command should have been executed');
        assert.ok(
          lastCommand.args.includes('src/components/ui/Button.tsx'),
          'Should include nested path'
        );
      });
    });
  });
});

/**
 * Unit tests for GitService multi-commit diff operations.
 *
 * Tests cover:
 * - getMultiCommitDiff() for calculating combined diff across multiple commits
 */
describe('GitService - Multi-Commit Diff Operations', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create a GitService instance
    gitService = new GitService();

    // Replace the internal GitCli with our mock
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;

    // Create a mock repository
    mockRepo = {
      rootUri: Uri.file('/test/repo'),
      state: 'idle',
      head: {
        name: 'main',
        commit: 'abc123',
        ahead: 0,
        behind: 0,
      },
      remotes: [],
      submodules: [],
    };
  });

  afterEach(() => {
    gitService.dispose();
  });

  describe('getMultiCommitDiff()', () => {
    describe('Empty and single commit cases', () => {
      it('should return empty array for empty commits array', async () => {
        const diffs = await gitService.getMultiCommitDiff(mockRepo, []);
        assert.deepStrictEqual(diffs, []);
      });

      it('should return single commit diff for single commit', async () => {
        const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,4 @@
 line1
+new line
 line2
 line3
`;
        mockGitCli.setMockResultByPrefix('show --format=', {
          exitCode: 0,
          stdout: diffOutput,
          stderr: '',
        });

        const diffs = await gitService.getMultiCommitDiff(mockRepo, ['abc123']);

        assert.strictEqual(diffs.length, 1);
        assert.strictEqual(diffs[0].path, 'file.ts');
      });
    });

    describe('Multiple commits combined diff', () => {
      it('should get commit dates to determine range', async () => {
        // Mock commit date responses
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit1', {
          exitCode: 0,
          stdout: '2024-01-10T10:00:00Z\n',
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit2', {
          exitCode: 0,
          stdout: '2024-01-15T10:00:00Z\n',
          stderr: '',
        });

        // Mock parent lookup
        mockGitCli.setMockResult('rev-parse --end-of-options commit1^', {
          exitCode: 0,
          stdout: 'parent123\n',
          stderr: '',
        });

        // Mock diff result
        mockGitCli.setMockResult('diff --end-of-options parent123 commit2', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getMultiCommitDiff(mockRepo, ['commit1', 'commit2']);

        // Verify commit dates were fetched
        const dateCommands = mockGitCli.executedCommands.filter(
          (cmd) =>
            cmd.args[0] === 'show' && cmd.args[1] === '-s' && cmd.args[2] === '--format=%cI%x09%P'
        );
        assert.strictEqual(dateCommands.length, 2, 'Should fetch dates for both commits');
      });

      it('should compute diff from oldest commit parent to newest commit', async () => {
        // Mock commit date responses - commit2 is older
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit1', {
          exitCode: 0,
          stdout: '2024-01-15T10:00:00Z\n',
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit2', {
          exitCode: 0,
          stdout: '2024-01-10T10:00:00Z\n',
          stderr: '',
        });

        // Mock parent lookup for oldest commit (commit2)
        mockGitCli.setMockResult('rev-parse --end-of-options commit2^', {
          exitCode: 0,
          stdout: 'parent_of_commit2\n',
          stderr: '',
        });

        // Mock diff result
        const diffOutput = `diff --git a/file.ts b/file.ts
--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,5 @@
 line1
+added in commit2
+added in commit1
 line2
 line3
`;
        mockGitCli.setMockResult('diff --end-of-options parent_of_commit2 commit1', {
          exitCode: 0,
          stdout: diffOutput,
          stderr: '',
        });

        const diffs = await gitService.getMultiCommitDiff(mockRepo, ['commit1', 'commit2']);

        // Verify diff was computed from parent of oldest to newest.
        // Refs follow `--end-of-options`.
        const diffCommand = mockGitCli.executedCommands.find(
          (cmd) => cmd.args[0] === 'diff' && cmd.args.includes('parent_of_commit2')
        );
        assert.ok(diffCommand, 'Should compute diff from parent of oldest commit');
        assert.ok(diffCommand.args.includes('commit1'), 'Should diff to newest commit');

        assert.strictEqual(diffs.length, 1);
        assert.strictEqual(diffs[0].path, 'file.ts');
      });

      it('should handle three or more commits', async () => {
        // Mock commit date responses
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit1', {
          exitCode: 0,
          stdout: '2024-01-20T10:00:00Z\n', // newest
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit2', {
          exitCode: 0,
          stdout: '2024-01-10T10:00:00Z\n', // oldest
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit3', {
          exitCode: 0,
          stdout: '2024-01-15T10:00:00Z\n', // middle
          stderr: '',
        });

        // Mock parent lookup for oldest commit (commit2)
        mockGitCli.setMockResult('rev-parse --end-of-options commit2^', {
          exitCode: 0,
          stdout: 'parent_of_commit2\n',
          stderr: '',
        });

        // Mock diff result
        mockGitCli.setMockResult('diff --end-of-options parent_of_commit2 commit1', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getMultiCommitDiff(mockRepo, ['commit1', 'commit2', 'commit3']);

        // Verify diff was computed from parent of oldest (commit2) to newest (commit1).
        // Refs follow `--end-of-options`.
        const diffCommand = mockGitCli.executedCommands.find(
          (cmd) => cmd.args[0] === 'diff' && cmd.args.includes('parent_of_commit2')
        );
        assert.ok(diffCommand, 'Should compute diff from parent of oldest commit');
        assert.ok(diffCommand.args.includes('commit1'), 'Should diff to newest commit');
      });

      it('should handle initial commit with no parent', async () => {
        // Mock commit date responses
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options initial_commit', {
          exitCode: 0,
          stdout: '2024-01-01T10:00:00Z\n',
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options later_commit', {
          exitCode: 0,
          stdout: '2024-01-15T10:00:00Z\n',
          stderr: '',
        });

        // Mock parent lookup - initial commit has no parent
        mockGitCli.setMockResult('rev-parse --end-of-options initial_commit^', {
          exitCode: 128,
          stdout: '',
          stderr: "fatal: ambiguous argument 'initial_commit^': unknown revision",
        });

        // Mock diff result using empty tree.
        // Refs follow `--end-of-options`.
        const emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
        mockGitCli.setMockResult(`diff --end-of-options ${emptyTreeSha} later_commit`, {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getMultiCommitDiff(mockRepo, ['initial_commit', 'later_commit']);

        // Verify diff was computed from empty tree to newest commit.
        const diffCommand = mockGitCli.executedCommands.find(
          (cmd) => cmd.args[0] === 'diff' && cmd.args.includes(emptyTreeSha)
        );
        assert.ok(diffCommand, 'Should compute diff from empty tree for initial commit');
        assert.ok(diffCommand.args.includes('later_commit'), 'Should diff to newest commit');
      });

      it('should return combined diff with multiple files', async () => {
        // Mock commit date responses
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit1', {
          exitCode: 0,
          stdout: '2024-01-10T10:00:00Z\n',
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit2', {
          exitCode: 0,
          stdout: '2024-01-15T10:00:00Z\n',
          stderr: '',
        });

        // Mock parent lookup
        mockGitCli.setMockResult('rev-parse --end-of-options commit1^', {
          exitCode: 0,
          stdout: 'parent123\n',
          stderr: '',
        });

        // Mock diff result with multiple files
        const diffOutput = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,3 +1,4 @@
 line1
+new line in file1
 line2
 line3
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1,2 +1,3 @@
 content
+new content in file2
 more content
`;
        mockGitCli.setMockResult('diff --end-of-options parent123 commit2', {
          exitCode: 0,
          stdout: diffOutput,
          stderr: '',
        });

        const diffs = await gitService.getMultiCommitDiff(mockRepo, ['commit1', 'commit2']);

        assert.strictEqual(diffs.length, 2, 'Should return diffs for both files');
        assert.strictEqual(diffs[0].path, 'file1.ts');
        assert.strictEqual(diffs[1].path, 'file2.ts');
      });

      it('should pass correct working directory', async () => {
        // Mock commit date responses
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit1', {
          exitCode: 0,
          stdout: '2024-01-10T10:00:00Z\n',
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit2', {
          exitCode: 0,
          stdout: '2024-01-15T10:00:00Z\n',
          stderr: '',
        });

        // Mock parent lookup
        mockGitCli.setMockResult('rev-parse --end-of-options commit1^', {
          exitCode: 0,
          stdout: 'parent123\n',
          stderr: '',
        });

        // Mock diff result
        mockGitCli.setMockResult('diff --end-of-options parent123 commit2', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        await gitService.getMultiCommitDiff(mockRepo, ['commit1', 'commit2']);

        // Verify all commands used correct working directory
        for (const cmd of mockGitCli.executedCommands) {
          assert.strictEqual(
            (cmd.options as { cwd: string }).cwd,
            '/test/repo',
            'All commands should use correct working directory'
          );
        }
      });

      it('should handle commits in any order', async () => {
        // Mock commit date responses - provide in reverse chronological order
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options newest', {
          exitCode: 0,
          stdout: '2024-01-20T10:00:00Z\n',
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options middle', {
          exitCode: 0,
          stdout: '2024-01-15T10:00:00Z\n',
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options oldest', {
          exitCode: 0,
          stdout: '2024-01-10T10:00:00Z\n',
          stderr: '',
        });

        // Mock parent lookup for oldest
        mockGitCli.setMockResult('rev-parse --end-of-options oldest^', {
          exitCode: 0,
          stdout: 'parent_of_oldest\n',
          stderr: '',
        });

        // Mock diff result
        mockGitCli.setMockResult('diff --end-of-options parent_of_oldest newest', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        // Pass commits in random order
        await gitService.getMultiCommitDiff(mockRepo, ['middle', 'newest', 'oldest']);

        // Verify diff was computed correctly regardless of input order.
        // Refs follow `--end-of-options`.
        const diffCommand = mockGitCli.executedCommands.find(
          (cmd) => cmd.args[0] === 'diff' && cmd.args.includes('parent_of_oldest')
        );
        assert.ok(diffCommand, 'Should compute diff from parent of oldest commit');
        assert.ok(diffCommand.args.includes('newest'), 'Should diff to newest commit');
      });

      it('should return empty array when no valid commit info found', async () => {
        // Mock commit date responses - all fail
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit1', {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: bad object commit1',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options commit2', {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: bad object commit2',
        });

        const diffs = await gitService.getMultiCommitDiff(mockRepo, ['commit1', 'commit2']);

        assert.deepStrictEqual(diffs, [], 'Should return empty array for invalid commits');
      });

      /**
       * When two commits share a commit date, the sort
       * must still produce a deterministic (and topologically correct)
       * oldest/newest pick regardless of input order. A naive
       * single-key sort would leave the choice up to input ordering,
       * which the UI cannot control (different selection paths hand the
       * same two commits over in different orders).
       */
      it('SR-R3: same-timestamp commits sort stably and topologically across input permutations', async () => {
        // Two commits with identical timestamps; "child" lists "parent"
        // as its git parent, so the range must be
        //   base = parent^  → diff to child (newest).
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options parent', {
          exitCode: 0,
          stdout: '2024-05-01T12:00:00Z\tgrandparent\n',
          stderr: '',
        });
        mockGitCli.setMockResult('show -s --format=%cI%x09%P --end-of-options child', {
          exitCode: 0,
          stdout: '2024-05-01T12:00:00Z\tparent\n',
          stderr: '',
        });
        mockGitCli.setMockResult('rev-parse --end-of-options parent^', {
          exitCode: 0,
          stdout: 'grandparent\n',
          stderr: '',
        });
        mockGitCli.setMockResult('diff --end-of-options grandparent child', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        // Forward order.
        await gitService.getMultiCommitDiff(mockRepo, ['parent', 'child']);
        const forwardDiff = mockGitCli.executedCommands
          .slice()
          .reverse()
          .find((cmd) => cmd.args[0] === 'diff');
        assert.ok(forwardDiff, 'forward pass should issue a diff command');
        assert.deepStrictEqual(
          forwardDiff.args,
          ['diff', '--end-of-options', 'grandparent', 'child'],
          'forward pass should diff from parent^ to the child (newest)'
        );

        // Reset and rerun with the selection reversed.
        mockGitCli.clearCommands();
        await gitService.getMultiCommitDiff(mockRepo, ['child', 'parent']);
        const reverseDiff = mockGitCli.executedCommands
          .slice()
          .reverse()
          .find((cmd) => cmd.args[0] === 'diff');
        assert.ok(reverseDiff, 'reverse pass should issue a diff command');
        assert.deepStrictEqual(
          reverseDiff.args,
          ['diff', '--end-of-options', 'grandparent', 'child'],
          'reverse pass must produce the same diff range — input order is irrelevant'
        );
      });
    });
  });
});

// ─── empty-repo HEAD surfacing + corrupt/detached/headless guards ────────────

describe('GitService — empty-repo HEAD surfacing', () => {
  let gitService: GitService;
  let mockGitCli: MockGitCli;

  beforeEach(() => {
    gitService = new GitService();
    mockGitCli = new MockGitCli();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    (gitService as any)._gitCli = mockGitCli;
  });

  afterEach(() => {
    gitService.dispose();
  });

  it('surfaces head.name from symbolic-ref when rev-parse HEAD fails (empty repo)', async () => {
    // Empty-repo shape:
    //   `git symbolic-ref HEAD` → `refs/heads/main` (exit 0)
    //   `git rev-parse HEAD`    → `fatal: ambiguous argument 'HEAD'` (exit 128)
    mockGitCli.setMockResult('symbolic-ref HEAD', {
      exitCode: 0,
      stdout: 'refs/heads/main\n',
      stderr: '',
    });
    mockGitCli.setMockResult('rev-parse HEAD', {
      exitCode: 128,
      stdout: '',
      stderr:
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n",
    });
    mockGitCli.setMockResult('status', { exitCode: 0, stdout: 'On branch main\n', stderr: '' });
    mockGitCli.setMockResult('remote -v', { exitCode: 0, stdout: '', stderr: '' });

    const repo = await (
      gitService as unknown as { loadRepository(rootPath: string): Promise<IRepository> }
    ).loadRepository('/test/repo');

    assert.ok(repo, 'expected a repository result');
    assert.ok(repo.head, 'expected repo.head to be set even when rev-parse HEAD failed');
    assert.strictEqual(repo.head.name, 'main', 'expected branch name from symbolic-ref');
    assert.strictEqual(repo.head.commit, '', 'expected empty commit for empty repo');
  });

  it('surfaces head.name for a non-default initial branch (e.g. trunk)', async () => {
    mockGitCli.setMockResult('symbolic-ref HEAD', {
      exitCode: 0,
      stdout: 'refs/heads/trunk\n',
      stderr: '',
    });
    mockGitCli.setMockResult('rev-parse HEAD', {
      exitCode: 128,
      stdout: '',
      stderr:
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\n",
    });
    mockGitCli.setMockResult('status', { exitCode: 0, stdout: 'On branch trunk\n', stderr: '' });
    mockGitCli.setMockResult('remote -v', { exitCode: 0, stdout: '', stderr: '' });

    const repo = await (
      gitService as unknown as { loadRepository(rootPath: string): Promise<IRepository> }
    ).loadRepository('/test/repo');

    assert.ok(repo.head);
    assert.strictEqual(repo.head.name, 'trunk');
    assert.strictEqual(repo.head.commit, '');
  });

  // When rev-parse fails with NON-empty-repo stderr (corrupt HEAD, missing
  // object, permission error), do NOT promote the symbolic-ref-only path
  // to "empty repo". Leave head undefined so the UI falls back to its
  // indeterminate-state treatment instead of pretending the repo is
  // freshly initialised.
  it('corrupt HEAD stderr leaves head undefined (NOT empty-repo)', async () => {
    mockGitCli.setMockResult('symbolic-ref HEAD', {
      exitCode: 0,
      stdout: 'refs/heads/main\n',
      stderr: '',
    });
    mockGitCli.setMockResult('rev-parse HEAD', {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: bad object HEAD\nerror: refs/heads/main does not point to a valid object!\n',
    });
    mockGitCli.setMockResult('status', { exitCode: 0, stdout: '', stderr: '' });
    mockGitCli.setMockResult('remote -v', { exitCode: 0, stdout: '', stderr: '' });

    const repo = await (
      gitService as unknown as { loadRepository(rootPath: string): Promise<IRepository> }
    ).loadRepository('/test/repo');

    assert.ok(repo, 'expected repository');
    assert.strictEqual(
      repo.head,
      undefined,
      'expected head undefined for corrupt-HEAD stderr (NOT empty-repo)'
    );
  });

  it('older "fatal: bad default revision" stderr still recognised as empty', async () => {
    mockGitCli.setMockResult('symbolic-ref HEAD', {
      exitCode: 0,
      stdout: 'refs/heads/master\n',
      stderr: '',
    });
    mockGitCli.setMockResult('rev-parse HEAD', {
      exitCode: 128,
      stdout: '',
      stderr: "fatal: bad default revision 'HEAD'\n",
    });
    mockGitCli.setMockResult('status', {
      exitCode: 0,
      stdout: 'On branch master\n',
      stderr: '',
    });
    mockGitCli.setMockResult('remote -v', { exitCode: 0, stdout: '', stderr: '' });

    const repo = await (
      gitService as unknown as { loadRepository(rootPath: string): Promise<IRepository> }
    ).loadRepository('/test/repo');

    assert.ok(repo.head, 'expected head set for older-git empty-repo signature');
    assert.strictEqual(repo.head.name, 'master');
    assert.strictEqual(repo.head.commit, '');
  });

  // Detached HEAD regression: symbolic-ref throws, rev-parse returns a
  // SHA. Pre-split this path returned head with `name: undefined,
  // commit: <sha>`; the new try/catch split must not break it.
  it('detached HEAD: symbolic-ref fails, rev-parse returns SHA → head.commit set, name undefined', async () => {
    mockGitCli.setMockResult('symbolic-ref HEAD', {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: ref HEAD is not a symbolic ref\n',
    });
    mockGitCli.setMockResult('rev-parse HEAD', {
      exitCode: 0,
      stdout: 'deadbeefcafebabe0000000000000000deadbeef\n',
      stderr: '',
    });
    mockGitCli.setMockResult('status', {
      exitCode: 0,
      stdout: 'HEAD detached at deadbeef\n',
      stderr: '',
    });
    mockGitCli.setMockResult('remote -v', { exitCode: 0, stdout: '', stderr: '' });

    const repo = await (
      gitService as unknown as { loadRepository(rootPath: string): Promise<IRepository> }
    ).loadRepository('/test/repo');

    assert.ok(repo.head, 'expected head set for detached-HEAD path');
    assert.strictEqual(repo.head.name, undefined, 'expected name undefined for detached HEAD');
    assert.strictEqual(
      repo.head.commit,
      'deadbeefcafebabe0000000000000000deadbeef',
      'expected commit SHA from rev-parse'
    );
  });

  // Truly-headless: BOTH symbolic-ref and rev-parse exit 128. Pre-split
  // this was the only failure path; post-split it's a corner. Pin the
  // contract that head stays undefined.
  it('both symbolic-ref AND rev-parse fail → head undefined', async () => {
    mockGitCli.setMockResult('symbolic-ref HEAD', {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: ref HEAD is not a symbolic ref\n',
    });
    mockGitCli.setMockResult('rev-parse HEAD', {
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository\n',
    });
    mockGitCli.setMockResult('status', { exitCode: 128, stdout: '', stderr: '' });
    mockGitCli.setMockResult('remote -v', { exitCode: 0, stdout: '', stderr: '' });

    const repo = await (
      gitService as unknown as { loadRepository(rootPath: string): Promise<IRepository> }
    ).loadRepository('/test/repo');

    assert.ok(repo, 'expected repository result even when both HEAD probes fail');
    assert.strictEqual(repo.head, undefined, 'expected head undefined when fully headless');
  });
});
