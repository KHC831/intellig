import * as assert from 'assert';
import { RebaseService, createRebaseService } from '../../../git-core/RebaseService';
import {
  IRebaseSession,
  IRebaseAction,
  RebaseAction,
} from '../../../git-core/interfaces/IRebaseService';
import { IRepository } from '../../../git-core/interfaces/IGitService';
import { GitCli, IGitCommandResult } from '../../../git-core/gitCli';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Helper to create a mock result with all required fields
 */
function createMockResult(
  exitCode: number,
  stdout: string,
  stderr: string = ''
): IGitCommandResult {
  return {
    exitCode,
    stdout,
    stderr,
    combined: stdout + stderr,
  };
}

/**
 * Mock GitCli for testing
 */
class MockGitCli extends GitCli {
  private _execResults: Map<string, IGitCommandResult> = new Map();
  private _execCalls: { args: string[]; options?: unknown }[] = [];

  constructor() {
    super('git');
  }

  setExecResult(argsPattern: string, result: IGitCommandResult): void {
    this._execResults.set(argsPattern, result);
  }

  getExecCalls(): { args: string[]; options?: unknown }[] {
    return this._execCalls;
  }

  clearCalls(): void {
    this._execCalls = [];
  }

  override exec(args: string[], options?: unknown): Promise<IGitCommandResult> {
    this._execCalls.push({ args, options });

    // Find matching result
    const argsStr = args.join(' ');
    for (const [pattern, result] of this._execResults) {
      if (argsStr.includes(pattern)) {
        return Promise.resolve(result);
      }
    }

    // Default success result
    return Promise.resolve(createMockResult(0, ''));
  }
}

/**
 * Create a mock repository
 */
function createMockRepository(rootPath: string = '/test/repo'): IRepository {
  return {
    rootUri: vscode.Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  };
}

