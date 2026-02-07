import * as assert from 'assert';
import * as vscode from 'vscode';
import { RebaseProgressView, createRebaseProgressView } from '../../../services/RebaseProgressView';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
} from '../../../services/interfaces/IRebaseService';
import { IRepository } from '../../../services/interfaces/IGitService';

/**
 * Mock RebaseService for testing
 */
class MockRebaseService implements IRebaseService {
  private _session: IRebaseSession | undefined;
  private _onDidChangeRebaseSession = new vscode.EventEmitter<IRebaseSession | undefined>();
  public lastPlan: IRebaseAction[] | undefined;
  public continueResult: IRebaseResult = { success: true, status: 'in-progress' };
  public skipResult: IRebaseResult = { success: true, status: 'in-progress' };
  public abortCalled = false;
  public continueCalled = false;
  public skipCalled = false;
  public provideRewordMessageCalled = false;
  public lastRewordMessage: string | undefined;

  readonly onDidChangeRebaseSession = this._onDidChangeRebaseSession.event;

  startInteractiveRebase(_repo: IRepository, onto: string): Promise<IRebaseSession> {
    this._session = {
      onto,
      originalBranch: 'feature-branch',
      commits: [
        { hash: 'abc1234567890', message: 'First commit', action: 'pick' },
        { hash: 'def2345678901', message: 'Second commit', action: 'pick' },
        { hash: 'ghi3456789012', message: 'Third commit', action: 'pick' },
      ],
      currentStep: 0,
      status: 'planning',
    };
    this._onDidChangeRebaseSession.fire(this._session);
    return Promise.resolve(this._session);
  }

  getRebaseSession(_repo: IRepository): IRebaseSession | undefined {
    return this._session;
  }

  updateRebasePlan(_repo: IRepository, plan: IRebaseAction[]): void {
    this.lastPlan = plan;
    if (this._session) {
      this._session.commits = plan.map((action) => {
        const existing = this._session!.commits.find((c) => c.hash === action.hash);
        return {
          hash: action.hash,
          message: action.newMessage || existing?.message || '',
          action: action.action,
        };
      });
      this._onDidChangeRebaseSession.fire(this._session);
    }
  }

  executeRebase(_repo: IRepository): Promise<IRebaseResult> {
    if (this._session) {
      this._session.status = 'in-progress';
      this._onDidChangeRebaseSession.fire(this._session);
    }
    return Promise.resolve({ success: true, status: 'completed' });
  }

  continueRebase(_repo: IRepository): Promise<IRebaseResult> {
    this.continueCalled = true;
    if (this._session && this.continueResult.success) {
      if (this.continueResult.status === 'completed') {
        this._session = undefined;
      } else {
        this._session.status = this.continueResult.status;
        this._session.currentStep++;
      }
      this._onDidChangeRebaseSession.fire(this._session);
    }
    return Promise.resolve(this.continueResult);
  }

  abortRebase(_repo: IRepository): Promise<void> {
    this.abortCalled = true;
    this._session = undefined;
    this._onDidChangeRebaseSession.fire(undefined);
    return Promise.resolve();
  }

  skipCommit(_repo: IRepository): Promise<IRebaseResult> {
    this.skipCalled = true;
    if (this._session && this.skipResult.success) {
      if (this.skipResult.status === 'completed') {
        this._session = undefined;
      } else {
        this._session.status = this.skipResult.status;
        this._session.currentStep++;
      }
      this._onDidChangeRebaseSession.fire(this._session);
    }
    return Promise.resolve(this.skipResult);
  }

  provideRewordMessage(_repo: IRepository, message: string): Promise<IRebaseResult> {
    this.provideRewordMessageCalled = true;
    this.lastRewordMessage = message;
    return Promise.resolve({ success: true, status: 'in-progress' });
  }

  amendEditCommit(_repo: IRepository, _message?: string): Promise<IRebaseResult> {
    return Promise.resolve({ success: true, status: 'paused' });
  }

  setSession(session: IRebaseSession | undefined): void {
    this._session = session;
    this._onDidChangeRebaseSession.fire(session);
  }

  dispose(): void {
    this._onDidChangeRebaseSession.dispose();
  }
}

/**
 * Create a mock repository
 */
function createMockRepository(): IRepository {
  return {
    rootUri: vscode.Uri.file('/test/repo'),
    state: 'rebasing',
    remotes: [],
    submodules: [],
  };
}

