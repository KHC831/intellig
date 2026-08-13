/**
 * Unit tests for RebaseEditor
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { initIslandHtml } from '../../../src/utils/webviewInit';
import * as vscode from 'vscode';
import {
  RebaseEditor,
  createRebaseEditor,
  IRebaseEditorResult,
} from '../../../src/rebase/RebaseEditor';
import {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseCommit,
  IRebaseResult,
  RebaseAction,
} from '../../../src/git-core/interfaces/IRebaseService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

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

  isManagingRebase(_repo: IRepository): boolean {
    return this._session !== undefined;
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

  abortRebase(_repo: IRepository): Promise<{ autostashParked: boolean }> {
    this._session = undefined;
    this._onDidChangeRebaseSession.fire(undefined);
    return Promise.resolve({ autostashParked: false });
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

const _rebaseHarnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (_rebaseHarnesses.length > 0) {
    _rebaseHarnesses.pop()?.dispose();
  }
});

const rebaseEntrySource = (): string =>
  fs.readFileSync(path.join(process.cwd(), 'src/rebase/webview/rebaseEditor.ts'), 'utf8');

function bootRebaseEditor(ed: unknown): Document {
  const init = (ed as { _getInit(p?: boolean): unknown })._getInit();
  const bodyHtml = '<div class="rebase-editor" id="rebase-root"></div>' + initIslandHtml(init);
  const h = bootWebviewEntry('rebase/webview/rebaseEditor', { bodyHtml });
  _rebaseHarnesses.push(h);
  return h.document;
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

  describe('CSP-safe event wiring (no inline handlers)', () => {
    interface Internals {
      _getInit(): unknown;
      _session?: { onto: string; originalBranch: string; commits: IRebaseCommit[] };
    }
    const internals = (): Internals => rebaseEditor as unknown as Internals;

    /**
     * Run the editor's inline nonce'd script in jsdom against the empty
     * `#rebase-root` skeleton. Post-migration contract: the script BUILDS the
     * header, commit rows, and footer via document.createElement.
     */
    const buildDom = (): Document => bootRebaseEditor(rebaseEditor);

    it('footer buttons build with data-action and no inline onclick', () => {
      const script = rebaseEntrySource();
      assert.ok(!/\son(click|change|input)\s*=/.test(script), 'no inline handler attributes');
      const doc = buildDom();
      assert.ok(doc.querySelector('button[data-action="cancel"]'), 'Cancel uses data-action');
      assert.ok(
        doc.querySelector('button[data-action="execute"]'),
        'Start Rebase uses data-action'
      );
    });

    it('commit row builds the action dropdown + reword textarea, each keyed by data-hash', () => {
      // Seed a reword commit so the row renders its message editor.
      internals()._session = {
        onto: 'main',
        originalBranch: 'feature',
        commits: [{ hash: 'abc1234567890', message: 'msg', action: 'reword', newMessage: '' }],
      };
      const doc = buildDom();
      const select = doc.querySelector('.action-dropdown');
      assert.ok(select, 'action dropdown built');
      assert.strictEqual(
        select.getAttribute('data-hash'),
        'abc1234567890',
        'select keeps data-hash'
      );
      const textarea = doc.querySelector('.reword-message-input');
      assert.ok(textarea, 'reword textarea built');
      assert.strictEqual(
        textarea.getAttribute('data-hash'),
        'abc1234567890',
        'reword textarea keeps data-hash'
      );
    });

    it('script wires dropdowns/textareas via listeners + delegated button clicks', () => {
      const script = rebaseEntrySource();
      assert.ok(
        /action-dropdown[\s\S]*?addEventListener\('change'/.test(script),
        'action dropdowns must wire change via addEventListener'
      );
      assert.ok(
        /reword-message-input[\s\S]*?addEventListener\('input'/.test(script),
        'reword textareas must wire input via addEventListener'
      );
      assert.ok(
        /closest(?:<[^>]*>)?\('\[data-action\]'\)/.test(script),
        'footer buttons must route through a delegated click dispatcher'
      );
    });
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

  describe('message box seeding and override lifecycle', () => {
    interface MessageInternals {
      _session?: {
        onto: string;
        originalBranch: string;
        commits: IRebaseCommit[];
        currentStep: number;
        status: string;
      };
      _getInit(): { commits: Array<{ hash: string; action: string; rewordValue: string }> };
      _handleUpdateAction(hash: string, action: RebaseAction): void;
      _handleUpdateMessage(hash: string, message: string): void;
    }
    const internals = (): MessageInternals => rebaseEditor as unknown as MessageInternals;
    const HASH_A = 'a'.repeat(40);
    const HASH_B = 'b'.repeat(40);

    beforeEach(() => {
      internals()._session = {
        onto: 'main',
        originalBranch: 'feature',
        currentStep: 0,
        status: 'planning',
        commits: [
          { hash: HASH_A, message: 'A message', action: 'reword' },
          { hash: HASH_B, message: 'B message', action: 'squash' },
        ] as IRebaseCommit[],
      };
    });

    it('seeds reword rows with their own message and squash rows empty', () => {
      // A blank squash box means "auto-combine both messages" (the git squash
      // rule); seeding it with this commit's own message turned any touch into
      // an override that silently dropped the fold target's message.
      const init = internals()._getInit();
      assert.strictEqual(init.commits[0].rewordValue, 'A message');
      assert.strictEqual(init.commits[1].rewordValue, '');
    });

    it('seeds reword rows with the FULL message when the session carries one', () => {
      // Session commits split the row label (subject) from the full message;
      // a reword box seeded from the subject alone drops the commit body the
      // moment the user submits any edit.
      internals()._session!.commits = [
        {
          hash: HASH_A,
          message: 'A subject',
          fullMessage: 'A subject\n\nA body line',
          action: 'reword',
        },
      ] as IRebaseCommit[];
      const init = internals()._getInit();
      assert.strictEqual(init.commits[0].rewordValue, 'A subject\n\nA body line');
    });

    it('keeps a typed message in the seed for re-renders', () => {
      internals()._handleUpdateMessage(HASH_B, 'typed combined message');
      const init = internals()._getInit();
      assert.strictEqual(init.commits[1].rewordValue, 'typed combined message');
    });

    it('clears a typed message when the action changes', () => {
      // reword and squash boxes carry different semantics (new own message vs
      // combined fold message) — a message typed under one action must not
      // silently apply under the other.
      internals()._handleUpdateMessage(HASH_A, 'typed for reword');
      internals()._handleUpdateAction(HASH_A, 'squash');
      const init = internals()._getInit();
      assert.strictEqual(init.commits[0].rewordValue, '');
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
        rebaseInProgress: true,
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
  describe('webview→host plan validation (injection hardening)', () => {
    function panelOf(editor: RebaseEditor): { _fireMessage: (m: unknown) => void } {
      return (editor as unknown as { _panel: { _fireMessage: (m: unknown) => void } })._panel;
    }
    function sessionOf(editor: RebaseEditor): IRebaseSession {
      return (editor as unknown as { _session: IRebaseSession })._session;
    }
    async function untilPanel(editor: RebaseEditor): Promise<void> {
      for (let i = 0; i < 20; i++) {
        if ((editor as unknown as { _panel: unknown })._panel) {
          return;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    it('ignores an updateAction with an action outside the six commands', async () => {
      const showPromise = rebaseEditor.show(mockRepository, { onto: 'main' });
      await untilPanel(rebaseEditor);

      panelOf(rebaseEditor)._fireMessage({
        type: 'updateAction',
        hash: 'abc1234567890',
        action: 'exec evil',
      });

      const commit = sessionOf(rebaseEditor).commits.find((c) => c.hash === 'abc1234567890');
      assert.strictEqual(commit?.action, 'pick', 'forged action must not be stored');
      panelOf(rebaseEditor)._fireMessage({ type: 'cancel' });
      await showPromise;
    });
  });

  describe('_handleReorder — bounds check (R3-3)', () => {
    // Re-declare the same helpers used in the injection-hardening suite.
    function panelOf(editor: RebaseEditor): { _fireMessage: (m: unknown) => void } {
      return (editor as unknown as { _panel: { _fireMessage: (m: unknown) => void } })._panel;
    }
    function sessionOf(editor: RebaseEditor): IRebaseSession {
      return (editor as unknown as { _session: IRebaseSession })._session;
    }
    async function untilPanel(editor: RebaseEditor): Promise<void> {
      for (let i = 0; i < 20; i++) {
        if ((editor as unknown as { _panel: unknown })._panel) {
          return;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    it('ignores a reorder with a negative fromIndex', async () => {
      // A forged webview message with fromIndex=-1 passes -1 to splice(),
      // which splices from the end and inserts `undefined` in position, corrupting the plan.
      const showPromise = rebaseEditor.show(mockRepository, { onto: 'main' });
      await untilPanel(rebaseEditor);
      const before = sessionOf(rebaseEditor).commits.map((c) => c.hash);

      panelOf(rebaseEditor)._fireMessage({ type: 'reorder', fromIndex: -1, toIndex: 0 });

      assert.deepStrictEqual(
        sessionOf(rebaseEditor).commits.map((c) => c.hash),
        before,
        'negative fromIndex must be rejected; session must be unchanged'
      );
      panelOf(rebaseEditor)._fireMessage({ type: 'cancel' });
      await showPromise;
    });

    it('ignores a reorder with an out-of-range toIndex', async () => {
      // toIndex >= commits.length is also out of range; splice() at that position
      // would silently append to the end but the intent may corrupt ordering.
      const showPromise = rebaseEditor.show(mockRepository, { onto: 'main' });
      await untilPanel(rebaseEditor);
      const before = sessionOf(rebaseEditor).commits.map((c) => c.hash);

      panelOf(rebaseEditor)._fireMessage({ type: 'reorder', fromIndex: 0, toIndex: 999 });

      assert.deepStrictEqual(
        sessionOf(rebaseEditor).commits.map((c) => c.hash),
        before,
        'out-of-range toIndex must be rejected; session must be unchanged'
      );
      panelOf(rebaseEditor)._fireMessage({ type: 'cancel' });
      await showPromise;
    });

    it('still applies a valid in-range reorder', async () => {
      const showPromise = rebaseEditor.show(mockRepository, { onto: 'main' });
      await untilPanel(rebaseEditor);

      // Move third commit (index 2) to index 0.
      panelOf(rebaseEditor)._fireMessage({ type: 'reorder', fromIndex: 2, toIndex: 0 });

      const commits = sessionOf(rebaseEditor).commits;
      assert.strictEqual(
        commits[0].hash,
        'ghi3456789012',
        'valid reorder must still move the commit'
      );
      panelOf(rebaseEditor)._fireMessage({ type: 'cancel' });
      await showPromise;
    });
  });

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

    it('an empty-commits rebase clears the planning session on the early return (no panel)', async () => {
      // Rebasing onto an up-to-date / ancestor target yields 0 commits. show()
      // returns early before the panel + onDidDispose cleanup are wired, so the
      // planning session (stored by startInteractiveRebase before any git ran)
      // would leak — the exact #18 phantom — unless the early return clears it.
      mockRebaseService.mockCommits = [];

      const result = await rebaseEditor.show(mockRepository, { onto: 'main' });

      assert.strictEqual(result.executed, false);
      assert.strictEqual(
        mockRebaseService.getRebaseSession(mockRepository),
        undefined,
        'empty-commits early return must clear the planning session'
      );
      assert.strictEqual(mockRebaseService.clearSessionCalls, 1);
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

  // M1 + M3 — paused / in-progress handoff to the Rebase Progress panel.
  //
  // M1: the paused toast tells the user to "use the Rebase Progress panel",
  // but nothing ever opened it (the view was orphaned). The paused flow must
  // actually `.show()` the panel.
  //
  // M3: a `status:'in-progress'` success result (reachable on an inline-amend
  // exec failure that leaves the rebase mid-flight) hit neither the
  // 'completed' nor 'paused' branch — so no toast fired and the editor promise
  // never resolved, hanging the RebaseDialog (`_busy` stuck) forever. It must
  // surface a toast and resolve the promise.
  describe('M1/M3 — paused & in-progress handoff', () => {
    function primeEditor(editor: RebaseEditor, capture: (r: IRebaseEditorResult) => void): void {
      (editor as unknown as { _repository: IRepository })._repository = mockRepository;
      (editor as unknown as { _session: IRebaseSession })._session =
        mockRebaseService.getRebaseSession(mockRepository) ?? {
          onto: 'main',
          originalBranch: 'feature',
          commits: [...mockRebaseService.mockCommits],
          currentStep: 0,
          status: 'planning',
        };
      (editor as unknown as { _resolvePromise: (r: IRebaseEditorResult) => void })._resolvePromise =
        capture;
    }

    function captureInfoToasts(): { infos: string[]; restore: () => void } {
      const infos: string[] = [];
      const orig = vscode.window.showInformationMessage;
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
            orig;
        },
      };
    }

    it('M1: a paused rebase opens the Rebase Progress panel', async () => {
      let shownRepo: IRepository | undefined;
      const progressView = {
        show: (repo: IRepository): void => {
          shownRepo = repo;
        },
      };
      const editor = createRebaseEditor(extensionUri, mockRebaseService, progressView);
      mockRebaseService.executeResult = { success: true, status: 'paused' };

      let resolved: IRebaseEditorResult | undefined;
      primeEditor(editor, (r) => {
        resolved = r;
      });

      const t = captureInfoToasts();
      try {
        await (editor as unknown as { _handleExecute: () => Promise<void> })._handleExecute();
      } finally {
        t.restore();
        editor.dispose();
      }

      assert.strictEqual(shownRepo, mockRepository, 'paused flow must .show() the progress panel');
      assert.ok(resolved?.executed, 'paused flow must resolve the editor promise');
    });

    it('M3: an in-progress result surfaces a toast and resolves (no hang)', async () => {
      const editor = createRebaseEditor(extensionUri, mockRebaseService);
      mockRebaseService.executeResult = { success: true, status: 'in-progress' };

      let resolved: IRebaseEditorResult | undefined;
      primeEditor(editor, (r) => {
        resolved = r;
      });

      const t = captureInfoToasts();
      try {
        await (editor as unknown as { _handleExecute: () => Promise<void> })._handleExecute();
      } finally {
        t.restore();
        editor.dispose();
      }

      assert.ok(
        resolved !== undefined,
        'in-progress result MUST resolve the promise (else the dialog hangs forever)'
      );
      assert.ok(resolved?.executed, 'resolution should mark the rebase as executed');
      assert.strictEqual(t.infos.length >= 1, true, 'in-progress must surface a toast');
    });
  });

  // Conflict handoff — the SAME GitRebaseProcess conflict loop serves
  // IntelliJ's interactive rebase: a conflict opens the conflict resolver
  // dialog immediately (git4idea GitRebaseProcess.java:317-319). The editor
  // must hand the executed-plan conflict to the resolve dialog with the
  // rebaseInProgress flag mapped verbatim onto the continue/abort
  // affordances, exactly like _runHistoryRewrite's outcome switch.
  describe('conflict handoff — resolve dialog opens', () => {
    interface DialogCall {
      conflicts: { path: string; resolved: boolean }[];
      options: { operation: string; canAbort?: boolean; canContinue?: boolean };
    }

    function makeConflictHarness(executeResult: IRebaseResult): {
      editor: RebaseEditor;
      dialogCalls: DialogCall[];
      run: () => Promise<void>;
    } {
      const dialogCalls: DialogCall[] = [];
      const conflictSvc = {
        openResolveConflictsDialog: async (
          _repo: IRepository,
          conflicts: { path: string; resolved: boolean }[],
          options: { operation: string; canAbort?: boolean; canContinue?: boolean }
        ): Promise<void> => {
          dialogCalls.push({ conflicts, options });
        },
      };
      const editor = createRebaseEditor(
        extensionUri,
        mockRebaseService,
        undefined,
        conflictSvc as never
      );
      mockRebaseService.executeResult = executeResult;
      (editor as unknown as { _repository: IRepository })._repository = mockRepository;
      (editor as unknown as { _session: IRebaseSession })._session = {
        onto: 'main',
        originalBranch: 'feature',
        commits: [...mockRebaseService.mockCommits],
        currentStep: 0,
        status: 'planning',
      };
      (editor as unknown as { _resolvePromise: unknown })._resolvePromise = (): void => undefined;
      return {
        editor,
        dialogCalls,
        run: () => (editor as unknown as { _handleExecute: () => Promise<void> })._handleExecute(),
      };
    }

    it('a live conflict opens the dialog with Continue/Abort affordances', async () => {
      const h = makeConflictHarness({
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/a.ts', 'src/b.ts'],
        rebaseInProgress: true,
      });
      try {
        await h.run();
      } finally {
        h.editor.dispose();
      }

      assert.strictEqual(h.dialogCalls.length, 1, 'the resolve dialog must open');
      assert.strictEqual(h.dialogCalls[0].options.operation, 'rebase');
      assert.strictEqual(h.dialogCalls[0].options.canContinue, true);
      assert.strictEqual(h.dialogCalls[0].options.canAbort, true);
      assert.deepStrictEqual(
        h.dialogCalls[0].conflicts.map((c) => c.path),
        ['src/a.ts', 'src/b.ts']
      );
    });

    it('a terminal autostash-pop conflict renders resolve-only (no continue/abort)', async () => {
      const h = makeConflictHarness({
        success: false,
        status: 'conflict',
        conflictedFiles: ['src/a.ts'],
        rebaseInProgress: false,
      });
      try {
        await h.run();
      } finally {
        h.editor.dispose();
      }

      assert.strictEqual(h.dialogCalls.length, 1);
      assert.strictEqual(h.dialogCalls[0].options.canContinue, false);
      assert.strictEqual(h.dialogCalls[0].options.canAbort, false);
    });
  });

  // Both action-path catch blocks in RebaseEditor must run the raw git
  // stderr through `sanitizeGitError` before pushing it into the
  // showErrorMessage toast. The two failure paths (startInteractiveRebase
  // failure and _handleExecute → executeRebase failure) surface git stderr
  // that can carry credentialed remote URLs and POSIX home paths into the
  // user's notification history.
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

  // M2 follow-up — with GIT_EDITOR suppressed during executeRebase, a blank
  // reword/squash no longer opens an external editor. The textarea placeholder
  // must NOT promise "edit interactively" (a regression for users with
  // core.editor=code --wait, and contrary to git4idea's in-UI message
  // collection); it must state the real blank-handling instead.
  describe('M2 follow-up — blank reword/squash affordance text', () => {
    function placeholderFor(action: RebaseAction): string {
      // Seed a single commit of the given action, build the DOM via the inline
      // script, and read the reword textarea's placeholder.
      (
        editor as unknown as {
          _session?: { onto: string; originalBranch: string; commits: unknown[] };
        }
      )._session = {
        onto: 'main',
        originalBranch: 'feature',
        commits: [{ hash: 'abc1234567890', message: 'orig', action }],
      };
      const doc = bootRebaseEditor(editor);
      const ta = doc.querySelector('.reword-message-input');
      return ta?.getAttribute('placeholder') ?? '';
    }

    let editor: RebaseEditor;
    beforeEach(() => {
      editor = createRebaseEditor(extensionUri, mockRebaseService);
    });
    afterEach(() => {
      editor.dispose();
    });

    it('reword placeholder does not promise an interactive editor and says it keeps the original', () => {
      const p = placeholderFor('reword');
      assert.ok(!/interactiv/i.test(p), `must not promise interactive editing; got: ${p}`);
      assert.match(p, /keep the original/i);
    });

    it('squash placeholder does not promise an interactive editor and says it auto-combines', () => {
      const p = placeholderFor('squash');
      assert.ok(!/interactiv/i.test(p), `must not promise interactive editing; got: ${p}`);
      assert.match(p, /auto-combine/i);
    });
  });
});
