/**
 * Unit tests for BlameService.
 *
 * Tests cover:
 * - getBlame() for file blame information
 * - getBlameForLine() for single line blame
 * - getPreviousRevisionBlame() for navigating to previous revision
 * - Caching behavior
 * - Error handling
 */

import * as assert from 'assert';
import { BlameService } from '../../../src/blame/BlameService';
import { IRepository, IGitService } from '../../../src/git-core/interfaces/IGitService';
import { Uri, EventEmitter } from '../../mocks/vscode';

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

  // Helper to find a command by prefix
  findCommand(prefix: string): { args: string[]; options: unknown } | undefined {
    return this.executedCommands.find((cmd) => cmd.args.join(' ').startsWith(prefix));
  }
}

// Sample blame output in porcelain format.
// Mirrors REAL `git blame --porcelain`: a commit's header block (author /
// author-time / summary / …) is emitted ONLY on its first appearance. Line 2
// is the SAME commit as line 1 (`abc123…`) and therefore carries NO header
// block — git expects the consumer to resolve it from the sha. The parser must
// attribute it back to John Doe / "Initial commit" from the cached metadata.
const sampleBlameOutput = `abc123def456789012345678901234567890abcd 1 1 1
author John Doe
author-mail <john@example.com>
author-time 1609459200
author-tz +0000
committer John Doe
committer-mail <john@example.com>
committer-time 1609459200
committer-tz +0000
summary Initial commit
filename test.ts
\tconst x = 1;
abc123def456789012345678901234567890abcd 2 2 1
\tconst y = 2;
def456789012345678901234567890abcdef12 3 3 1
author Jane Smith
author-mail <jane@example.com>
author-time 1609545600
author-tz +0000
committer Jane Smith
committer-mail <jane@example.com>
committer-time 1609545600
committer-tz +0000
summary Add z variable
previous abc123def456789012345678901234567890abcd test.ts
filename test.ts
\tconst z = 3;
`;