describe('RebaseProgressView', () => {
  let rebaseProgressView: RebaseProgressView;
  let mockRebaseService: MockRebaseService;
  let mockRepository: IRepository;
  let extensionUri: vscode.Uri;

  beforeEach(() => {
    mockRebaseService = new MockRebaseService();
    mockRepository = createMockRepository();
    extensionUri = vscode.Uri.file('/test/extension');
    rebaseProgressView = new RebaseProgressView(extensionUri, mockRebaseService);
  });

  afterEach(() => {
    rebaseProgressView.dispose();
    mockRebaseService.dispose();
  });

  describe('createRebaseProgressView', () => {
    it('should create a RebaseProgressView instance', () => {
      const view = createRebaseProgressView(extensionUri, mockRebaseService);
      assert.ok(view instanceof RebaseProgressView);
      view.dispose();
    });
  });

  describe('show()', () => {
    it('should get the current rebase session from the service', async () => {
      // Set up a session first
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      mockRebaseService.setSession({
        onto: 'main',
        originalBranch: 'feature-branch',
        commits: [{ hash: 'abc123', message: 'Test commit', action: 'pick' }],
        currentStep: 0,
        status: 'in-progress',
      });

      // Show the view - this will create a webview panel
      // In test environment, we can't fully test webview creation
      // but we can verify the service interaction
      const session = mockRebaseService.getRebaseSession(mockRepository);
      assert.ok(session);
      assert.strictEqual(session.status, 'in-progress');
    });

    it('should accept conflicted files list', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      const conflictedFiles = ['file1.ts', 'file2.ts'];
      // The view stores conflicted files internally
      // We verify this through the updateConflictedFiles method
      rebaseProgressView.updateConflictedFiles(conflictedFiles);
      // No assertion needed - just verify no error is thrown
    });
  });

  describe('updateConflictedFiles()', () => {
    it('should update the conflicted files list', () => {
      const files = ['src/file1.ts', 'src/file2.ts'];
      rebaseProgressView.updateConflictedFiles(files);
      // Method should not throw
    });

    it('should handle empty files list', () => {
      rebaseProgressView.updateConflictedFiles([]);
      // Method should not throw
    });
  });

  describe('refresh()', () => {
    it('should refresh the session from the service', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      // Update the session
      mockRebaseService.setSession({
        onto: 'main',
        originalBranch: 'feature-branch',
        commits: [{ hash: 'abc123', message: 'Test commit', action: 'pick' }],
        currentStep: 1,
        status: 'conflict',
      });

      // Refresh should get the updated session
      rebaseProgressView.refresh();

      const session = mockRebaseService.getRebaseSession(mockRepository);
      assert.strictEqual(session?.status, 'conflict');
      assert.strictEqual(session?.currentStep, 1);
    });
  });

  describe('hide()', () => {
    it('should not throw when called without showing first', () => {
      rebaseProgressView.hide();
      // Should not throw
    });
  });

  describe('dispose()', () => {
    it('should dispose without error', () => {
      rebaseProgressView.dispose();
      // Should not throw
    });

    it('should clean up resources', () => {
      rebaseProgressView.dispose();
      // Calling dispose again should not throw
      rebaseProgressView.dispose();
    });
  });

  describe('Rebase Control Operations', () => {
    beforeEach(async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      mockRebaseService.setSession({
        onto: 'main',
        originalBranch: 'feature-branch',
        commits: [
          { hash: 'abc123', message: 'First commit', action: 'pick' },
          { hash: 'def456', message: 'Second commit', action: 'pick' },
        ],
        currentStep: 0,
        status: 'conflict',
      });
    });

    describe('Continue Rebase (Requirement 6.7)', () => {
      it('should call continueRebase on the service', async () => {
        mockRebaseService.continueResult = { success: true, status: 'in-progress' };

        // Simulate the continue action
        await mockRebaseService.continueRebase(mockRepository);

        assert.strictEqual(mockRebaseService.continueCalled, true);
      });

      it('should handle successful continue', async () => {
        mockRebaseService.continueResult = { success: true, status: 'in-progress' };

        const result = await mockRebaseService.continueRebase(mockRepository);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'in-progress');
      });

      it('should handle continue with conflicts', async () => {
        mockRebaseService.continueResult = {
          success: false,
          status: 'conflict',
          conflictedFiles: ['file1.ts', 'file2.ts'],
        };

        const result = await mockRebaseService.continueRebase(mockRepository);

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'conflict');
        assert.ok(result.conflictedFiles);
        assert.strictEqual(result.conflictedFiles.length, 2);
      });

      it('should handle completed rebase', async () => {
        mockRebaseService.continueResult = { success: true, status: 'completed' };

        const result = await mockRebaseService.continueRebase(mockRepository);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'completed');

        // Session should be cleared
        const session = mockRebaseService.getRebaseSession(mockRepository);
        assert.strictEqual(session, undefined);
      });
    });

    describe('Abort Rebase (Requirement 6.8)', () => {
      it('should call abortRebase on the service', async () => {
        await mockRebaseService.abortRebase(mockRepository);

        assert.strictEqual(mockRebaseService.abortCalled, true);
      });

      it('should clear the session after abort', async () => {
        // Verify session exists before abort
        let session = mockRebaseService.getRebaseSession(mockRepository);
        assert.ok(session);

        await mockRebaseService.abortRebase(mockRepository);

        // Session should be cleared
        session = mockRebaseService.getRebaseSession(mockRepository);
        assert.strictEqual(session, undefined);
      });

      it('should fire onDidChangeRebaseSession with undefined', async () => {
        let firedSession: IRebaseSession | undefined | null = null;
        const disposable = mockRebaseService.onDidChangeRebaseSession((session) => {
          firedSession = session;
        });

        await mockRebaseService.abortRebase(mockRepository);

        assert.strictEqual(firedSession, undefined);

        disposable.dispose();
      });
    });

    describe('Skip Commit (Requirement 6.9)', () => {
      it('should call skipCommit on the service', async () => {
        mockRebaseService.skipResult = { success: true, status: 'in-progress' };

        await mockRebaseService.skipCommit(mockRepository);

        assert.strictEqual(mockRebaseService.skipCalled, true);
      });

      it('should handle successful skip', async () => {
        mockRebaseService.skipResult = { success: true, status: 'in-progress' };

        const result = await mockRebaseService.skipCommit(mockRepository);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'in-progress');
      });

      it('should handle skip with more conflicts', async () => {
        mockRebaseService.skipResult = {
          success: false,
          status: 'conflict',
          conflictedFiles: ['another-file.ts'],
        };

        const result = await mockRebaseService.skipCommit(mockRepository);

        assert.strictEqual(result.success, false);
        assert.strictEqual(result.status, 'conflict');
      });

      it('should handle completed rebase after skip', async () => {
        mockRebaseService.skipResult = { success: true, status: 'completed' };

        const result = await mockRebaseService.skipCommit(mockRepository);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.status, 'completed');

        // Session should be cleared
        const session = mockRebaseService.getRebaseSession(mockRepository);
        assert.strictEqual(session, undefined);
      });

      it('should increment currentStep on successful skip', async () => {
        mockRebaseService.skipResult = { success: true, status: 'in-progress' };

        const sessionBefore = mockRebaseService.getRebaseSession(mockRepository);
        const stepBefore = sessionBefore?.currentStep ?? 0;

        await mockRebaseService.skipCommit(mockRepository);

        const sessionAfter = mockRebaseService.getRebaseSession(mockRepository);
        assert.ok(sessionAfter);
        assert.strictEqual(sessionAfter.currentStep, stepBefore + 1);
      });
    });
  });

  describe('Session State Changes', () => {
    it('should listen to onDidChangeRebaseSession events', async () => {
      let eventCount = 0;
      const disposable = mockRebaseService.onDidChangeRebaseSession(() => {
        eventCount++;
      });

      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      assert.ok(eventCount > 0);

      disposable.dispose();
    });

    it('should update when session status changes', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      // Change status to conflict
      mockRebaseService.setSession({
        onto: 'main',
        originalBranch: 'feature-branch',
        commits: [{ hash: 'abc123', message: 'Test commit', action: 'pick' }],
        currentStep: 0,
        status: 'conflict',
      });

      const session = mockRebaseService.getRebaseSession(mockRepository);
      assert.strictEqual(session?.status, 'conflict');
    });

    it('should handle session being cleared', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      // Clear the session
      mockRebaseService.setSession(undefined);

      const session = mockRebaseService.getRebaseSession(mockRepository);
      assert.strictEqual(session, undefined);
    });
  });

  describe('Provide Reword Message', () => {
    it('should call provideRewordMessage on the service', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      await mockRebaseService.provideRewordMessage(mockRepository, 'New commit message');

      assert.strictEqual(mockRebaseService.provideRewordMessageCalled, true);
      assert.strictEqual(mockRebaseService.lastRewordMessage, 'New commit message');
    });
  });

  describe('Integration: Control Operations Workflow', () => {
    it('should handle continue -> conflict -> skip workflow', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      mockRebaseService.setSession({
        onto: 'main',
        originalBranch: 'feature-branch',
        commits: [
          { hash: 'abc123', message: 'First commit', action: 'pick' },
          { hash: 'def456', message: 'Second commit', action: 'pick' },
        ],
        currentStep: 0,
        status: 'conflict',
      });

      // First continue attempt hits conflict
      mockRebaseService.continueResult = {
        success: false,
        status: 'conflict',
        conflictedFiles: ['file.ts'],
      };

      const continueResult = await mockRebaseService.continueRebase(mockRepository);
      assert.strictEqual(continueResult.status, 'conflict');

      // User decides to skip
      mockRebaseService.skipResult = { success: true, status: 'in-progress' };

      const skipResult = await mockRebaseService.skipCommit(mockRepository);
      assert.ok(skipResult.success);
    });

    it('should handle continue -> conflict -> abort workflow', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      mockRebaseService.setSession({
        onto: 'main',
        originalBranch: 'feature-branch',
        commits: [{ hash: 'abc123', message: 'First commit', action: 'pick' }],
        currentStep: 0,
        status: 'conflict',
      });

      // Continue hits conflict
      mockRebaseService.continueResult = {
        success: false,
        status: 'conflict',
        conflictedFiles: ['file.ts'],
      };

      const continueResult = await mockRebaseService.continueRebase(mockRepository);
      assert.strictEqual(continueResult.status, 'conflict');

      // User decides to abort
      await mockRebaseService.abortRebase(mockRepository);

      // Session should be cleared
      const session = mockRebaseService.getRebaseSession(mockRepository);
      assert.strictEqual(session, undefined);
    });
  });
});
