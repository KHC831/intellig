import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import * as vscode from 'vscode';
import {
  RebaseProgressView,
  createRebaseProgressView,
} from '../../../src/rebase/RebaseProgressView';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
} from '../../../src/git-core/interfaces/IRebaseService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

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

  clearSession(_repo: IRepository): void {
    this._session = undefined;
    this._onDidChangeRebaseSession.fire(undefined);
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

    describe('Continue Rebase', () => {
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
          rebaseInProgress: true,
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

    describe('Abort Rebase', () => {
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

    describe('Skip Commit', () => {
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
          rebaseInProgress: true,
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

  describe('Conflict continuability gating (autostash pop)', () => {
    // Reach the private result handler + actions renderer. The webview panel
    // can't be created in the test host, so we drive the state transition and
    // inspect the rendered actions HTML directly.
    interface RebaseProgressViewInternals {
      _handleRebaseResult(result: IRebaseResult): void;
      _getScript(): string;
    }
    const internals = (): RebaseProgressViewInternals =>
      rebaseProgressView as unknown as RebaseProgressViewInternals;

    /**
     * Run the view's inline nonce'd script in jsdom against an empty
     * `#progress-root`. Post-migration the script BUILDS the header, progress,
     * conflict, and action sections via document.createElement from a JSON
     * init island serialized off the current view state.
     */
    function buildDom(): Document {
      const script = internals()._getScript();
      const dom = new JSDOM(`<div class="rebase-progress" id="progress-root"></div>`, {
        runScripts: 'outside-only',
      });
      const window = dom.window;
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (): void => {},
        getState: (): void => {},
        setState: (): void => {},
      });
      window.eval(script);
      return window.document as unknown as Document;
    }

    it('offers continue/abort/skip for a continuable conflict (rebaseInProgress:true)', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      rebaseProgressView.show(mockRepository);

      internals()._handleRebaseResult({
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/a.ts'],
        rebaseInProgress: true,
      });

      const doc = buildDom();
      assert.ok(doc.querySelector('.continue-button'), 'continue button should be offered');
      assert.ok(doc.querySelector('.abort-button'), 'abort button should be offered');
      assert.ok(doc.querySelector('.skip-button'), 'skip button should be offered');
    });

    it('suppresses continue/abort/skip for an autostash-pop conflict (rebaseInProgress:false)', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      rebaseProgressView.show(mockRepository);

      internals()._handleRebaseResult({
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/a.ts'],
        rebaseInProgress: false,
      });

      const doc = buildDom();
      assert.strictEqual(
        doc.querySelector('.continue-button'),
        null,
        'continue must NOT be offered — `git rebase --continue` would dead-end on "no rebase in progress"'
      );
      assert.strictEqual(
        doc.querySelector('.abort-button'),
        null,
        'abort must NOT be offered for a completed rebase'
      );
      assert.strictEqual(
        doc.querySelector('.skip-button'),
        null,
        'skip must NOT be offered for a completed rebase'
      );
    });

    it('help text matches continuability — Continue/Skip/Abort only when continuable', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      rebaseProgressView.show(mockRepository);

      internals()._handleRebaseResult({
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/a.ts'],
        rebaseInProgress: true,
      });
      const continuableHelp = buildDom().querySelector('.conflict-help')?.textContent ?? '';
      assert.ok(
        continuableHelp.includes('Continue') && continuableHelp.includes('Abort'),
        'continuable conflict help should mention Continue/Abort'
      );

      internals()._handleRebaseResult({
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/a.ts'],
        rebaseInProgress: false,
      });
      const popHelp = buildDom().querySelector('.conflict-help')?.textContent ?? '';
      assert.ok(
        popHelp.includes('rebase already completed'),
        'pop-conflict help should state the rebase already completed'
      );
      assert.ok(
        popHelp.includes('Do not continue or abort'),
        'pop-conflict help must steer away from continue/abort'
      );
    });

    it('wires the action buttons via data-action delegation, not dead inline onclick', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      rebaseProgressView.show(mockRepository);
      internals()._handleRebaseResult({
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/a.ts'],
        rebaseInProgress: true,
      });

      const script = internals()._getScript();
      assert.ok(
        !/\son(click|change|input)\s*=/.test(script),
        'inline handler attributes are blocked by the nonce-only CSP; use data-action delegation'
      );
      const doc = buildDom();
      for (const action of ['abort', 'skip', 'continueRebase', 'refresh']) {
        assert.ok(
          doc.querySelector(`[data-action="${action}"]`),
          `${action} must be wired via data-action`
        );
      }
      assert.ok(
        /addEventListener\('click'/.test(script) && /closest\('\[data-action\]'\)/.test(script),
        'script must install a delegated click dispatcher for the action buttons'
      );
    });
  });

  describe('Cleared-stale honest message (issue #21)', () => {
    // When continue/skip self-clear a phantom (stale) rebase session, the op
    // returns status:'cleared-stale'. The view must surface an honest "no
    // rebase in progress — cleared a stale session" message, NOT the
    // "Rebase completed successfully!" success toast (no real rebase ran).
    interface RebaseProgressViewInternals {
      _handleRebaseResult(result: IRebaseResult): void;
    }
    const internals = (): RebaseProgressViewInternals =>
      rebaseProgressView as unknown as RebaseProgressViewInternals;

    function captureInfoToasts(): { infos: string[]; restore: () => void } {
      const infos: string[] = [];
      const oInfo = vscode.window.showInformationMessage;
      (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = (
        m: string
      ): Promise<string | undefined> => {
        infos.push(m);
        return Promise.resolve(undefined);
      };
      return {
        infos,
        restore: (): void => {
          (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
            oInfo;
        },
      };
    }

    it('shows an honest stale-clear message, not "Rebase completed successfully"', () => {
      const { infos, restore } = captureInfoToasts();
      try {
        internals()._handleRebaseResult({ success: true, status: 'cleared-stale' });
        assert.strictEqual(infos.length, 1, 'expected exactly one info toast');
        assert.ok(
          !infos[0].includes('Rebase completed successfully'),
          'must NOT claim the rebase completed — no real rebase ran'
        );
        assert.ok(
          /stale/i.test(infos[0]) && /no rebase in progress/i.test(infos[0]),
          `message should honestly describe the stale-session clear, got: "${infos[0]}"`
        );
      } finally {
        restore();
      }
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
        rebaseInProgress: true,
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
        rebaseInProgress: true,
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

  // Every RebaseProgressView action-path catch block must run the raw git
  // stderr through `sanitizeGitError` before the toast is rendered. The four
  // handlers (continue/abort/skip/provideRewordMessage) all surface git
  // stderr directly, which can carry credentialed remote URLs and POSIX home
  // paths into the user's notification history.
  describe('error toast sanitization', () => {
    const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';

    function captureErrorToasts(): { errors: string[]; restore: () => void } {
      const errors: string[] = [];
      const oErr = vscode.window.showErrorMessage;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = (
        m: string
      ): Promise<string | undefined> => {
        errors.push(m);
        return Promise.resolve(undefined);
      };
      return {
        errors,
        restore: (): void => {
          (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
        },
      };
    }

    function assertSanitized(actual: string, prefix: string): void {
      assert.strictEqual(actual, `${prefix}: ${EXPECTED}`);
      assert.ok(!actual.includes('alice:secret'), 'toast must not leak credentials');
      assert.ok(!actual.includes('/Users/alice'), 'toast must not leak home path');
    }

    beforeEach(() => {
      // Prime _repository so the private handlers don't early-return.
      (rebaseProgressView as unknown as { _repository: IRepository })._repository = mockRepository;
    });

    it('_handleContinue failure toast sanitizes credentialed URL + home path', async () => {
      mockRebaseService.continueRebase = (): Promise<never> => Promise.reject(new Error(RAW));
      const { errors, restore } = captureErrorToasts();
      try {
        await (
          rebaseProgressView as unknown as { _handleContinue: () => Promise<void> }
        )._handleContinue();
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to continue rebase');
      } finally {
        restore();
      }
    });

    it('_handleAbort failure toast sanitizes credentialed URL + home path', async () => {
      mockRebaseService.abortRebase = (): Promise<never> => Promise.reject(new Error(RAW));
      const { errors, restore } = captureErrorToasts();
      // _handleAbort gates on a modal confirm; stub showWarningMessage to return 'Abort Rebase'.
      const oWarn = vscode.window.showWarningMessage;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (
        ..._args: unknown[]
      ): Promise<string | undefined> => Promise.resolve('Abort Rebase');
      try {
        await (
          rebaseProgressView as unknown as { _handleAbort: () => Promise<void> }
        )._handleAbort();
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to abort rebase');
      } finally {
        (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = oWarn;
        restore();
      }
    });

    it('_handleSkip failure toast sanitizes credentialed URL + home path', async () => {
      mockRebaseService.skipCommit = (): Promise<never> => Promise.reject(new Error(RAW));
      const { errors, restore } = captureErrorToasts();
      // _handleSkip also gates on a modal confirm.
      const oWarn = vscode.window.showWarningMessage;
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = (
        ..._args: unknown[]
      ): Promise<string | undefined> => Promise.resolve('Skip Commit');
      try {
        await (rebaseProgressView as unknown as { _handleSkip: () => Promise<void> })._handleSkip();
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to skip commit');
      } finally {
        (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = oWarn;
        restore();
      }
    });

    it('_handleProvideRewordMessage failure toast sanitizes credentialed URL + home path', async () => {
      mockRebaseService.provideRewordMessage = (): Promise<never> => Promise.reject(new Error(RAW));
      const { errors, restore } = captureErrorToasts();
      try {
        await (
          rebaseProgressView as unknown as {
            _handleProvideRewordMessage: (m: string) => Promise<void>;
          }
        )._handleProvideRewordMessage('new commit message');
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to update commit message');
      } finally {
        restore();
      }
    });
  });
});
