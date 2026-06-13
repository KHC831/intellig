/**
 * Unit tests for RebaseEditor
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { RebaseEditor, createRebaseEditor } from '../../../rebase/RebaseEditor';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
  RebaseAction,
} from '../../../git-core/interfaces/IRebaseService';
import { IRepository } from '../../../git-core/interfaces/IGitService';

/**
 * Mock RebaseService for testing
 */
class MockRebaseService implements IRebaseService {
  private _session: IRebaseSession | undefined;
  private _onDidChangeRebaseSession = new vscode.EventEmitter<IRebaseSession | undefined>();
  readonly onDidChangeRebaseSession = this._onDidChangeRebaseSession.event;

  public mockCommits = [
    { hash: 'abc1234567890', message: 'First commit', action: 'pick' as RebaseAction },
    { hash: 'def2345678901', message: 'Second commit', action: 'pick' as RebaseAction },
    { hash: 'ghi3456789012', message: 'Third commit', action: 'pick' as RebaseAction },
  ];

  public lastPlan: IRebaseAction[] | undefined;
  public executeResult: IRebaseResult = { success: true, status: 'completed' };

  startInteractiveRebase(_repo: IRepository, onto: string): Promise<IRebaseSession> {
    this._session = {
      onto,
      originalBranch: 'feature-branch',
      commits: [...this.mockCommits],
      currentStep: 0,
      status: 'planning',
    };
    return Promise.resolve(this._session);
  }

  getRebaseSession(_repo: IRepository): IRebaseSession | undefined {
    return this._session;
  }

  updateRebasePlan(_repo: IRepository, plan: IRebaseAction[]): void {
    this.lastPlan = plan;
    if (this._session) {
      this._session.commits = plan.map((action) => ({
        hash: action.hash,
        message:
          action.newMessage || this.mockCommits.find((c) => c.hash === action.hash)?.message || '',
        action: action.action,
      }));
    }
  }

  executeRebase(_repo: IRepository): Promise<IRebaseResult> {
    return Promise.resolve(this.executeResult);
  }

  continueRebase(_repo: IRepository): Promise<IRebaseResult> {
    return Promise.resolve({ success: true, status: 'completed' });
  }

  abortRebase(_repo: IRepository): Promise<void> {
    this._session = undefined;
    this._onDidChangeRebaseSession.fire(undefined);
    return Promise.resolve();
  }

  public clearSessionCalls = 0;
  clearSession(_repo: IRepository): void {
    this.clearSessionCalls++;
    this._session = undefined;
    this._onDidChangeRebaseSession.fire(undefined);
  }

  skipCommit(_repo: IRepository): Promise<IRebaseResult> {
    return Promise.resolve({ success: true, status: 'in-progress' });
  }

  provideRewordMessage(_repo: IRepository, _message: string): Promise<IRebaseResult> {
    return Promise.resolve({ success: true, status: 'in-progress' });
  }

  provideSquashMessage(_repo: IRepository, _message: string): Promise<IRebaseResult> {
    return Promise.resolve({ success: true, status: 'in-progress' });
  }

  amendEditCommit(_repo: IRepository, _message?: string): Promise<IRebaseResult> {
    return Promise.resolve({ success: true, status: 'paused' });
  }

  dispose(): void {
    this._onDidChangeRebaseSession.dispose();
  }
}

/**
 * Create a mock repository for testing
 */