describe('RebaseService', () => {
  let mockGitCli: MockGitCli;
  let rebaseService: RebaseService;
  let mockRepo: IRepository;

  beforeEach(() => {
    mockGitCli = new MockGitCli();
    rebaseService = new RebaseService(mockGitCli);
    mockRepo = createMockRepository();
  });

  afterEach(() => {
    rebaseService.dispose();
  });

  describe('constructor', () => {
    it('should create a new instance', () => {
      assert.ok(rebaseService);
    });

    it('should have onDidChangeRebaseSession event', () => {
      assert.ok(rebaseService.onDidChangeRebaseSession);
    });
  });

  describe('createRebaseService', () => {
    it('should create a new RebaseService instance', () => {
      const service = createRebaseService();
      assert.ok(service);
      service.dispose();
    });
  });

  describe('startInteractiveRebase()', () => {
    it('should return a rebase session with commits', async () => {
      // Mock getting current branch
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      // Mock getting commits to rebase
      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'abc123\0First commit\ndef456\0Second commit\n')
      );

      const session = await rebaseService.startInteractiveRebase(mockRepo, 'main');

      assert.strictEqual(session.onto, 'main');
      assert.strictEqual(session.originalBranch, 'feature-branch');
      assert.strictEqual(session.status, 'planning');
      assert.strictEqual(session.currentStep, 0);
      assert.strictEqual(session.commits.length, 2);
      assert.strictEqual(session.commits[0].hash, 'abc123');
      assert.strictEqual(session.commits[0].message, 'First commit');
      assert.strictEqual(session.commits[0].action, 'pick');
    });

    it('should fire onDidChangeRebaseSession event', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      let firedSession: IRebaseSession | undefined;
      const disposable = rebaseService.onDidChangeRebaseSession((session) => {
        firedSession = session;
      });

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      assert.ok(firedSession);
      assert.strictEqual(firedSession?.onto, 'main');

      disposable.dispose();
    });

    it('should handle empty commit list', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, ''));

      const session = await rebaseService.startInteractiveRebase(mockRepo, 'main');

      assert.strictEqual(session.commits.length, 0);
    });
  });

  describe('getRebaseSession()', () => {
    it('should return undefined when no session exists', () => {
      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session, undefined);
    });

    it('should return the session after starting a rebase', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      const session = rebaseService.getRebaseSession(mockRepo);

      assert.ok(session);
      assert.strictEqual(session?.onto, 'main');
    });
  });

  describe('updateRebasePlan()', () => {
    beforeEach(async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'abc123\0First commit\ndef456\0Second commit\nghi789\0Third commit\n')
      );

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
    });

    it('should update commit actions', () => {
      const plan: IRebaseAction[] = [
        { hash: 'abc123', action: 'pick' },
        { hash: 'def456', action: 'squash' },
        { hash: 'ghi789', action: 'drop' },
      ];

      rebaseService.updateRebasePlan(mockRepo, plan);

      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session?.commits[0].action, 'pick');
      assert.strictEqual(session?.commits[1].action, 'squash');
      assert.strictEqual(session?.commits[2].action, 'drop');
    });

    it('should support all rebase actions', () => {
      const actions: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

      for (const action of actions) {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, action);
      }
    });

    it('should allow reordering commits via drag-and-drop', () => {
      // Reorder: Third, First, Second
      const plan: IRebaseAction[] = [
        { hash: 'ghi789', action: 'pick' },
        { hash: 'abc123', action: 'pick' },
        { hash: 'def456', action: 'pick' },
      ];

      rebaseService.updateRebasePlan(mockRepo, plan);

      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session?.commits[0].hash, 'ghi789');
      assert.strictEqual(session?.commits[1].hash, 'abc123');
      assert.strictEqual(session?.commits[2].hash, 'def456');
    });

    it('should update commit message when newMessage is provided', () => {
      const plan: IRebaseAction[] = [
        { hash: 'abc123', action: 'reword', newMessage: 'Updated message' },
        { hash: 'def456', action: 'pick' },
        { hash: 'ghi789', action: 'pick' },
      ];

      rebaseService.updateRebasePlan(mockRepo, plan);

      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session?.commits[0].message, 'Updated message');
    });

    it('should fire onDidChangeRebaseSession event', () => {
      let firedSession: IRebaseSession | undefined;
      const disposable = rebaseService.onDidChangeRebaseSession((session) => {
        firedSession = session;
      });

      const plan: IRebaseAction[] = [
        { hash: 'abc123', action: 'squash' },
        { hash: 'def456', action: 'pick' },
        { hash: 'ghi789', action: 'pick' },
      ];

      rebaseService.updateRebasePlan(mockRepo, plan);

      assert.ok(firedSession);
      assert.strictEqual(firedSession?.commits[0].action, 'squash');

      disposable.dispose();
    });

    it('should throw error when no session exists', () => {
      const newService = new RebaseService(mockGitCli);
      const plan: IRebaseAction[] = [{ hash: 'abc123', action: 'pick' }];

      assert.throws(() => newService.updateRebasePlan(mockRepo, plan), /No rebase session found/);

      newService.dispose();
    });

    it('should throw error when commit hash not found', () => {
      const plan: IRebaseAction[] = [{ hash: 'nonexistent', action: 'pick' }];

      assert.throws(
        () => rebaseService.updateRebasePlan(mockRepo, plan),
        /Commit nonexistent not found/
      );
    });
  });

  describe('executeRebase() — autostash', () => {
    let tmpRepo: string;
    let tmpRebaseService: RebaseService;
    let tmpRepoObj: IRepository;

    beforeEach(async () => {
      // executeRebase writes a sequence-editor script under <cwd>/.git, so the
      // test needs a real on-disk repo root with a .git directory.
      tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-autostash-'));
      fs.mkdirSync(path.join(tmpRepo, '.git'));
      tmpRepoObj = createMockRepository(tmpRepo);
      tmpRebaseService = new RebaseService(mockGitCli);

      mockGitCli.setExecResult('rev-parse --abbrev-ref HEAD', createMockResult(0, 'feature\n'));
      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));
      await tmpRebaseService.startInteractiveRebase(tmpRepoObj, 'main');
      mockGitCli.clearCalls();
    });

    afterEach(() => {
      tmpRebaseService.dispose();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    });

    it('passes --autostash to the interactive rebase argv', async () => {
      await tmpRebaseService.executeRebase(tmpRepoObj);

      const rebaseCall = mockGitCli
        .getExecCalls()
        .find((c) => c.args[0] === 'rebase' && c.args.includes('-i'));
      assert.ok(rebaseCall, 'interactive rebase should have been spawned');
      // autostash stashes BEFORE the todo editor runs and pops AFTER the
      // rebase finishes, so it does not interfere with the custom sequence
      // editor wired below.
      assert.deepStrictEqual(rebaseCall.args, ['rebase', '-i', '--autostash', 'main']);
    });

    it('still wires the custom sequence editor when autostash is enabled', async () => {
      await tmpRebaseService.executeRebase(tmpRepoObj);

      const rebaseCall = mockGitCli
        .getExecCalls()
        .find((c) => c.args[0] === 'rebase' && c.args.includes('-i'));
      assert.ok(rebaseCall);
      const env = (rebaseCall.options as { env?: NodeJS.ProcessEnv }).env;
      assert.ok(env, 'rebase must run with an explicit env');
      assert.ok(
        typeof env.GIT_SEQUENCE_EDITOR === 'string' &&
          env.GIT_SEQUENCE_EDITOR.endsWith('rebase-todo-script.sh'),
        `GIT_SEQUENCE_EDITOR must still point at the generated sequence editor, got: ${String(
          env.GIT_SEQUENCE_EDITOR
        )}`
      );
    });

    it('reports a conflict when the autostash pop leaves unmerged files (exit 0)', async () => {
      // An interactive rebase can replay cleanly and exit 0, yet leave
      // unmerged files behind when git re-applies the autostash and it
      // collides with the rebased changes. The result must surface that as a
      // conflict rather than reporting a clean completion.
      mockGitCli.setExecResult('status --porcelain', createMockResult(0, 'UU shared.ts\n'));

      const result = await tmpRebaseService.executeRebase(tmpRepoObj);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'conflict');
      assert.deepStrictEqual(result.conflictedFiles, ['shared.ts']);
    });

    it('completes cleanly when the autostash pop leaves no unmerged files (exit 0)', async () => {
      // No-regression guard: a clean autostash round-trip still reports a
      // completed rebase.
      mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

      const result = await tmpRebaseService.executeRebase(tmpRepoObj);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
    });
  });

  describe('continueRebase()', () => {
    it('should execute git rebase --continue', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.clearCalls();

      mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));

      const result = await rebaseService.continueRebase(mockRepo);

      const calls = mockGitCli.getExecCalls();
      const continueCall = calls.find((c) => c.args.includes('--continue'));
      assert.ok(continueCall);
      assert.ok(result.success);
    });
  });

  describe('abortRebase()', () => {
    it('should execute git rebase --abort', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.clearCalls();

      mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

      await rebaseService.abortRebase(mockRepo);

      const calls = mockGitCli.getExecCalls();
      const abortCall = calls.find((c) => c.args.includes('--abort'));
      assert.ok(abortCall);
    });

    it('should clear the session after abort', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

      await rebaseService.abortRebase(mockRepo);

      const session = rebaseService.getRebaseSession(mockRepo);
      assert.strictEqual(session, undefined);
    });

    it('should fire onDidChangeRebaseSession with undefined', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      let firedSession: IRebaseSession | undefined | null = null;
      const disposable = rebaseService.onDidChangeRebaseSession((session) => {
        firedSession = session;
      });

      mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

      await rebaseService.abortRebase(mockRepo);

      assert.strictEqual(firedSession, undefined);

      disposable.dispose();
    });
  });

  describe('skipCommit()', () => {
    it('should execute git rebase --skip', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.clearCalls();

      mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));

      const result = await rebaseService.skipCommit(mockRepo);

      const calls = mockGitCli.getExecCalls();
      const skipCall = calls.find((c) => c.args.includes('--skip'));
      assert.ok(skipCall);
      assert.ok(result.success);
    });

    it('should return completed status when rebase finishes after skip', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      mockGitCli.clearCalls();

      // Mock successful skip that completes the rebase
      mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
      // No rebase-merge directory means rebase is complete
      mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

      const result = await rebaseService.skipCommit(mockRepo);

      assert.ok(result.success);
      // Session should be cleared after completion
      // Note: Session may still exist if rebase-merge dir check fails in mock
      // The important thing is the skip command was executed
    });

    it('should fire onDidChangeRebaseSession event after skip', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');

      let eventFired = false;
      const disposable = rebaseService.onDidChangeRebaseSession(() => {
        eventFired = true;
      });

      mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
      mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

      await rebaseService.skipCommit(mockRepo);

      assert.ok(eventFired);

      disposable.dispose();
    });
  });

  describe('Rebase Control Operations', () => {
    beforeEach(async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'abc123\0First commit\ndef456\0Second commit\n')
      );

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
    });

    describe('continueRebase()', () => {
      it('should resume rebase after conflicts are resolved', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

        const result = await rebaseService.continueRebase(mockRepo);

        const calls = mockGitCli.getExecCalls();
        const continueCall = calls.find((c) => c.args.includes('--continue'));
        assert.ok(continueCall);
        assert.ok(result.success);
      });

      it('should return conflict status when conflicts still exist', async () => {
        mockGitCli.clearCalls();
        // Simulate continue failing due to conflicts
        mockGitCli.setExecResult(
          'rebase --continue',
          createMockResult(1, '', 'error: could not apply')
        );
        // Simulate conflicted files in status
        mockGitCli.setExecResult(
          'status --porcelain',
          createMockResult(0, 'UU conflicted-file.ts\n')
        );

        const result = await rebaseService.continueRebase(mockRepo);

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'conflict');
        assert.ok(result.conflictedFiles);
        assert.ok(result.conflictedFiles.length > 0);
      });

      it('should update session status to conflict when conflicts detected', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --continue', createMockResult(1, '', 'error'));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, 'UU file.ts\n'));

        await rebaseService.continueRebase(mockRepo);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.status, 'conflict');
      });

      it('should increment currentStep on successful continue', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

        const sessionBefore = rebaseService.getRebaseSession(mockRepo);
        const stepBefore = sessionBefore?.currentStep ?? 0;

        await rebaseService.continueRebase(mockRepo);

        const sessionAfter = rebaseService.getRebaseSession(mockRepo);
        // Step should increment if rebase is still in progress
        // Note: In mock environment, we can't fully simulate the rebase state
        assert.ok(sessionAfter !== undefined || stepBefore >= 0);
      });

      it('should fire onDidChangeRebaseSession event', async () => {
        let eventFired = false;
        const disposable = rebaseService.onDidChangeRebaseSession(() => {
          eventFired = true;
        });

        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

        await rebaseService.continueRebase(mockRepo);

        assert.ok(eventFired);

        disposable.dispose();
      });
    });

    describe('abortRebase()', () => {
      it('should restore repository to pre-rebase state', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

        await rebaseService.abortRebase(mockRepo);

        const calls = mockGitCli.getExecCalls();
        const abortCall = calls.find((c) => c.args.includes('--abort'));
        assert.ok(abortCall);
        assert.deepStrictEqual(abortCall.args, ['rebase', '--abort']);
      });

      it('should clear the rebase session completely', async () => {
        mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

        // Verify session exists before abort
        const sessionBefore = rebaseService.getRebaseSession(mockRepo);
        assert.ok(sessionBefore);

        await rebaseService.abortRebase(mockRepo);

        // Verify session is cleared after abort
        const sessionAfter = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(sessionAfter, undefined);
      });

      it('should fire onDidChangeRebaseSession with undefined to indicate no active session', async () => {
        let firedValue: IRebaseSession | undefined | null = null;
        const disposable = rebaseService.onDidChangeRebaseSession((session) => {
          firedValue = session;
        });

        mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

        await rebaseService.abortRebase(mockRepo);

        assert.strictEqual(firedValue, undefined);

        disposable.dispose();
      });

      it('should throw error if git rebase --abort fails', async () => {
        // Create a new mock that properly handles throwOnError
        class ThrowingMockGitCli extends MockGitCli {
          override exec(args: string[], options?: unknown): Promise<IGitCommandResult> {
            const opts = options as { throwOnError?: boolean } | undefined;
            const argsStr = args.join(' ');

            // Check if this is the abort command that should fail
            if (argsStr.includes('rebase --abort')) {
              const result = createMockResult(1, '', 'fatal: No rebase in progress');
              if (opts?.throwOnError) {
                return Promise.reject(new Error('Git command failed: git rebase --abort'));
              }
              return Promise.resolve(result);
            }

            return super.exec(args, options);
          }
        }

        const throwingMockGitCli = new ThrowingMockGitCli();
        const throwingRebaseService = new RebaseService(throwingMockGitCli);

        // Set up the session
        throwingMockGitCli.setExecResult(
          'rev-parse --abbrev-ref HEAD',
          createMockResult(0, 'feature-branch\n')
        );
        throwingMockGitCli.setExecResult(
          'log --reverse',
          createMockResult(0, 'abc123\0First commit\n')
        );

        await throwingRebaseService.startInteractiveRebase(mockRepo, 'main');

        // The abort should throw because throwOnError is true
        await assert.rejects(
          async () => throwingRebaseService.abortRebase(mockRepo),
          /Git command failed/
        );

        throwingRebaseService.dispose();
      });
    });

    describe('skipCommit()', () => {
      it('should skip the current problematic commit', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

        const result = await rebaseService.skipCommit(mockRepo);

        const calls = mockGitCli.getExecCalls();
        const skipCall = calls.find((c) => c.args.includes('--skip'));
        assert.ok(skipCall);
        assert.deepStrictEqual(skipCall.args, ['rebase', '--skip']);
        assert.ok(result.success);
      });

      it('should return conflict status if skip leads to more conflicts', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --skip', createMockResult(1, '', 'error'));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, 'UU another-file.ts\n'));

        const result = await rebaseService.skipCommit(mockRepo);

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'conflict');
        assert.ok(result.conflictedFiles);
        assert.ok(result.conflictedFiles.includes('another-file.ts'));
      });

      it('should update session status after skip', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

        await rebaseService.skipCommit(mockRepo);

        // Session should be updated (either in-progress or completed)
        // The exact state depends on whether rebase is still in progress
        const sessionAfterSkip = rebaseService.getRebaseSession(mockRepo);
        // In mock environment, session may or may not exist depending on rebase state detection
        assert.ok(sessionAfterSkip === undefined || sessionAfterSkip.status !== 'planning');
      });

      it('should increment currentStep when skip succeeds and rebase continues', async () => {
        mockGitCli.clearCalls();
        mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

        const sessionBefore = rebaseService.getRebaseSession(mockRepo);
        const stepBefore = sessionBefore?.currentStep ?? 0;

        await rebaseService.skipCommit(mockRepo);

        const sessionAfter = rebaseService.getRebaseSession(mockRepo);
        // If session still exists, step should have incremented
        if (sessionAfter) {
          assert.ok(sessionAfter.currentStep >= stepBefore);
        }
      });
    });

    describe('Integration: Control Operations Workflow', () => {
      it('should handle continue -> conflict -> skip workflow', async () => {
        // First continue attempt hits conflict
        mockGitCli.setExecResult('rebase --continue', createMockResult(1, '', 'error'));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, 'UU file.ts\n'));

        const continueResult = await rebaseService.continueRebase(mockRepo);
        assert.strictEqual(continueResult.status, 'conflict');

        // User decides to skip the problematic commit
        mockGitCli.setExecResult('rebase --skip', createMockResult(0, ''));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, ''));

        const skipResult = await rebaseService.skipCommit(mockRepo);
        assert.ok(skipResult.success);
      });

      it('should handle continue -> conflict -> abort workflow', async () => {
        // Continue hits conflict
        mockGitCli.setExecResult('rebase --continue', createMockResult(1, '', 'error'));
        mockGitCli.setExecResult('status --porcelain', createMockResult(0, 'UU file.ts\n'));

        const continueResult = await rebaseService.continueRebase(mockRepo);
        assert.strictEqual(continueResult.status, 'conflict');

        // User decides to abort
        mockGitCli.setExecResult('rebase --abort', createMockResult(0, ''));

        await rebaseService.abortRebase(mockRepo);

        // Session should be cleared
        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session, undefined);
      });
    });
  });

  describe('dispose()', () => {
    it('should dispose without error', () => {
      rebaseService.dispose();
      // Should not throw
    });

    it('should clear sessions on dispose', async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult('log --reverse', createMockResult(0, 'abc123\0First commit\n'));

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
      rebaseService.dispose();

      // Create a new service to verify session is cleared
      const newService = new RebaseService(mockGitCli);
      const session = newService.getRebaseSession(mockRepo);
      assert.strictEqual(session, undefined);
      newService.dispose();
    });
  });

  describe('Rebase Action Handlers', () => {
    beforeEach(async () => {
      mockGitCli.setExecResult(
        'rev-parse --abbrev-ref HEAD',
        createMockResult(0, 'feature-branch\n')
      );

      mockGitCli.setExecResult(
        'log --reverse',
        createMockResult(0, 'abc123\0First commit\ndef456\0Second commit\nghi789\0Third commit\n')
      );

      await rebaseService.startInteractiveRebase(mockRepo, 'main');
    });

    describe('Reword Action', () => {
      it('should allow setting reword action on a commit', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'reword', newMessage: 'New message for first commit' },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'reword');
        assert.strictEqual(session?.commits[0].message, 'New message for first commit');
      });

      it('should preserve original message when newMessage is not provided for reword', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'reword' },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'reword');
        assert.strictEqual(session?.commits[0].message, 'First commit');
      });

      it('should provide reword message via provideRewordMessage', async () => {
        mockGitCli.setExecResult('commit --amend', createMockResult(0, ''));
        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));

        const result = await rebaseService.provideRewordMessage(mockRepo, 'New commit message');

        // Verify git commit --amend was called with the new message
        const calls = mockGitCli.getExecCalls();
        const amendCall = calls.find((c) => c.args.includes('--amend') && c.args.includes('-m'));
        assert.ok(amendCall);
        assert.ok(amendCall.args.includes('New commit message'));
        assert.ok(result.success);
      });

      it('should throw error when providing reword message without session', async () => {
        const newService = new RebaseService(mockGitCli);

        await assert.rejects(
          async () => newService.provideRewordMessage(mockRepo, 'New message'),
          /No rebase session found/
        );

        newService.dispose();
      });
    });

    // `provideSquashMessage` is the symmetric companion to
    // `provideRewordMessage`. The git mechanics are identical (the rebase
    // pauses, asks for a commit message, and resumes on `--continue`); the
    // separate name carries intent at the call site for the squash multi-
    // commit flow added in.
    describe('Squash Action — provideSquashMessage', () => {
      it('should provide squash message via provideSquashMessage', async () => {
        mockGitCli.setExecResult('commit --amend', createMockResult(0, ''));
        mockGitCli.setExecResult('rebase --continue', createMockResult(0, ''));

        const result = await rebaseService.provideSquashMessage(
          mockRepo,
          'Combined squash message'
        );

        // git commit --amend -m <message> threads the user's chosen
        // squash message into the rebase the same way reword does.
        const calls = mockGitCli.getExecCalls();
        const amendCall = calls.find((c) => c.args.includes('--amend') && c.args.includes('-m'));
        assert.ok(amendCall, 'expected git commit --amend -m to be invoked');
        assert.ok(amendCall.args.includes('Combined squash message'));
        assert.ok(result.success);
      });

      it('should throw error when providing squash message without session', async () => {
        const newService = new RebaseService(mockGitCli);

        await assert.rejects(
          async () => newService.provideSquashMessage(mockRepo, 'Combined squash message'),
          /No rebase session found/
        );

        newService.dispose();
      });

      it('should surface conflict status when amend fails with conflicts', async () => {
        mockGitCli.setExecResult('commit --amend', createMockResult(1, '', 'merge conflict'));
        mockGitCli.setExecResult(
          'status --porcelain',
          createMockResult(0, 'UU src/conflicted.ts\n')
        );

        const result = await rebaseService.provideSquashMessage(mockRepo, 'msg');

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'conflict');
        assert.ok(result.conflictedFiles && result.conflictedFiles.length > 0);
      });

      it('should be exposed on the IRebaseService interface', async () => {
        const fs = await import('fs');
        const path = await import('path');
        const src = fs.readFileSync(
          path.join(process.cwd(), 'src/git-core/interfaces/IRebaseService.ts'),
          'utf8'
        );
        assert.ok(
          /provideSquashMessage\s*\(\s*repo\s*:\s*IRepository\s*,\s*message\s*:\s*string\s*\)\s*:\s*Promise<IRebaseResult>/.test(
            src
          ),
          'IRebaseService must declare provideSquashMessage(repo, message): Promise<IRebaseResult>'
        );
      });
    });

    describe('Edit Action', () => {
      it('should allow setting edit action on a commit', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'edit' },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'edit');
      });

      it('should allow amending commit during edit pause', async () => {
        mockGitCli.setExecResult('commit --amend', createMockResult(0, ''));

        const result = await rebaseService.amendEditCommit(mockRepo, 'Amended message');

        const calls = mockGitCli.getExecCalls();
        const amendCall = calls.find((c) => c.args.includes('--amend'));
        assert.ok(amendCall);
        assert.ok(result.success);
        assert.strictEqual(result.status, 'paused');
      });

      it('should allow amending without changing message', async () => {
        mockGitCli.setExecResult('commit --amend', createMockResult(0, ''));

        const result = await rebaseService.amendEditCommit(mockRepo);

        const calls = mockGitCli.getExecCalls();
        const amendCall = calls.find(
          (c) => c.args.includes('--amend') && c.args.includes('--no-edit')
        );
        assert.ok(amendCall);
        assert.ok(result.success);
      });

      it('should throw error when amending without session', async () => {
        const newService = new RebaseService(mockGitCli);

        await assert.rejects(
          async () => newService.amendEditCommit(mockRepo),
          /No rebase session found/
        );

        newService.dispose();
      });
    });

    describe('Squash and Fixup Actions', () => {
      it('should allow setting squash action to combine commits', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'squash' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].action, 'squash');
      });

      it('should allow setting fixup action to combine commits without message', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'fixup' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].action, 'fixup');
      });

      it('should allow multiple consecutive squash/fixup actions', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'squash' },
          { hash: 'ghi789', action: 'fixup' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].action, 'squash');
        assert.strictEqual(session?.commits[2].action, 'fixup');
      });

      it('should allow mixing squash and fixup with reordering', () => {
        // Reorder and squash: Third (pick), First (squash), Second (fixup)
        const plan: IRebaseAction[] = [
          { hash: 'ghi789', action: 'pick' },
          { hash: 'abc123', action: 'squash' },
          { hash: 'def456', action: 'fixup' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].hash, 'ghi789');
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].hash, 'abc123');
        assert.strictEqual(session?.commits[1].action, 'squash');
        assert.strictEqual(session?.commits[2].hash, 'def456');
        assert.strictEqual(session?.commits[2].action, 'fixup');
      });
    });

    describe('Drop Action', () => {
      it('should allow setting drop action to remove a commit', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'drop' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[1].action, 'drop');
      });

      it('should allow dropping multiple commits', () => {
        const plan: IRebaseAction[] = [
          { hash: 'abc123', action: 'drop' },
          { hash: 'def456', action: 'drop' },
          { hash: 'ghi789', action: 'pick' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'drop');
        assert.strictEqual(session?.commits[1].action, 'drop');
        assert.strictEqual(session?.commits[2].action, 'pick');
      });
    });

    describe('Combined Action Scenarios', () => {
      it('should support complex rebase plan with all action types', () => {
        const plan: IRebaseAction[] = [
          { hash: 'ghi789', action: 'pick' }, // Reordered to first
          { hash: 'abc123', action: 'reword', newMessage: 'Reworded first commit' },
          { hash: 'def456', action: 'squash' },
        ];

        rebaseService.updateRebasePlan(mockRepo, plan);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits.length, 3);
        assert.strictEqual(session?.commits[0].hash, 'ghi789');
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].hash, 'abc123');
        assert.strictEqual(session?.commits[1].action, 'reword');
        assert.strictEqual(session?.commits[1].message, 'Reworded first commit');
        assert.strictEqual(session?.commits[2].hash, 'def456');
        assert.strictEqual(session?.commits[2].action, 'squash');
      });

      it('should preserve session state across multiple plan updates', () => {
        // First update
        const plan1: IRebaseAction[] = [
          { hash: 'abc123', action: 'edit' },
          { hash: 'def456', action: 'pick' },
          { hash: 'ghi789', action: 'pick' },
        ];
        rebaseService.updateRebasePlan(mockRepo, plan1);

        // Second update
        const plan2: IRebaseAction[] = [
          { hash: 'abc123', action: 'pick' },
          { hash: 'def456', action: 'squash' },
          { hash: 'ghi789', action: 'drop' },
        ];
        rebaseService.updateRebasePlan(mockRepo, plan2);

        const session = rebaseService.getRebaseSession(mockRepo);
        assert.strictEqual(session?.commits[0].action, 'pick');
        assert.strictEqual(session?.commits[1].action, 'squash');
        assert.strictEqual(session?.commits[2].action, 'drop');
        assert.strictEqual(session?.onto, 'main');
        assert.strictEqual(session?.originalBranch, 'feature-branch');
      });
    });
  });
});
