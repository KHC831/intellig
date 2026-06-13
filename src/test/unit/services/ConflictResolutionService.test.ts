import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConflictResolutionService } from '../../../conflicts/ConflictResolutionService';
import { IGitService, IRepository, IFileStatus } from '../../../git-core/interfaces/IGitService';
import { IGitCommandResult } from '../../../git-core/gitCli';

/**
 * Unit tests for ConflictResolutionService
 */
describe('ConflictResolutionService', () => {
  let conflictService: ConflictResolutionService;
  let mockGitService: Partial<IGitService>;
  let mockRepo: IRepository;
  let mockGitCli: { exec: (args: string[], options?: unknown) => Promise<IGitCommandResult> };
  let stagedFiles: string[];

  beforeEach(() => {
    stagedFiles = [];

    // Create mock Git CLI
    mockGitCli = {
      exec: (_args: string[], _options?: unknown): Promise<IGitCommandResult> => {
        // Mock checkout --ours/--theirs
        if (_args[0] === 'checkout' && (_args[1] === '--ours' || _args[1] === '--theirs')) {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
        }
        // Mock commit
        if (_args[0] === 'commit') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
        }
        // Mock rebase --continue
        if (_args[0] === 'rebase' && _args[1] === '--continue') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
        }
        // Mock merge/rebase --abort
        if ((_args[0] === 'merge' || _args[0] === 'rebase') && _args[1] === '--abort') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      },
    };

    // Create mock repository
    mockRepo = {
      rootUri: vscode.Uri.file('/mock/repo'),
      state: 'idle',
      remotes: [],
      submodules: [],
    };

    // Create mock Git service
    mockGitService = {
      getStatus: (): Promise<IFileStatus[]> => Promise.resolve([]),
      stage: (_repo: IRepository, paths: string[]): Promise<void> => {
        stagedFiles.push(...paths);
        return Promise.resolve();
      },
      onDidChangeRepository: new vscode.EventEmitter<IRepository>().event,
      gitCli: mockGitCli,
    } as unknown as Partial<IGitService>;

    conflictService = new ConflictResolutionService(mockGitService as IGitService);
  });

  afterEach(() => {
    conflictService.dispose();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      assert.ok(conflictService);
    });

    it('should have onDidChangeConflicts event', () => {
      assert.ok(conflictService.onDidChangeConflicts);
      assert.strictEqual(typeof conflictService.onDidChangeConflicts, 'function');
    });
  });

  describe('getConflictedFiles()', () => {
    it('should return empty array when no conflicts', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const conflicts = await conflictService.getConflictedFiles(mockRepo);
      assert.strictEqual(conflicts.length, 0);
    });

    it('should return conflicted files with U status in index', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
          { path: 'file2.txt', indexStatus: 'M', workTreeStatus: ' ' } as IFileStatus,
        ]);

      const conflicts = await conflictService.getConflictedFiles(mockRepo);
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].path, 'file1.txt');
      assert.strictEqual(conflicts[0].resolved, false);
    });

    it('should return conflicted files with U status in work tree', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'file1.txt', indexStatus: ' ', workTreeStatus: 'U' } as IFileStatus,
        ]);

      const conflicts = await conflictService.getConflictedFiles(mockRepo);
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].path, 'file1.txt');
    });

    it('should return multiple conflicted files', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'file1.txt', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
          { path: 'file2.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
          { path: 'file3.txt', indexStatus: ' ', workTreeStatus: 'U' } as IFileStatus,
        ]);

      const conflicts = await conflictService.getConflictedFiles(mockRepo);
      assert.strictEqual(conflicts.length, 3);
    });
  });

  describe('hasUnresolvedConflicts()', () => {
    it('should return false when no conflicts', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const hasConflicts = await conflictService.hasUnresolvedConflicts(mockRepo);
      assert.strictEqual(hasConflicts, false);
    });

    it('should return true when conflicts exist', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
        ]);

      const hasConflicts = await conflictService.hasUnresolvedConflicts(mockRepo);
      assert.strictEqual(hasConflicts, true);
    });
  });

  describe('markResolved()', () => {
    it('should stage the file to mark as resolved', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const result = await conflictService.markResolved(mockRepo, 'file1.txt');
      assert.strictEqual(result.success, true);
      assert.ok(stagedFiles.includes('file1.txt'));
    });

    it('should return error on failure', async () => {
      mockGitService.stage = (): Promise<void> => {
        return Promise.reject(new Error('Stage failed'));
      };

      const result = await conflictService.markResolved(mockRepo, 'file1.txt');
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('Stage failed'));
    });
  });

  describe('markMultipleResolved()', () => {
    it('should stage multiple files', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const result = await conflictService.markMultipleResolved(mockRepo, [
        'file1.txt',
        'file2.txt',
      ]);
      assert.strictEqual(result.success, true);
      assert.ok(stagedFiles.includes('file1.txt'));
      assert.ok(stagedFiles.includes('file2.txt'));
    });
  });

  describe('acceptCurrent()', () => {
    it('should checkout --ours and stage the file', async () => {
      let checkoutCalled = false;
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'checkout' && args[1] === '--ours') {
          checkoutCalled = true;
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const result = await conflictService.acceptCurrent(mockRepo, 'file1.txt');
      assert.strictEqual(result.success, true);
      assert.strictEqual(checkoutCalled, true);
      assert.ok(stagedFiles.includes('file1.txt'));
    });
  });

  describe('acceptIncoming()', () => {
    it('should checkout --theirs and stage the file', async () => {
      let checkoutCalled = false;
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'checkout' && args[1] === '--theirs') {
          checkoutCalled = true;
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const result = await conflictService.acceptIncoming(mockRepo, 'file1.txt');
      assert.strictEqual(result.success, true);
      assert.strictEqual(checkoutCalled, true);
      assert.ok(stagedFiles.includes('file1.txt'));
    });
  });

  describe('acceptAllCurrent()', () => {
    it('should accept current for all conflicted files', async () => {
      const checkedOutFiles: string[] = [];
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'checkout' && args[1] === '--ours') {
          checkedOutFiles.push(args[3]);
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };

      // First call returns conflicts, subsequent calls return empty (after resolution)
      let callCount = 0;
      mockGitService.getStatus = (): Promise<IFileStatus[]> => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([
            { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
            { path: 'file2.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
          ]);
        }
        return Promise.resolve([]);
      };

      const result = await conflictService.acceptAllCurrent(mockRepo);
      assert.strictEqual(result.success, true);
      assert.ok(checkedOutFiles.includes('file1.txt'));
      assert.ok(checkedOutFiles.includes('file2.txt'));
    });

    it('should succeed when no conflicts', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const result = await conflictService.acceptAllCurrent(mockRepo);
      assert.strictEqual(result.success, true);
    });
  });

  describe('acceptAllIncoming()', () => {
    it('should accept incoming for all conflicted files', async () => {
      const checkedOutFiles: string[] = [];
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'checkout' && args[1] === '--theirs') {
          checkedOutFiles.push(args[3]);
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };

      let callCount = 0;
      mockGitService.getStatus = (): Promise<IFileStatus[]> => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([
            { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
            { path: 'file2.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
          ]);
        }
        return Promise.resolve([]);
      };

      const result = await conflictService.acceptAllIncoming(mockRepo);
      assert.strictEqual(result.success, true);
      assert.ok(checkedOutFiles.includes('file1.txt'));
      assert.ok(checkedOutFiles.includes('file2.txt'));
    });
  });

  describe('canCompleteOperation()', () => {
    it('should return false when repository is idle', async () => {
      mockRepo.state = 'idle';
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const canComplete = await conflictService.canCompleteOperation(mockRepo);
      assert.strictEqual(canComplete, false);
    });

    it('should return false when conflicts exist', async () => {
      mockRepo.state = 'merging';
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
        ]);

      const canComplete = await conflictService.canCompleteOperation(mockRepo);
      assert.strictEqual(canComplete, false);
    });

    it('should return true when merging with no conflicts', async () => {
      mockRepo.state = 'merging';
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const canComplete = await conflictService.canCompleteOperation(mockRepo);
      assert.strictEqual(canComplete, true);
    });

    it('should return true when rebasing with no conflicts', async () => {
      mockRepo.state = 'rebasing';
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const canComplete = await conflictService.canCompleteOperation(mockRepo);
      assert.strictEqual(canComplete, true);
    });
  });

  describe('completeMerge()', () => {
    it('should complete merge when no conflicts', async () => {
      mockRepo.state = 'merging';
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      let commitCalled = false;
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'commit') {
          commitCalled = true;
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };

      const result = await conflictService.completeMerge(mockRepo);
      assert.strictEqual(result.success, true);
      assert.strictEqual(commitCalled, true);
    });

    it('should fail when conflicts remain', async () => {
      mockRepo.state = 'merging';
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
        ]);

      const result = await conflictService.completeMerge(mockRepo);
      assert.strictEqual(result.success, false);
      assert.ok(result.remainingConflicts?.includes('file1.txt'));
    });
  });

  describe('completeRebase()', () => {
    it('should continue rebase when no conflicts', async () => {
      mockRepo.state = 'rebasing';
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      let rebaseContinueCalled = false;
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'rebase' && args[1] === '--continue') {
          rebaseContinueCalled = true;
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };

      const result = await conflictService.completeRebase(mockRepo);
      assert.strictEqual(result.success, true);
      assert.strictEqual(rebaseContinueCalled, true);
    });

    it('should fail when conflicts remain', async () => {
      mockRepo.state = 'rebasing';
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
        ]);

      const result = await conflictService.completeRebase(mockRepo);
      assert.strictEqual(result.success, false);
      assert.ok(result.remainingConflicts?.includes('file1.txt'));
    });
  });

  describe('abortMerge()', () => {
    it('should abort merge', async () => {
      let abortCalled = false;
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'merge' && args[1] === '--abort') {
          abortCalled = true;
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const result = await conflictService.abortMerge(mockRepo);
      assert.strictEqual(result.success, true);
      assert.strictEqual(abortCalled, true);
    });
  });

  describe('abortRebase()', () => {
    it('should abort rebase', async () => {
      let abortCalled = false;
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'rebase' && args[1] === '--abort') {
          abortCalled = true;
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const result = await conflictService.abortRebase(mockRepo);
      assert.strictEqual(result.success, true);
      assert.strictEqual(abortCalled, true);
    });
  });

  describe('getRepositoryState()', () => {
    it('should return the repository state', () => {
      mockRepo.state = 'merging';
      const state = conflictService.getRepositoryState(mockRepo);
      assert.strictEqual(state, 'merging');
    });

    it('should return idle for normal state', () => {
      mockRepo.state = 'idle';
      const state = conflictService.getRepositoryState(mockRepo);
      assert.strictEqual(state, 'idle');
    });
  });

  describe('dispose()', () => {
    it('should dispose without error', () => {
      assert.doesNotThrow(() => conflictService.dispose());
    });

    it('should be safe to call multiple times', () => {
      conflictService.dispose();
      assert.doesNotThrow(() => conflictService.dispose());
    });
  });

  describe('per-repo conflicts-active state (multi-root)', () => {
    // regression: the aggregate `intellig.conflicts.active` context key
    // must reflect "any repo conflicted" across multiple roots. A single-bool
    // impl would let one repo's clean state stomp another repo's conflicted
    // state depending on watcher firing order.
    it('aggregate stays true while any repo still reports conflicts', async () => {
      const repoA: IRepository = {
        rootUri: vscode.Uri.file('/mock/repo-A'),
        state: 'idle',
        remotes: [],
        submodules: [],
      };
      const repoB: IRepository = {
        rootUri: vscode.Uri.file('/mock/repo-B'),
        state: 'idle',
        remotes: [],
        submodules: [],
      };

      // Mark repo A conflicted.
      await (
        conflictService as unknown as {
          _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
        }
      )._setConflictsActive(repoA, true);
      assert.strictEqual(conflictService.getConflictsActive(), true);
      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoA), true);
      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoB), false);

      // Mark repo B conflicted as well.
      await (
        conflictService as unknown as {
          _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
        }
      )._setConflictsActive(repoB, true);
      assert.strictEqual(conflictService.getConflictsActive(), true);

      // Clear repo B — aggregate should STAY true because repo A is still
      // conflicted. This is the bug the old single-bool impl hit.
      await (
        conflictService as unknown as {
          _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
        }
      )._setConflictsActive(repoB, false);
      assert.strictEqual(
        conflictService.getConflictsActive(),
        true,
        'aggregate must remain true while repo A still has conflicts'
      );
      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoA), true);
      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoB), false);

      // Clear repo A — now aggregate flips to false.
      await (
        conflictService as unknown as {
          _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
        }
      )._setConflictsActive(repoA, false);
      assert.strictEqual(conflictService.getConflictsActive(), false);
    });

    it('per-repo snapshot is independent for each root', async () => {
      const repoA: IRepository = {
        rootUri: vscode.Uri.file('/mock/repo-A'),
        state: 'idle',
        remotes: [],
        submodules: [],
      };
      const repoB: IRepository = {
        rootUri: vscode.Uri.file('/mock/repo-B'),
        state: 'idle',
        remotes: [],
        submodules: [],
      };

      await (
        conflictService as unknown as {
          _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
        }
      )._setConflictsActive(repoA, true);
      await (
        conflictService as unknown as {
          _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
        }
      )._setConflictsActive(repoB, false);

      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoA), true);
      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoB), false);
    });
  });
});