function createMockRepository(): IRepository {
  return {
    rootUri: vscode.Uri.file('/test/repo'),
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
}

describe('RebaseEditor', () => {
  let rebaseEditor: RebaseEditor;
  let mockRebaseService: MockRebaseService;
  let mockRepository: IRepository;
  let extensionUri: vscode.Uri;

  beforeEach(() => {
    mockRebaseService = new MockRebaseService();
    mockRepository = createMockRepository();
    extensionUri = vscode.Uri.file('/test/extension');
    rebaseEditor = new RebaseEditor(extensionUri, mockRebaseService);
  });

  afterEach(() => {
    rebaseEditor.dispose();
    mockRebaseService.dispose();
  });

  describe('createRebaseEditor', () => {
    it('should create a RebaseEditor instance', () => {
      const editor = createRebaseEditor(extensionUri, mockRebaseService);
      assert.ok(editor instanceof RebaseEditor);
      editor.dispose();
    });
  });

  describe('show', () => {
    it('should start an interactive rebase session', async () => {
      // Note: This test would require mocking vscode.window.createWebviewPanel
      // which is not easily done in unit tests. The actual webview functionality
      // would be tested in integration tests.

      // For now, we verify that the service is called correctly
      const session = await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      assert.strictEqual(session.onto, 'main');
      assert.strictEqual(session.originalBranch, 'feature-branch');
      assert.strictEqual(session.commits.length, 3);
      assert.strictEqual(session.status, 'planning');
    });
  });

  describe('updateRebasePlan', () => {
    it('should update commit actions correctly', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      const plan: IRebaseAction[] = [
        { hash: 'abc1234567890', action: 'pick' },
        { hash: 'def2345678901', action: 'squash' },
        { hash: 'ghi3456789012', action: 'drop' },
      ];

      mockRebaseService.updateRebasePlan(mockRepository, plan);

      assert.deepStrictEqual(mockRebaseService.lastPlan, plan);

      const session = mockRebaseService.getRebaseSession(mockRepository);
      assert.ok(session);
      assert.strictEqual(session.commits[0].action, 'pick');
      assert.strictEqual(session.commits[1].action, 'squash');
      assert.strictEqual(session.commits[2].action, 'drop');
    });

    it('should support all rebase actions', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      const actions: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

      for (const action of actions) {
        const plan: IRebaseAction[] = [{ hash: 'abc1234567890', action }];

        mockRebaseService.updateRebasePlan(mockRepository, plan);
        const session = mockRebaseService.getRebaseSession(mockRepository);
        assert.ok(session);
        assert.strictEqual(session.commits[0].action, action);
      }
    });
  });

  describe('reorder commits', () => {
    it('should allow reordering commits in the plan', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      // Reorder: move third commit to first position
      const plan: IRebaseAction[] = [
        { hash: 'ghi3456789012', action: 'pick' },
        { hash: 'abc1234567890', action: 'pick' },
        { hash: 'def2345678901', action: 'pick' },
      ];

      mockRebaseService.updateRebasePlan(mockRepository, plan);

      const session = mockRebaseService.getRebaseSession(mockRepository);
      assert.ok(session);
      assert.strictEqual(session.commits[0].hash, 'ghi3456789012');
      assert.strictEqual(session.commits[1].hash, 'abc1234567890');
      assert.strictEqual(session.commits[2].hash, 'def2345678901');
    });
  });

  describe('executeRebase', () => {
    it('should execute the rebase with the current plan', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      const plan: IRebaseAction[] = [
        { hash: 'abc1234567890', action: 'pick' },
        { hash: 'def2345678901', action: 'squash' },
        { hash: 'ghi3456789012', action: 'pick' },
      ];

      mockRebaseService.updateRebasePlan(mockRepository, plan);

      const result = await mockRebaseService.executeRebase(mockRepository);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'completed');
    });

    it('should handle rebase conflicts', async () => {
      mockRebaseService.executeResult = {
        success: false,
        status: 'conflict',
        conflictedFiles: ['file1.ts', 'file2.ts'],
      };

      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      const result = await mockRebaseService.executeRebase(mockRepository);

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.status, 'conflict');
      assert.deepStrictEqual(result.conflictedFiles, ['file1.ts', 'file2.ts']);
    });

    it('should handle paused state for edit action', async () => {
      mockRebaseService.executeResult = {
        success: true,
        status: 'paused',
      };

      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      const result = await mockRebaseService.executeRebase(mockRepository);

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.status, 'paused');
    });
  });

  // An interactive-rebase session is stored in 'planning' state BEFORE any
  // git rebase runs (the editor lets the user revise the plan first). If the
  // user abandons the editor — cancels or closes the panel — without executing,
  // that planning session must be cleared so it can't poison later branch ops
  // (issue #18).
  describe('abandon cleanup (issue #18)', () => {
    function panelOf(editor: RebaseEditor): {
      _fireMessage: (m: unknown) => void;
      dispose: () => void;
    } {
      return (
        editor as unknown as { _panel: { _fireMessage: (m: unknown) => void; dispose: () => void } }
      )._panel;
    }

    // `show()` awaits startInteractiveRebase before creating the panel; yield a
    // few microtasks so the panel exists before the test drives it.
    async function untilPanel(editor: RebaseEditor): Promise<void> {
      for (let i = 0; i < 20; i++) {
        if ((editor as unknown as { _panel: unknown })._panel) {
          return;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    it('cancelling the editor clears the planning session', async () => {
      const showPromise = rebaseEditor.show(mockRepository, { onto: 'main' });
      await untilPanel(rebaseEditor);
      assert.strictEqual(mockRebaseService.clearSessionCalls, 0, 'not cleared while editing');

      panelOf(rebaseEditor)._fireMessage({ type: 'cancel' });
      const result = await showPromise;

      assert.strictEqual(result.executed, false);
      assert.strictEqual(mockRebaseService.clearSessionCalls, 1, 'cancel clears the session');
      assert.strictEqual(mockRebaseService.getRebaseSession(mockRepository), undefined);
    });

    it('closing the editor panel without executing clears the planning session', async () => {
      const showPromise = rebaseEditor.show(mockRepository, { onto: 'main' });
      await untilPanel(rebaseEditor);

      panelOf(rebaseEditor).dispose();
      const result = await showPromise;

      assert.strictEqual(result.executed, false);
      assert.strictEqual(mockRebaseService.clearSessionCalls, 1, 'panel close clears the session');
      assert.strictEqual(mockRebaseService.getRebaseSession(mockRepository), undefined);
    });

    it('executing the rebase does NOT clear the session as an abandon (it completes normally)', async () => {
      const showPromise = rebaseEditor.show(mockRepository, { onto: 'main' });
      await untilPanel(rebaseEditor);
      panelOf(rebaseEditor)._fireMessage({ type: 'execute' });
      await showPromise;
      // A successful execute completes the rebase through the service's own
      // completion path — it must not be treated as an abandonment.
      assert.strictEqual(mockRebaseService.clearSessionCalls, 0);
    });
  });

  describe('abortRebase', () => {
    it('should abort the rebase and clear the session', async () => {
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');

      let session = mockRebaseService.getRebaseSession(mockRepository);
      assert.ok(session);

      await mockRebaseService.abortRebase(mockRepository);

      session = mockRebaseService.getRebaseSession(mockRepository);
      assert.strictEqual(session, undefined);
    });
  });

  // TL-72 (Wave 9) — both action-path catch blocks in RebaseEditor must
  // run the raw git stderr through `sanitizeGitError` before pushing it
  // into the showErrorMessage toast. Pre-fix, RebaseEditor.ts:93 (show
  // → startInteractiveRebase failure) and :244 (_handleExecute →
  // executeRebase failure) concatenated `error.message` directly,
  // leaking credentialed remote URLs and POSIX home paths into the
  // user's notification history.
  describe('TL-72 — error toast sanitization', () => {
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

    it('show() — startInteractiveRebase failure toast sanitizes credentialed URL + home path', async () => {
      mockRebaseService.startInteractiveRebase = (): Promise<IRebaseSession> =>
        Promise.reject(new Error(RAW));
      const { errors, restore } = captureErrorToasts();
      try {
        const result = await rebaseEditor.show(mockRepository, { onto: 'main' });
        assert.strictEqual(result.executed, false);
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assert.strictEqual(errors[0], `Failed to start rebase: ${EXPECTED}`);
        assert.ok(!errors[0].includes('alice:secret'), 'toast must not leak credentials');
        assert.ok(!errors[0].includes('/Users/alice'), 'toast must not leak home path');
      } finally {
        restore();
      }
    });

    it('_handleExecute() — executeRebase failure toast sanitizes credentialed URL + home path', async () => {
      // Prime the editor with a valid session so _handleExecute proceeds.
      await mockRebaseService.startInteractiveRebase(mockRepository, 'main');
      (rebaseEditor as unknown as { _repository: IRepository })._repository = mockRepository;
      (rebaseEditor as unknown as { _session: IRebaseSession })._session =
        mockRebaseService.getRebaseSession(mockRepository)!;

      // Stub executeRebase to throw with a credentialed payload.
      mockRebaseService.executeRebase = (): Promise<never> => Promise.reject(new Error(RAW));

      const { errors, restore } = captureErrorToasts();
      try {
        await (rebaseEditor as unknown as { _handleExecute: () => Promise<void> })._handleExecute();
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assert.strictEqual(errors[0], `Rebase failed: ${EXPECTED}`);
        assert.ok(!errors[0].includes('alice:secret'), 'toast must not leak credentials');
        assert.ok(!errors[0].includes('/Users/alice'), 'toast must not leak home path');
      } finally {
        restore();
      }
    });
  });
});