describe('BlameService', () => {
  let blameService: BlameService;
  let mockGitCli: MockGitCli;
  let mockRepo: IRepository;

  beforeEach(() => {
    // Create mock GitCli
    mockGitCli = new MockGitCli();

    // Create BlameService with mock GitCli
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    blameService = new BlameService(mockGitCli as any);

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
    blameService.dispose();
  });

  describe('getBlame()', () => {
    describe('Basic blame functionality', () => {
      it('should execute git blame --porcelain with file path', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        await blameService.getBlame(mockRepo, 'test.ts');

        const command = mockGitCli.findCommand('blame --porcelain');
        assert.ok(command, 'Command should have been executed');
        assert.ok(command.args.includes('--porcelain'), 'Should include --porcelain flag');
        assert.ok(command.args.includes('test.ts'), 'Should include file path');
      });

      it('should pass the correct working directory', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        await blameService.getBlame(mockRepo, 'test.ts');

        const command = mockGitCli.findCommand('blame --porcelain');
        assert.ok(command, 'Command should have been executed');
        assert.strictEqual((command.options as { cwd: string }).cwd, '/test/repo');
      });

      it('should parse blame output correctly', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        const blameInfo = await blameService.getBlame(mockRepo, 'test.ts');

        assert.strictEqual(blameInfo.path, 'test.ts');
        // The parser should find at least 2 lines (may vary based on parser implementation)
        assert.ok(
          blameInfo.lines.length >= 2,
          `Expected at least 2 lines, got ${blameInfo.lines.length}`
        );

        // Check first line
        const firstLine = blameInfo.lines.find((l) => l.line === 1);
        assert.ok(firstLine, 'Should have line 1');
        assert.strictEqual(firstLine.commit, 'abc123def456789012345678901234567890abcd');
        assert.strictEqual(firstLine.author, 'John Doe');
        assert.strictEqual(firstLine.authorEmail, 'john@example.com');
        assert.strictEqual(firstLine.message, 'Initial commit');
      });

      it('should include previous commit information when available', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        const blameInfo = await blameService.getBlame(mockRepo, 'test.ts');

        // Third line should have previous commit info
        assert.strictEqual(
          blameInfo.lines[2].previousCommit,
          'abc123def456789012345678901234567890abcd'
        );
      });

      it('should return empty lines array when command fails', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: no such path',
        });

        const blameInfo = await blameService.getBlame(mockRepo, 'nonexistent.ts');

        assert.strictEqual(blameInfo.path, 'nonexistent.ts');
        assert.deepStrictEqual(blameInfo.lines, []);
      });
    });

    describe('Blame with revision', () => {
      it('should include revision in git blame command', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        await blameService.getBlame(mockRepo, 'test.ts', 'abc123');

        const command = mockGitCli.findCommand('blame --porcelain');
        assert.ok(command, 'Command should have been executed');
        assert.ok(command.args.includes('abc123'), 'Should include revision');
      });

      it('should work with branch name as revision', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        await blameService.getBlame(mockRepo, 'test.ts', 'feature-branch');

        const command = mockGitCli.findCommand('blame --porcelain');
        assert.ok(command, 'Command should have been executed');
        assert.ok(command.args.includes('feature-branch'), 'Should include branch name');
      });

      it('should work with tag as revision', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        await blameService.getBlame(mockRepo, 'test.ts', 'v1.0.0');

        const command = mockGitCli.findCommand('blame --porcelain');
        assert.ok(command, 'Command should have been executed');
        assert.ok(command.args.includes('v1.0.0'), 'Should include tag');
      });
    });

    describe('Caching behavior', () => {
      it('should cache blame results', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        // First call
        await blameService.getBlame(mockRepo, 'test.ts');
        const commandCount1 = mockGitCli.executedCommands.length;

        // Second call should use cache
        await blameService.getBlame(mockRepo, 'test.ts');
        const commandCount2 = mockGitCli.executedCommands.length;

        assert.strictEqual(commandCount1, commandCount2, 'Should not execute command again');
      });

      it('should cache different revisions separately', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        // First call with HEAD
        await blameService.getBlame(mockRepo, 'test.ts');
        const commandCount1 = mockGitCli.executedCommands.length;

        // Second call with specific revision
        await blameService.getBlame(mockRepo, 'test.ts', 'abc123');
        const commandCount2 = mockGitCli.executedCommands.length;

        assert.strictEqual(
          commandCount2,
          commandCount1 + 1,
          'Should execute command for different revision'
        );
      });

      it('should clear cache when clearCache is called', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        // First call
        await blameService.getBlame(mockRepo, 'test.ts');
        const commandCount1 = mockGitCli.executedCommands.length;

        // Clear cache
        blameService.clearCache();

        // Second call should execute command again
        await blameService.getBlame(mockRepo, 'test.ts');
        const commandCount2 = mockGitCli.executedCommands.length;

        assert.strictEqual(
          commandCount2,
          commandCount1 + 1,
          'Should execute command after cache clear'
        );
      });

      it('invalidates the cache on onDidChangeRepository (HEAD move without a file change)', async () => {
        // A commit/checkout/reset moves HEAD but does not touch the working-tree
        // bytes, so the file watcher never fires; the repo-change event must
        // still drop the stale HEAD-keyed blame.
        const repoChange = new EventEmitter<IRepository>();
        const gitService = {
          // BlameService reads its GitCli FROM the gitService when one is passed.
          gitCli: mockGitCli,
          getRepositories: (): IRepository[] => [mockRepo],
          onDidChangeRepository: repoChange.event,
          onDidRemoveRepository: new EventEmitter<IRepository>().event,
        } as unknown as IGitService;
        const svc = new BlameService(undefined, gitService);
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        await svc.getBlame(mockRepo, 'test.ts');
        const before = mockGitCli.executedCommands.length;

        // HEAD moved on this repo.
        repoChange.fire(mockRepo);

        await svc.getBlame(mockRepo, 'test.ts');
        assert.strictEqual(
          mockGitCli.executedCommands.length,
          before + 1,
          'a repo-change must invalidate the HEAD-keyed blame so it is re-read'
        );
        svc.dispose();
      });
    });
  });

  describe('getBlameForLine()', () => {
    describe('Single line blame', () => {
      it('should return blame info for specific line', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        const blameLine = await blameService.getBlameForLine(mockRepo, 'test.ts', 1);

        assert.strictEqual(blameLine.line, 1);
        assert.strictEqual(blameLine.commit, 'abc123def456789012345678901234567890abcd');
        assert.strictEqual(blameLine.author, 'John Doe');
        assert.strictEqual(blameLine.message, 'Initial commit');
      });

      it('should return blame info for different lines', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        // Get blame for line 1 (should exist)
        const blameLine1 = await blameService.getBlameForLine(mockRepo, 'test.ts', 1);

        assert.strictEqual(blameLine1.line, 1);
        assert.strictEqual(blameLine1.author, 'John Doe');
        assert.strictEqual(blameLine1.message, 'Initial commit');

        // Line 2 is the SAME commit as line 1 but its porcelain group carries
        // NO header block. It must still resolve to John Doe / "Initial commit"
        // from the per-sha metadata cache — not be mis-attributed.
        const blameLine2 = await blameService.getBlameForLine(mockRepo, 'test.ts', 2);
        assert.strictEqual(blameLine2.line, 2);
        assert.strictEqual(blameLine2.commit, 'abc123def456789012345678901234567890abcd');
        assert.strictEqual(blameLine2.author, 'John Doe');
        assert.strictEqual(blameLine2.message, 'Initial commit');
      });

      it('should return placeholder for non-existent line', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        const blameLine = await blameService.getBlameForLine(mockRepo, 'test.ts', 999);

        assert.strictEqual(blameLine.line, 999);
        assert.strictEqual(blameLine.author, 'Not Committed Yet');
        assert.strictEqual(blameLine.message, 'Uncommitted changes');
      });

      it('should use cached blame data', async () => {
        mockGitCli.setMockResultByPrefix('blame --porcelain', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        // First call
        await blameService.getBlameForLine(mockRepo, 'test.ts', 1);
        const commandCount1 = mockGitCli.executedCommands.length;

        // Second call for different line should use cache
        await blameService.getBlameForLine(mockRepo, 'test.ts', 2);
        const commandCount2 = mockGitCli.executedCommands.length;

        assert.strictEqual(commandCount1, commandCount2, 'Should use cached blame data');
      });
    });
  });

  describe('getPreviousRevisionBlame()', () => {
    describe('Navigate to previous revision', () => {
      it('should get parent commit and blame at that revision', async () => {
        // Mock rev-parse to get parent commit
        mockGitCli.setMockResult('rev-parse --end-of-options abc123^', {
          exitCode: 0,
          stdout: 'parent123\n',
          stderr: '',
        });

        // Mock cat-file to check file exists
        mockGitCli.setMockResult('cat-file -e --end-of-options parent123:test.ts', {
          exitCode: 0,
          stdout: '',
          stderr: '',
        });

        // Mock blame at parent revision
        mockGitCli.setMockResultByPrefix('blame --porcelain --end-of-options parent123', {
          exitCode: 0,
          stdout: sampleBlameOutput,
          stderr: '',
        });

        const blameInfo = await blameService.getPreviousRevisionBlame(
          mockRepo,
          'test.ts',
          'abc123'
        );

        assert.strictEqual(blameInfo.path, 'test.ts');
        assert.ok(blameInfo.lines.length > 0, 'Should have blame lines');
      });

      it('should return empty blame when no parent commit exists', async () => {
        // Mock rev-parse to fail (no parent)
        mockGitCli.setMockResult('rev-parse --end-of-options abc123^', {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: ambiguous argument',
        });

        const blameInfo = await blameService.getPreviousRevisionBlame(
          mockRepo,
          'test.ts',
          'abc123'
        );

        assert.strictEqual(blameInfo.path, 'test.ts');
        assert.deepStrictEqual(blameInfo.lines, []);
      });

      it('should return empty blame when file did not exist at parent', async () => {
        // Mock rev-parse to get parent commit
        mockGitCli.setMockResult('rev-parse --end-of-options abc123^', {
          exitCode: 0,
          stdout: 'parent123\n',
          stderr: '',
        });

        // Mock cat-file to indicate file doesn't exist
        mockGitCli.setMockResult('cat-file -e --end-of-options parent123:test.ts', {
          exitCode: 128,
          stdout: '',
          stderr: 'fatal: Not a valid object name',
        });

        const blameInfo = await blameService.getPreviousRevisionBlame(
          mockRepo,
          'test.ts',
          'abc123'
        );

        assert.strictEqual(blameInfo.path, 'test.ts');
        assert.deepStrictEqual(blameInfo.lines, []);
      });
    });
  });

  describe('Event handling', () => {
    it('should fire onDidChangeBlame event when blame is fetched', async () => {
      mockGitCli.setMockResultByPrefix('blame --porcelain', {
        exitCode: 0,
        stdout: sampleBlameOutput,
        stderr: '',
      });

      let eventFired = false;
      let eventPath = '';

      const disposable = blameService.onDidChangeBlame((event) => {
        eventFired = true;
        eventPath = event.path;
      });

      await blameService.getBlame(mockRepo, 'test.ts');

      assert.ok(eventFired, 'Event should have been fired');
      assert.strictEqual(eventPath, 'test.ts');

      disposable.dispose();
    });
  });

  describe('dispose()', () => {
    it('should dispose without errors', () => {
      assert.doesNotThrow(() => {
        blameService.dispose();
      });
    });

    it('Wave I WI-C: blameWatcher-1 — single repo registers exactly one RelativePattern watcher (not `**/*` global)', async () => {
      // Verify the per-repo path. We provide a gitService with a single
      // repo; BlameService must register a watcher with a RelativePattern
      // rooted at that repo's path, not the legacy workspace-wide
      // `**/*` glob.
      const { createMockGitService, attachedRepo } = await import('../../mocks/mockGitService');
      const { getCreatedFileSystemWatchers, RelativePattern } = await import('../../mocks/vscode');

      const repo = attachedRepo();
      const gs = createMockGitService(repo);
      const watcherCountBefore = getCreatedFileSystemWatchers().length;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const svc = new BlameService(mockGitCli as any, gs);

      const newWatchers = getCreatedFileSystemWatchers().slice(watcherCountBefore);
      assert.strictEqual(newWatchers.length, 1, 'expected exactly one watcher per repo');
      const pattern = (newWatchers[0] as { _pattern: unknown })._pattern;
      assert.ok(
        pattern instanceof RelativePattern,
        `expected RelativePattern, got ${typeof pattern}: ${JSON.stringify(pattern)}`
      );
      assert.strictEqual(
        (pattern as { base: string }).base,
        repo.rootUri.fsPath,
        'watcher must be rooted at repo path'
      );

      svc.dispose();
    });

    it('Wave I WI-C: blameWatcher-2 — multi-repo add/remove syncs the watcher map', async () => {
      const { createMockGitService, attachedRepo } = await import('../../mocks/mockGitService');
      const { getCreatedFileSystemWatchers } = await import('../../mocks/vscode');

      // Start with one repo.
      const repoA = attachedRepo('main', 'a'.repeat(40));
      const repoB: typeof repoA = {
        ...attachedRepo('main', 'b'.repeat(40)),
        rootUri: { fsPath: '/test/repoB', scheme: 'file' } as typeof repoA.rootUri,
      };

      // gitService initially knows only repoA.
      let repos = [repoA];
      const gs = createMockGitService(repoA, {
        getRepositories: () => repos,
      });

      const watcherCountBefore = getCreatedFileSystemWatchers().length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const svc = new BlameService(mockGitCli as any, gs);

      // After construction: one watcher (for repoA).
      let newWatchers = getCreatedFileSystemWatchers().slice(watcherCountBefore);
      assert.strictEqual(newWatchers.length, 1, 'one repo → one watcher');

      // Add repoB and fire onDidChangeRepository.
      repos = [repoA, repoB];
      gs.fireChangeRepository(repoB);

      newWatchers = getCreatedFileSystemWatchers().slice(watcherCountBefore);
      assert.strictEqual(newWatchers.length, 2, 'two repos → two watchers');

      svc.dispose();
    });

    it('should clear cache on dispose', async () => {
      mockGitCli.setMockResultByPrefix('blame --porcelain', {
        exitCode: 0,
        stdout: sampleBlameOutput,
        stderr: '',
      });

      // Populate cache
      await blameService.getBlame(mockRepo, 'test.ts');

      // Dispose
      blameService.dispose();

      // Create new service and verify cache is empty
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const newService = new BlameService(mockGitCli as any);
      mockGitCli.clearCommands();

      await newService.getBlame(mockRepo, 'test.ts');

      // Should have executed command (cache was cleared)
      assert.ok(mockGitCli.executedCommands.length > 0, 'Should execute command after dispose');

      newService.dispose();
    });
  });

  // =========================================================================
  // -w / -M / -C flag forwarding + annotate-previous routing +
  // previous-filename capture when -M/-C active.
  // =========================================================================
  describe('blame options', () => {
    beforeEach(() => {
      mockGitCli.setMockResultByPrefix('blame', {
        exitCode: 0,
        stdout: sampleBlameOutput,
        stderr: '',
      });
    });

    it('passes -w when ignoreWhitespace=true', async () => {
      await blameService.getBlame(mockRepo, 'test.ts', undefined, {
        ignoreWhitespace: true,
      });
      const cmd = mockGitCli.findCommand('blame');
      assert.ok(cmd, 'blame command should have been executed');
      assert.ok(cmd.args.includes('-w'), `expected -w in argv, got: ${cmd.args.join(' ')}`);
    });

    it('passes -M when detectMovementsWithinFile=true', async () => {
      await blameService.getBlame(mockRepo, 'test.ts', undefined, {
        detectMovementsWithinFile: true,
      });
      const cmd = mockGitCli.findCommand('blame');
      assert.ok(cmd);
      assert.ok(cmd.args.includes('-M'), `expected -M in argv, got: ${cmd.args.join(' ')}`);
    });

    it('passes -C -C when detectMovementsAcrossFiles=true (thorough mode)', async () => {
      await blameService.getBlame(mockRepo, 'test.ts', undefined, {
        detectMovementsAcrossFiles: true,
      });
      const cmd = mockGitCli.findCommand('blame');
      assert.ok(cmd);
      const cCount = cmd.args.filter((a) => a === '-C').length;
      assert.strictEqual(cCount, 2, `expected -C twice, got ${cCount}: ${cmd.args.join(' ')}`);
    });

    it('combines -w, -M, -C when all flags set', async () => {
      await blameService.getBlame(mockRepo, 'test.ts', undefined, {
        ignoreWhitespace: true,
        detectMovementsWithinFile: true,
        detectMovementsAcrossFiles: true,
      });
      const cmd = mockGitCli.findCommand('blame');
      assert.ok(cmd);
      assert.ok(cmd.args.includes('-w'));
      assert.ok(cmd.args.includes('-M'));
      assert.strictEqual(
        cmd.args.filter((a) => a === '-C').length,
        2,
        'expected -C twice for across-files'
      );
    });

    it('omits flags when options are undefined (default behavior unchanged)', async () => {
      await blameService.getBlame(mockRepo, 'test.ts');
      const cmd = mockGitCli.findCommand('blame');
      assert.ok(cmd);
      assert.ok(!cmd.args.includes('-w'));
      assert.ok(!cmd.args.includes('-M'));
      assert.ok(!cmd.args.includes('-C'));
    });

    it('keeps separate cache entries per flag combination', async () => {
      // Fire two requests with different flags. Both should hit git.
      await blameService.getBlame(mockRepo, 'test.ts', undefined, { ignoreWhitespace: true });
      await blameService.getBlame(mockRepo, 'test.ts', undefined, { ignoreWhitespace: false });
      const blameCmds = mockGitCli.executedCommands.filter((c) => c.args[0] === 'blame');
      assert.ok(
        blameCmds.length >= 2,
        `expected 2 blame calls for 2 flag sets, got ${blameCmds.length}`
      );
    });

    it('annotate-previous: getPreviousRevisionBlame uses <sha>^ via rev-parse + passes options', async () => {
      mockGitCli.setMockResult('rev-parse --end-of-options abc123^', {
        exitCode: 0,
        stdout: 'def456\n',
        stderr: '',
      });
      mockGitCli.setMockResult('cat-file -e --end-of-options def456:test.ts', {
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      mockGitCli.clearCommands();

      await blameService.getPreviousRevisionBlame(mockRepo, 'test.ts', 'abc123', {
        ignoreWhitespace: true,
      });

      const blameAtParent = mockGitCli.executedCommands.find(
        (c) => c.args[0] === 'blame' && c.args.includes('def456')
      );
      assert.ok(blameAtParent, 'expected blame against parent commit');
      assert.ok(
        blameAtParent.args.includes('-w'),
        `expected -w forwarded to parent blame: ${blameAtParent.args.join(' ')}`
      );
    });

    it('parser captures previousFilename header when -M/-C reported a rename', async () => {
      const withRename = `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1609459200
summary Rename file
previous bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb old/location.ts
filename new/location.ts
\tconst x = 1;
`;
      mockGitCli.setMockResultByPrefix('blame', {
        exitCode: 0,
        stdout: withRename,
        stderr: '',
      });

      const info = await blameService.getBlame(mockRepo, 'new/location.ts');
      assert.strictEqual(info.lines.length, 1);
      assert.strictEqual(info.lines[0].previousCommit, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      assert.strictEqual(info.lines[0].previousFilename, 'old/location.ts');
    });
  });

  // =========================================================================
  // Live-buffer blame: when the editor has unsaved edits, blame must run
  // against the in-memory buffer (`git blame --contents -`, buffer on stdin)
  // so blame line numbers align with the editor and new/edited lines come
  // back uncommitted instead of inheriting the on-disk line's blame.
  // =========================================================================
  describe('live-buffer blame (--contents)', () => {
    it('passes --contents - and pipes the buffer on stdin when contents given', async () => {
      mockGitCli.setMockResultByPrefix('blame', {
        exitCode: 0,
        stdout: sampleBlameOutput,
        stderr: '',
      });

      const buffer = 'const x = 1;\nconst NEW = 0;\nconst y = 2;\n';
      await blameService.getBlame(mockRepo, 'test.ts', undefined, undefined, buffer);

      const cmd = mockGitCli.findCommand('blame');
      assert.ok(cmd, 'blame command should have been executed');
      const i = cmd.args.indexOf('--contents');
      assert.ok(i >= 0, `expected --contents in argv, got: ${cmd.args.join(' ')}`);
      assert.strictEqual(cmd.args[i + 1], '-', '--contents must be followed by - (stdin)');
      assert.strictEqual(
        (cmd.options as { input?: string }).input,
        buffer,
        'the live buffer must be piped to git stdin'
      );
    });

    it('bypasses the cache for live-buffer blame (re-runs every call)', async () => {
      mockGitCli.setMockResultByPrefix('blame', {
        exitCode: 0,
        stdout: sampleBlameOutput,
        stderr: '',
      });

      await blameService.getBlame(mockRepo, 'test.ts', undefined, undefined, 'v1\n');
      const after1 = mockGitCli.executedCommands.filter((c) => c.args[0] === 'blame').length;
      // A subsequent live-buffer blame (content changed) must NOT be served from
      // cache — its result depends on the buffer, which changes per keystroke.
      await blameService.getBlame(mockRepo, 'test.ts', undefined, undefined, 'v2\n');
      const after2 = mockGitCli.executedCommands.filter((c) => c.args[0] === 'blame').length;
      assert.strictEqual(after2, after1 + 1, 'live-buffer blame must not be cached');
    });

    it('does not poison the on-disk cache (saved blame still served from cache)', async () => {
      mockGitCli.setMockResultByPrefix('blame', {
        exitCode: 0,
        stdout: sampleBlameOutput,
        stderr: '',
      });

      // A live-buffer read first…
      await blameService.getBlame(mockRepo, 'test.ts', undefined, undefined, 'dirty\n');
      // …then the normal (saved) read populates the cache.
      await blameService.getBlame(mockRepo, 'test.ts');
      const afterSeed = mockGitCli.executedCommands.filter((c) => c.args[0] === 'blame').length;
      // The second saved read hits the cache (no new exec).
      await blameService.getBlame(mockRepo, 'test.ts');
      const afterCached = mockGitCli.executedCommands.filter((c) => c.args[0] === 'blame').length;
      assert.strictEqual(afterCached, afterSeed, 'saved blame must still be cached');
    });

    it('omits --contents for the normal (saved) path', async () => {
      mockGitCli.setMockResultByPrefix('blame', {
        exitCode: 0,
        stdout: sampleBlameOutput,
        stderr: '',
      });
      await blameService.getBlame(mockRepo, 'test.ts');
      const cmd = mockGitCli.findCommand('blame');
      assert.ok(cmd);
      assert.ok(!cmd.args.includes('--contents'), 'saved path must not pass --contents');
    });
  });

  describe('invalidateCache (file-change watcher) precision', () => {
    it('invalidating a file does not drop a sibling whose path shares its prefix', () => {
      const svc = blameService as unknown as {
        getCacheKey: (root: string, path: string) => string;
        _blameCache: Map<string, { blame: { path: string; lines: [] }; timestamp: number }>;
        invalidateCache: (filePath: string) => void;
      };
      const root = '/test/repo';
      const keyFoo = svc.getCacheKey(root, '/test/repo/foo');
      const keyFooBar = svc.getCacheKey(root, '/test/repo/foobar');
      const entry = (p: string): { blame: { path: string; lines: [] }; timestamp: number } => ({
        blame: { path: p, lines: [] },
        timestamp: Date.now(),
      });
      svc._blameCache.set(keyFoo, entry('/test/repo/foo'));
      svc._blameCache.set(keyFooBar, entry('/test/repo/foobar'));

      // A change to `/test/repo/foo` must invalidate only that file, not the
      // sibling `/test/repo/foobar` whose path merely shares the prefix.
      svc.invalidateCache('/test/repo/foo');

      assert.ok(!svc._blameCache.has(keyFoo), "the changed file's blame must be invalidated");
      assert.ok(
        svc._blameCache.has(keyFooBar),
        'a sibling sharing a path prefix must NOT be invalidated'
      );
    });
  });
});
