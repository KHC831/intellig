import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync, errAsync } from 'neverthrow';
import { SpawnFailedError } from '../../../src/git-core/errors';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import {
  IGitService,
  IRepository,
  IFileStatus,
} from '../../../src/git-core/interfaces/IGitService';
import { IGitCommandResult } from '../../../src/git-core/gitCli';

/**
 * Synthesize `git ls-files -u -z [-- <path>]` stdout from porcelain statuses so a
 * mock `gitCli.exec` serves the accept path's index stage model: stage 2 present
 * unless ours is deleted (index 'D'), stage 3 present unless theirs is deleted
 * (work-tree 'D'). Returns null for any other command so callers fall through.
 */
function lsFilesUnmerged(args: string[], status: IFileStatus[]): string | null {
  if (args[0] !== 'ls-files' || !args.includes('-u')) {
    return null;
  }
  const dashDash = args.indexOf('--');
  const only = dashDash >= 0 ? args[dashDash + 1] : undefined;
  let out = '';
  for (const f of status) {
    if (only !== undefined && f.path !== only) {
      continue;
    }
    if (f.indexStatus !== 'D') {
      out += `100644 ${'2'.repeat(40)} 2\t${f.path}\0`;
    }
    if (f.workTreeStatus !== 'D') {
      out += `100644 ${'3'.repeat(40)} 3\t${f.path}\0`;
    }
  }
  return out;
}

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

    // Create mock repository. Default to 'merging' — a forward (non-reversed)
    // conflict. An 'idle' repo with unmerged files is the external stash-pop/
    // apply case, which the service now treats as reversed (see inferReopenOperation),
    // so tests that want the non-reversed --ours/--theirs mapping use 'merging'.
    mockRepo = {
      rootUri: vscode.Uri.file('/mock/repo'),
      state: 'merging',
      remotes: [],
      submodules: [],
    };

    // Create mock Git service
    mockGitService = {
      getStatus: (): Promise<IFileStatus[]> => Promise.resolve([]),
      stage: (_repo: IRepository, paths: string[]) => {
        stagedFiles.push(...paths);
        return okAsync(undefined);
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

    it('should detect both-added (AA) conflicts that carry no U column', async () => {
      // AA (add/add) is an unmerged path but neither column is `U`; a
      // U-only filter misses it. git leaves this after an autostash re-apply
      // collides on a newly added path while still exiting 0.
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'added.txt', indexStatus: 'A', workTreeStatus: 'A' } as IFileStatus,
          { path: 'clean.txt', indexStatus: 'M', workTreeStatus: ' ' } as IFileStatus,
        ]);

      const conflicts = await conflictService.getConflictedFiles(mockRepo);
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].path, 'added.txt');
    });

    it('should detect both-deleted (DD) conflicts that carry no U column', async () => {
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'gone.txt', indexStatus: 'D', workTreeStatus: 'D' } as IFileStatus,
        ]);

      const conflicts = await conflictService.getConflictedFiles(mockRepo);
      assert.strictEqual(conflicts.length, 1);
      assert.strictEqual(conflicts[0].path, 'gone.txt');
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
      mockGitService.stage = () => errAsync(new SpawnFailedError('Stage failed'));

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

  describe('accept ours/theirs — delete/modify conflicts (P1: git rm, not checkout)', () => {
    function recordExec(): string[][] {
      const calls: string[][] = [];
      mockGitCli.exec = async (args: string[]): Promise<IGitCommandResult> => {
        calls.push(args);
        const ls = lsFilesUnmerged(args, await mockGitService.getStatus!(mockRepo));
        const stdout = ls ?? '';
        return { exitCode: 0, stdout, stderr: '', combined: stdout };
      };
      return calls;
    }

    it('acceptCurrent on an ours-deleted file (DU) runs git rm, not checkout --ours', async () => {
      const calls = recordExec();
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'gone.txt', indexStatus: 'D', workTreeStatus: 'U' } as IFileStatus,
        ]);

      const result = await conflictService.acceptCurrent(mockRepo, 'gone.txt');
      assert.strictEqual(result.success, true);
      assert.ok(
        calls.some((a) => a[0] === 'rm' && a[2] === 'gone.txt'),
        'ours-deleted file must be resolved with git rm'
      );
      assert.ok(
        !calls.some((a) => a[0] === 'checkout'),
        'must not checkout an ours-side blob that does not exist'
      );
    });

    it('acceptIncoming on a theirs-deleted file (UD) runs git rm, not checkout --theirs', async () => {
      const calls = recordExec();
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'gone.txt', indexStatus: 'U', workTreeStatus: 'D' } as IFileStatus,
        ]);

      const result = await conflictService.acceptIncoming(mockRepo, 'gone.txt');
      assert.strictEqual(result.success, true);
      assert.ok(
        calls.some((a) => a[0] === 'rm' && a[2] === 'gone.txt'),
        'theirs-deleted file must be resolved with git rm'
      );
      assert.ok(
        !calls.some((a) => a[0] === 'checkout'),
        'must not checkout a theirs-side blob that does not exist'
      );
    });

    it('acceptIncoming on a both-modified file (UU) still uses checkout --theirs', async () => {
      const calls = recordExec();
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'both.txt', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
        ]);

      const result = await conflictService.acceptIncoming(mockRepo, 'both.txt');
      assert.strictEqual(result.success, true);
      assert.ok(calls.some((a) => a[0] === 'checkout' && a[1] === '--theirs'));
      assert.ok(!calls.some((a) => a[0] === 'rm'));
    });

    it('acceptAllCurrent rm-s ours-deleted files and checks out the rest', async () => {
      const calls = recordExec();
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'gone.txt', indexStatus: 'D', workTreeStatus: 'U' } as IFileStatus,
          { path: 'both.txt', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
        ]);

      const result = await conflictService.acceptAllCurrent(mockRepo);
      assert.strictEqual(result.success, true);
      assert.ok(calls.some((a) => a[0] === 'rm' && a[2] === 'gone.txt'));
      assert.ok(calls.some((a) => a[0] === 'checkout' && a[1] === '--ours' && a[3] === 'both.txt'));
      assert.deepStrictEqual(stagedFiles, ['both.txt'], 'only the checked-out file is staged');
    });

    it('acceptAllIncoming rm-s theirs-deleted files and checks out the rest', async () => {
      const calls = recordExec();
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'gone.txt', indexStatus: 'U', workTreeStatus: 'D' } as IFileStatus,
          { path: 'both.txt', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
        ]);

      const result = await conflictService.acceptAllIncoming(mockRepo);
      assert.strictEqual(result.success, true);
      assert.ok(calls.some((a) => a[0] === 'rm' && a[2] === 'gone.txt'));
      assert.ok(
        calls.some((a) => a[0] === 'checkout' && a[1] === '--theirs' && a[3] === 'both.txt')
      );
      assert.deepStrictEqual(stagedFiles, ['both.txt'], 'only the checked-out file is staged');
    });

    it('drops a concurrent second bulk accept-all on the same repo (no interleaved batch)', async () => {
      const calls = recordExec();
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'both.txt', indexStatus: 'U', workTreeStatus: 'U' } as IFileStatus,
        ]);

      // Fire two bulk runs without awaiting the first; the per-repo guard must
      // drop the second so it can't checkout a path the first already resolved.
      const [r1, r2] = await Promise.all([
        conflictService.acceptAllCurrent(mockRepo),
        conflictService.acceptAllCurrent(mockRepo),
      ]);
      assert.strictEqual(r1.success, true);
      // The dropped second call is a benign no-op: not success (the in-flight
      // batch may take the other side), not an error to toast — marked skipped.
      assert.strictEqual(r2.success, false);
      assert.strictEqual(r2.skipped, true);
      assert.strictEqual(r2.error, undefined);

      const checkouts = calls.filter((a) => a[0] === 'checkout' && a[3] === 'both.txt');
      assert.strictEqual(
        checkouts.length,
        1,
        'only one batch runs; the concurrent second invocation is dropped'
      );
    });
  });

  describe('abortWorkingTreeConflicts()', () => {
    /**
     * Model `git`'s real behavior for the restore-to-HEAD writer: `cat-file -e
     * HEAD:<path>` reports membership; `checkout HEAD -- <paths>` fatals (exit
     * 128) when any requested path is absent from HEAD, and throws when the
     * caller passed `throwOnError` (as the writer does). `failCheckout` forces
     * a genuine restore failure for a HEAD-tracked path.
     */
    function scriptGit(
      inHead: Set<string>,
      calls: string[][],
      opts: { failCheckout?: boolean } = {}
    ): (args: string[], options?: unknown) => Promise<IGitCommandResult> {
      return (args: string[], options?: unknown): Promise<IGitCommandResult> => {
        calls.push(args);
        const throwOnError = Boolean((options as { throwOnError?: boolean })?.throwOnError);
        if (args[0] === 'cat-file' && args[1] === '-e') {
          const spec = args[2].replace(/^HEAD:/, '');
          return Promise.resolve({
            exitCode: inHead.has(spec) ? 0 : 1,
            stdout: '',
            stderr: '',
            combined: '',
          });
        }
        if (args[0] === 'checkout' && args[1] === 'HEAD') {
          const paths = args.slice(args.indexOf('--') + 1);
          const missing = paths.find((p) => !inHead.has(p));
          if (missing || opts.failCheckout) {
            const stderr = missing
              ? `error: pathspec '${missing}' did not match any file(s) known to git`
              : 'error: unable to checkout';
            if (throwOnError) {
              return Promise.reject(new Error(stderr));
            }
            return Promise.resolve({ exitCode: 128, stdout: '', stderr, combined: stderr });
          }
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };
    }

    it('restores an add/add path (absent from HEAD) by unindexing, not a fatal checkout', async () => {
      const calls: string[][] = [];
      mockGitCli.exec = scriptGit(new Set(['tracked.ts']), calls);
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const res = await conflictService.abortWorkingTreeConflicts(mockRepo, [
        'tracked.ts',
        'addadd.ts',
      ]);
      assert.strictEqual(res.success, true, 'abort must succeed even with a both-added path');

      const checkout = calls.find((c) => c[0] === 'checkout' && c[1] === 'HEAD');
      assert.ok(checkout, 'expected a checkout HEAD for the tracked path');
      const checkoutPaths = checkout.slice(checkout.indexOf('--') + 1);
      assert.deepStrictEqual(checkoutPaths, ['tracked.ts'], 'only the HEAD path is checked out');

      const unindex = calls.find((c) => c[0] === 'rm' && c.includes('--cached'));
      assert.ok(unindex, 'the add/add path must be unindexed');
      assert.ok(unindex.includes('addadd.ts'), 'unindex targets the add/add path');
      // git4idea GitRollbackEnvironment.rollbackChanges unversions (keeps on disk)
      // a NEW file — no working-tree delete for an added-only path.
      assert.ok(!calls.some((c) => c[0] === 'rm' && !c.includes('--cached')));
    });

    it('checks out HEAD for tracked-only paths (behavior preserved)', async () => {
      const calls: string[][] = [];
      mockGitCli.exec = scriptGit(new Set(['a.ts', 'b.ts']), calls);
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      const res = await conflictService.abortWorkingTreeConflicts(mockRepo, ['a.ts', 'b.ts']);
      assert.strictEqual(res.success, true);
      const checkout = calls.find((c) => c[0] === 'checkout' && c[1] === 'HEAD');
      assert.ok(checkout, 'expected a checkout HEAD call');
      const checkoutPaths = checkout.slice(checkout.indexOf('--') + 1);
      assert.deepStrictEqual(checkoutPaths.sort(), ['a.ts', 'b.ts']);
      assert.ok(!calls.some((c) => c[0] === 'rm' && c.includes('--cached')));
    });

    it('maps a writer failure to {success:false} and fires no conflicts-changed event', async () => {
      const calls: string[][] = [];
      mockGitCli.exec = scriptGit(new Set(['x.ts']), calls, { failCheckout: true });
      let fired = false;
      const sub = conflictService.onDidChangeConflicts(() => {
        fired = true;
      });

      const res = await conflictService.abortWorkingTreeConflicts(mockRepo, ['x.ts']);
      sub.dispose();
      assert.strictEqual(res.success, false);
      assert.ok(res.error && /Failed to abort/.test(res.error));
      assert.strictEqual(fired, false, 'must not fire a conflicts-changed event on failure');
    });

    it('is a no-op success for an empty path list (never runs a bare checkout)', async () => {
      const calls: string[][] = [];
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        calls.push(args);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };
      const res = await conflictService.abortWorkingTreeConflicts(mockRepo, []);
      assert.strictEqual(res.success, true);
      assert.strictEqual(calls.length, 0, 'must not run git for zero paths');
    });
  });

  describe('acceptAllCurrent()', () => {
    it('should accept current for all conflicted files', async () => {
      const checkedOutFiles: string[] = [];
      const conflicted: IFileStatus[] = [
        { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
        { path: 'file2.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
      ];
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'checkout' && args[1] === '--ours') {
          checkedOutFiles.push(args[3]);
        }
        const ls = lsFilesUnmerged(args, conflicted);
        const stdout = ls ?? '';
        return Promise.resolve({ exitCode: 0, stdout, stderr: '', combined: stdout });
      };
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

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
      const conflicted: IFileStatus[] = [
        { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
        { path: 'file2.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
      ];
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'checkout' && args[1] === '--theirs') {
          checkedOutFiles.push(args[3]);
        }
        const ls = lsFilesUnmerged(args, conflicted);
        const stdout = ls ?? '';
        return Promise.resolve({ exitCode: 0, stdout, stderr: '', combined: stdout });
      };
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

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
    it('finishes the merge with `git merge --continue` (no cached-state guard)', async () => {
      // repo.state deliberately 'idle' — completeMerge must not guard on it; git
      // self-guards live off MERGE_HEAD. (Real-git coverage: completeMergeRealGit.)
      mockRepo.state = 'idle';
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      let mergeContinueCalled = false;
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'merge' && args[1] === '--continue') {
          mergeContinueCalled = true;
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };

      const result = await conflictService.completeMerge(mockRepo);
      assert.strictEqual(result.success, true);
      assert.strictEqual(mergeContinueCalled, true);
    });

    it("surfaces git's error when merge --continue fails (e.g. unmerged files)", async () => {
      mockRepo.state = 'merging';
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'merge' && args[1] === '--continue') {
          return Promise.resolve({
            exitCode: 1,
            stdout: '',
            stderr: 'Committing is not possible because you have unmerged files.',
            combined: '',
          });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };

      const result = await conflictService.completeMerge(mockRepo);
      assert.strictEqual(result.success, false);
      assert.ok(result.error?.includes('unmerged files'), result.error);
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

    it('reports remaining conflicts when rebase --continue pauses on the next commit', async () => {
      mockRepo.state = 'rebasing';
      mockGitService.getStatus = (): Promise<IFileStatus[]> =>
        Promise.resolve([
          { path: 'file1.txt', indexStatus: 'U', workTreeStatus: ' ' } as IFileStatus,
        ]);
      // git rebase --continue exits non-zero and leaves unmerged files when the
      // next replayed commit conflicts; completeRebase surfaces those.
      mockGitCli.exec = (args: string[]): Promise<IGitCommandResult> => {
        if (args[0] === 'rebase' && args[1] === '--continue') {
          return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'conflict', combined: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };

      const result = await conflictService.completeRebase(mockRepo);
      assert.strictEqual(result.success, false);
      assert.ok(result.remainingConflicts?.includes('file1.txt'));
    });

    it('passes GIT_EDITOR=true to rebase --continue so the non-TTY host never hangs on the editor', async () => {
      // After resolving a `pick`'s conflicts, `git rebase --continue` opens the
      // editor to confirm the commit message. Under VS Code's non-TTY spawn that
      // hangs forever (timeout 0). Suppress it the same way the dialog/merge path
      // does: GIT_EDITOR=true commits the prepared message verbatim.
      mockRepo.state = 'rebasing';
      mockGitService.getStatus = (): Promise<IFileStatus[]> => Promise.resolve([]);

      let continueEnv: Record<string, string> | undefined;
      mockGitCli.exec = (args: string[], options?: unknown): Promise<IGitCommandResult> => {
        if (args[0] === 'rebase' && args[1] === '--continue') {
          continueEnv = (options as { env?: Record<string, string> } | undefined)?.env;
        }
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', combined: '' });
      };

      const result = await conflictService.completeRebase(mockRepo);
      assert.strictEqual(result.success, true);
      assert.strictEqual(
        continueEnv?.GIT_EDITOR,
        'true',
        'rebase --continue must run with GIT_EDITOR=true'
      );
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
          _coordinator: {
            _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
          };
        }
      )._coordinator._setConflictsActive(repoA, true);
      assert.strictEqual(conflictService.getConflictsActive(), true);
      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoA), true);
      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoB), false);

      // Mark repo B conflicted as well.
      await (
        conflictService as unknown as {
          _coordinator: {
            _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
          };
        }
      )._coordinator._setConflictsActive(repoB, true);
      assert.strictEqual(conflictService.getConflictsActive(), true);

      // Clear repo B — aggregate should STAY true because repo A is still
      // conflicted. A single-bool implementation would incorrectly flip it
      // to false here.
      await (
        conflictService as unknown as {
          _coordinator: {
            _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
          };
        }
      )._coordinator._setConflictsActive(repoB, false);
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
          _coordinator: {
            _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
          };
        }
      )._coordinator._setConflictsActive(repoA, false);
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
          _coordinator: {
            _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
          };
        }
      )._coordinator._setConflictsActive(repoA, true);
      await (
        conflictService as unknown as {
          _coordinator: {
            _setConflictsActive: (repo: IRepository, active: boolean) => Promise<void>;
          };
        }
      )._coordinator._setConflictsActive(repoB, false);

      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoA), true);
      assert.strictEqual(conflictService.getConflictsActiveForRepo(repoB), false);
    });
  });
});
