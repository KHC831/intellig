/**
 * Unit tests for `ResolveConflictsDialog` + `ConflictResolutionService`
 * extensions added in (a).
 *
 * Coverage:
 * - Dialog renders file list matching the conflicts input.
 * - `acceptYours` / `acceptTheirs` dispatch to
 *   `ConflictResolutionService.acceptCurrent` / `acceptIncoming`.
 * - `openMergeView` delegates to `IMergeView.show`.
 * - `MergeView.onDidResolve` flips the row status to resolved.
 * - `Continue` stays disabled until every row is resolved.
 * - Continue dispatches the correct git op per `opContext.operation`.
 * - Abort dispatches the correct git op per `opContext.operation`.
 * - `canAbort: false` hides the Abort button.
 * - Every op-context routes correctly (merge / rebase / cherryPick / revert /
 *   unshelve).
 * - State-file watcher sets `intellig.conflicts.active` when MERGE_HEAD present.
 * - State-file watcher clears the context key when MERGE_HEAD is gone.
 * - Feature flag `intellig.autoOpenResolveConflictsDialog = false` suppresses
 *   the dialog but still publishes the context key.
 */

/*
 * Stub factories synthesise IGitService / IMergeView / IConflictResolutionService
 * implementations whose member signatures return `Promise<T>`; no-await stub
 * bodies are intentional here.
 */

import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import { ResolveConflictsDialog } from '../../../src/conflicts/ResolveConflictsDialog';
import type { IConflictOpContext } from '../../../src/conflicts/interfaces/IConflictResolutionService';
import type { IMergeView, IMergeState } from '../../../src/conflicts/interfaces/IMergeView';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { setMockConfigValue, resetMockConfiguration } from '../../mocks/vscode';

/**
 * Factory for a minimal mock `ExtensionContext` — mirrors the helper used
 * elsewhere in the unit-test suite.
 */
function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: {} as vscode.Memento,
    globalState: {} as vscode.Memento,
    extensionPath: '/tmp/ext',
    storagePath: undefined,
    globalStoragePath: '/tmp/global',
    logPath: '/tmp/log',
    extensionUri: vscode.Uri.file('/tmp/ext'),
    storageUri: undefined,
    globalStorageUri: vscode.Uri.file('/tmp/global'),
    logUri: vscode.Uri.file('/tmp/log'),
    extensionMode: 3,
    asAbsolutePath: (p: string): string => `/tmp/ext/${p}`,
  } as unknown as vscode.ExtensionContext;
}

/**
 * Build a repo rooted at a temp dir so the state-file watcher has a real
 * `.git` directory to poll.
 */
function makeRepoInTmp(): { repo: IRepository; gitDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-rc-'));
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir);
  const repo: IRepository = {
    rootUri: vscode.Uri.file(root),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
  return {
    repo,
    gitDir,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Minimal mock merge view that records `show(path)` calls and exposes a fire
 * helper so tests can simulate `onDidResolve`.
 */
function makeMockMergeView(): IMergeView & {
  _showArgs: string[];
  _fireResolve: (filePath: string) => void;
} {
  const emitter = new vscode.EventEmitter<string>();
  const showArgs: string[] = [];
  return {
    show: async (file: string): Promise<void> => {
      showArgs.push(file);
    },
    hide: (): void => {},
    acceptCurrent: (): void => {},
    acceptIncoming: (): void => {},
    acceptBoth: (): void => {},
    acceptAllCurrent: (): void => {},
    acceptAllIncoming: (): void => {},
    nextConflict: (): void => {},
    previousConflict: (): void => {},
    markResolved: async (): Promise<void> => {},
    getMergeState: (): IMergeState | undefined => undefined,
    allConflictsResolved: (): boolean => false,
    onDidResolve: emitter.event,
    dispose: (): void => emitter.dispose(),
    _showArgs: showArgs,
    _fireResolve: (filePath: string): void => emitter.fire(filePath),
  } as unknown as IMergeView & { _showArgs: string[]; _fireResolve: (filePath: string) => void };
}

/**
 * Build a minimal mock `IGitService` with the git CLI + Continue/Abort hooks
 * the dialog needs. Records every invocation for assertions.
 */
function makeMockGitService(): IGitService & {
  _execCalls: string[][];
  _execOpts: Array<{ env?: NodeJS.ProcessEnv } | undefined>;
  _cherryPickAbortCalls: number;
  _cherryPickContinueCalls: number;
  _revertAbortCalls: number;
  _revertContinueCalls: number;
  _rebaseContinueCalls: number;
  _rebaseContinueResult: {
    success: boolean;
    conflicts?: string[];
    rebaseInProgress?: boolean;
    failureReason?: string;
  };
  _statuses: Map<string, { indexStatus: string; workTreeStatus: string }>;
  _fireRepoChange: (repo: IRepository) => void;
} {
  const execCalls: string[][] = [];
  const execOpts: Array<{ env?: NodeJS.ProcessEnv } | undefined> = [];
  const statuses: Map<string, { indexStatus: string; workTreeStatus: string }> = new Map();
  const repoChangeEmitter = new vscode.EventEmitter<IRepository>();

  const svc = {
    getRepositories: (): IRepository[] => [],
    onDidChangeRepository: repoChangeEmitter.event,
    getStatus: async () => {
      return Array.from(statuses.entries()).map(([p, s]) => ({
        path: p,
        indexStatus: s.indexStatus,
        workTreeStatus: s.workTreeStatus,
      }));
    },
    stage: () => okAsync(undefined),
    cherryPickAbort: async (): Promise<void> => {
      svc._cherryPickAbortCalls++;
    },
    cherryPickContinue: async (): Promise<{ success: boolean; conflicts?: string[] }> => {
      svc._cherryPickContinueCalls++;
      return { success: true };
    },
    revertAbort: async (): Promise<void> => {
      svc._revertAbortCalls++;
    },
    revertContinue: async (): Promise<{ success: boolean; conflicts?: string[] }> => {
      svc._revertContinueCalls++;
      return { success: true };
    },
    rebaseContinue: async (): Promise<{
      success: boolean;
      conflicts?: string[];
      rebaseInProgress?: boolean;
      failureReason?: string;
    }> => {
      svc._rebaseContinueCalls++;
      return svc._rebaseContinueResult;
    },
    gitCli: {
      exec: async (
        args: string[],
        opts?: { env?: NodeJS.ProcessEnv }
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        execCalls.push(args);
        execOpts.push(opts);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    _execCalls: execCalls,
    _execOpts: execOpts,
    _cherryPickAbortCalls: 0,
    _cherryPickContinueCalls: 0,
    _revertAbortCalls: 0,
    _revertContinueCalls: 0,
    _rebaseContinueCalls: 0,
    _rebaseContinueResult: { success: true } as {
      success: boolean;
      conflicts?: string[];
      rebaseInProgress?: boolean;
      failureReason?: string;
    },
    _statuses: statuses,
    _fireRepoChange: (r: IRepository): void => repoChangeEmitter.fire(r),
  } as unknown as IGitService & {
    _execCalls: string[][];
    _execOpts: Array<{ env?: NodeJS.ProcessEnv } | undefined>;
    _cherryPickAbortCalls: number;
    _cherryPickContinueCalls: number;
    _revertAbortCalls: number;
    _revertContinueCalls: number;
    _rebaseContinueCalls: number;
    _rebaseContinueResult: {
      success: boolean;
      conflicts?: string[];
      rebaseInProgress?: boolean;
      failureReason?: string;
    };
    _statuses: Map<string, { indexStatus: string; workTreeStatus: string }>;
    _fireRepoChange: (repo: IRepository) => void;
  };
  return svc;
}

describe('ResolveConflictsDialog', () => {
  let ctx: vscode.ExtensionContext;
  let gitService: ReturnType<typeof makeMockGitService>;
  let mergeView: ReturnType<typeof makeMockMergeView>;
  let conflictService: ConflictResolutionService;
  let repo: IRepository;
  let cleanupTmp: () => void;
  let dialog: ResolveConflictsDialog | undefined;

  beforeEach(() => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'autoOpenResolveConflictsDialog', true);

    ctx = makeContext();
    gitService = makeMockGitService();
    mergeView = makeMockMergeView();
    conflictService = new ConflictResolutionService(gitService);
    conflictService.setResolveConflictsDependencies(ctx, mergeView);

    const tmp = makeRepoInTmp();
    repo = tmp.repo;
    cleanupTmp = tmp.cleanup;
  });

  afterEach(() => {
    if (dialog) {
      dialog.dispose();
      dialog = undefined;
    }
    conflictService.dispose();
    cleanupTmp();
  });

  describe('rendering', () => {
    /**
     * Run the dialog's inline nonce'd script in jsdom. Post-migration contract:
     * the script BUILDS the body via document.createElement — the host markup
     * ships an empty root, not pre-baked rows/buttons.
     */
    function renderDoc(d: ResolveConflictsDialog): Document {
      const html = (d as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html;
      const dom = new JSDOM(html, { runScripts: 'outside-only' });
      const window = dom.window;
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (): void => {},
        getState: (): void => {},
        setState: (): void => {},
      });
      assert.strictEqual(
        window.document.querySelector('.file-row'),
        null,
        'rows must not be pre-baked in host markup — the script builds the DOM'
      );
      const scriptEl = window.document.querySelector('script[nonce]');
      assert.ok(scriptEl, 'a nonce-tagged inline script must be present');
      window.eval(scriptEl.textContent ?? '');
      return window.document as unknown as Document;
    }

    it('renders a row per conflict file', () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [
          { path: 'src/a.ts', resolved: false },
          { path: 'src/b.ts', resolved: false },
        ],
        { operation: 'merge', target: 'feature/x', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );

      const doc = renderDoc(dialog);
      assert.ok(doc.querySelector('[data-row-path="src/a.ts"]'), 'row for src/a.ts should render');
      assert.ok(doc.querySelector('[data-row-path="src/b.ts"]'), 'row for src/b.ts should render');
      const header = doc.querySelector('.header');
      assert.ok(header?.textContent?.includes("Merge from 'feature/x'"), 'header shows the op');
    });

    it('hides Abort button when canAbort is false', () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: false, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );
      const doc = renderDoc(dialog);
      assert.strictEqual(
        doc.querySelector('[data-action="abort"]'),
        null,
        'abort button should not render'
      );
    });

    it('renders Skip This Commit for a continuable rebase conflict', () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'rebase', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );
      const doc = renderDoc(dialog);
      assert.ok(
        doc.querySelector('[data-action="skip"]'),
        'skip button should render for a live rebase'
      );
    });

    it('hides Skip This Commit for a non-continuable rebase conflict (autostash pop)', () => {
      // A post-completion autostash-pop conflict is operation:'rebase' with
      // canContinue:false. Skip's precondition is identical to Continue's — a
      // live in-progress rebase — so `git rebase --skip` would dead-end on "no
      // rebase in progress". The button must be hidden alongside Abort/Continue.
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'rebase', canAbort: false, canContinue: false },
        conflictService,
        mergeView,
        gitService
      );
      const doc = renderDoc(dialog);
      assert.strictEqual(doc.querySelector('[data-action="skip"]'), null, 'skip must NOT render');
      assert.strictEqual(doc.querySelector('[data-action="abort"]'), null, 'abort must NOT render');
      assert.strictEqual(
        doc.querySelector('[data-action="continue"]'),
        null,
        'continue must NOT render'
      );
    });

    it('keeps Continue disabled until all rows are resolved', () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [
          { path: 'a.ts', resolved: false },
          { path: 'b.ts', resolved: false },
        ],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );
      const doc = renderDoc(dialog);
      const continueBtn = doc.querySelector('[data-action="continue"]') as HTMLButtonElement;
      assert.ok(continueBtn, 'continue button should render');
      assert.strictEqual(
        continueBtn.hasAttribute('disabled'),
        true,
        'continue should be disabled while rows are unresolved'
      );

      // Resolve all rows → re-render via updateFileStatus (which posts a message).
      dialog.updateFileStatus('a.ts', 'resolved');
      dialog.updateFileStatus('b.ts', 'resolved');
      assert.strictEqual(dialog.allResolved(), true);
    });
  });

  describe('message dispatch', () => {
    it('acceptYours → conflictResolutionService.acceptCurrent', async () => {
      const calls: Array<{ method: string; path: string }> = [];
      const stub = {
        ...conflictService,
        acceptCurrent: async (_repo: IRepository, p: string) => {
          calls.push({ method: 'acceptCurrent', path: p });
          return { success: true };
        },
        acceptIncoming: async () => ({ success: true }),
      } as unknown as ConflictResolutionService;

      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        stub,
        mergeView,
        gitService
      );

      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'acceptYours',
        path: 'a.ts',
      });
      assert.deepStrictEqual(calls, [{ method: 'acceptCurrent', path: 'a.ts' }]);
      assert.strictEqual(dialog.getFileStatuses().get('a.ts'), 'resolved');
    });

    it('acceptTheirs → conflictResolutionService.acceptIncoming', async () => {
      const calls: Array<{ method: string; path: string }> = [];
      const stub = {
        ...conflictService,
        acceptIncoming: async (_repo: IRepository, p: string) => {
          calls.push({ method: 'acceptIncoming', path: p });
          return { success: true };
        },
        acceptCurrent: async () => ({ success: true }),
      } as unknown as ConflictResolutionService;

      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        stub,
        mergeView,
        gitService
      );

      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'acceptTheirs',
        path: 'a.ts',
      });
      assert.deepStrictEqual(calls, [{ method: 'acceptIncoming', path: 'a.ts' }]);
    });

    it('openMergeView → IMergeView.show with file path', async () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );

      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'openMergeView',
        path: 'a.ts',
      });
      assert.deepStrictEqual(mergeView._showArgs, ['a.ts']);
    });

    it('drops a concurrent second Continue (busy gate) — rebaseContinue runs once', async () => {
      // A fast double-click could fire two `rebase --continue` runs; the second
      // dead-ends on "no rebase in progress". The _busy gate must drop it.
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: true }],
        { operation: 'rebase', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );
      const onMsg = (
        dialog as unknown as { _onMessage: (m: unknown) => Promise<void> }
      )._onMessage.bind(dialog);

      // Fire both WITHOUT awaiting the first, so the second arrives mid-flight.
      const p1 = onMsg({ type: 'continue' });
      const p2 = onMsg({ type: 'continue' });
      await Promise.all([p1, p2]);

      assert.strictEqual(
        (gitService as unknown as { _rebaseContinueCalls: number })._rebaseContinueCalls,
        1,
        'a double-clicked Continue must run rebaseContinue exactly once'
      );
    });

    it('MergeView.onDidResolve flips the row status to resolved', () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );
      assert.strictEqual(dialog.getFileStatuses().get('a.ts'), 'unresolved');
      mergeView._fireResolve('a.ts');
      assert.strictEqual(dialog.getFileStatuses().get('a.ts'), 'resolved');
    });
  });

  // After the user resolves a conflict in VS Code's native merge editor
  // (git.openMergeEditor → git.acceptMerge stages the file), the file stops
  // being unmerged. The dialog must flip that row to resolved when re-synced
  // against the live unmerged set — mirroring IntelliJ MultipleFileMergeDialog's
  // markFilesProcessed/updateModelFromFiles, which drops files no longer
  // reported by `git ls-files --unmerged`.
  describe('post-native-editor resolved-row auto-flip', () => {
    it('flips an unresolved row whose path is no longer in the unmerged set to resolved', () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [
          { path: 'a.ts', resolved: false },
          { path: 'b.ts', resolved: false },
        ],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );

      // a.ts was resolved+staged outside the dialog; b.ts is still unmerged.
      dialog.reconcileResolved(new Set(['b.ts']));

      assert.strictEqual(dialog.getFileStatuses().get('a.ts'), 'resolved');
      assert.strictEqual(dialog.getFileStatuses().get('b.ts'), 'unresolved');
    });

    it('leaves a still-unmerged row untouched', () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );

      // a.ts is still reported as unmerged — must NOT flip.
      dialog.reconcileResolved(new Set(['a.ts']));

      assert.strictEqual(dialog.getFileStatuses().get('a.ts'), 'unresolved');
    });

    it('does not touch paths outside the dialog model', () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );

      // An unrelated path going clean must not introduce a new row.
      dialog.reconcileResolved(new Set());

      assert.strictEqual(dialog.getFileStatuses().get('a.ts'), 'resolved');
      assert.strictEqual(dialog.getFileStatuses().has('zzz.ts'), false);
    });
  });

  /**
   * Regression: every `showErrorMessage` site in ResolveConflictsDialog
   * that surfaces git stderr or a caught `Error.message` must run through
   * `sanitizeGitError` so credentials embedded in remote URLs
   * (https://user:token@host…) don't leak into the user's notification
   * history.
   *
   * Round 1 wired the two continue/abort sites. Round 2 review found the four
   * below were still rendering the raw string. This describe block asserts
   * each of the four new sites scrubs PAT-in-URL patterns before rendering.
   */
  describe('TL-11: credential scrub on every error toast', () => {
    const dirtyUrl =
      "fatal: unable to access 'https://x-access-token:ghp_ABC123xyz@github.com/owner/repo.git/': 403";

    /**
     * Install a stub on `vscode.window.showErrorMessage` that records every
     * argument. Returns a cleanup callback for `afterEach`-style use.
     */
    function spyShowErrorMessage(): { calls: string[]; restore: () => void } {
      const calls: string[] = [];
      const original = vscode.window.showErrorMessage;
      (
        vscode.window as unknown as {
          showErrorMessage: (msg: string) => Thenable<string | undefined>;
        }
      ).showErrorMessage = (msg: string): Thenable<string | undefined> => {
        calls.push(msg);
        return Promise.resolve(undefined);
      };
      return {
        calls,
        restore: (): void => {
          (vscode.window as unknown as { showErrorMessage: typeof original }).showErrorMessage =
            original;
        },
      };
    }

    it('_handleAcceptYours scrubs credentials from result.error toast', async () => {
      const stub = {
        ...conflictService,
        acceptCurrent: async () => ({ success: false, error: dirtyUrl }),
        acceptIncoming: async () => ({ success: true }),
      } as unknown as ConflictResolutionService;

      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        stub,
        mergeView,
        gitService
      );

      const spy = spyShowErrorMessage();
      try {
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'acceptYours',
          path: 'a.ts',
        });
      } finally {
        spy.restore();
      }
      assert.strictEqual(spy.calls.length, 1, 'one error toast should render');
      assert.ok(
        !spy.calls[0].includes('ghp_ABC123xyz'),
        `token must be redacted — got ${spy.calls[0]}`
      );
      assert.ok(!spy.calls[0].includes('x-access-token'), 'user must be redacted');
      assert.ok(spy.calls[0].includes('<redacted>@github.com'), 'host preserved after redaction');
    });

    it('_handleAcceptTheirs scrubs credentials from result.error toast', async () => {
      const stub = {
        ...conflictService,
        acceptCurrent: async () => ({ success: true }),
        acceptIncoming: async () => ({ success: false, error: dirtyUrl }),
      } as unknown as ConflictResolutionService;

      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        stub,
        mergeView,
        gitService
      );

      const spy = spyShowErrorMessage();
      try {
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'acceptTheirs',
          path: 'a.ts',
        });
      } finally {
        spy.restore();
      }
      assert.strictEqual(spy.calls.length, 1);
      assert.ok(
        !spy.calls[0].includes('ghp_ABC123xyz'),
        `token must be redacted — got ${spy.calls[0]}`
      );
      assert.ok(spy.calls[0].includes('<redacted>@github.com'), 'host preserved');
    });

    it('_handleOpenMergeView scrubs credentials from thrown Error.message', async () => {
      const throwingMergeView = {
        ...mergeView,
        show: async (): Promise<void> => {
          throw new Error(dirtyUrl);
        },
      } as unknown as IMergeView;

      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        throwingMergeView,
        gitService
      );

      const spy = spyShowErrorMessage();
      try {
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'openMergeView',
          path: 'a.ts',
        });
      } finally {
        spy.restore();
      }
      assert.strictEqual(spy.calls.length, 1);
      assert.ok(
        !spy.calls[0].includes('ghp_ABC123xyz'),
        `token must be redacted — got ${spy.calls[0]}`
      );
      assert.ok(spy.calls[0].includes('<redacted>@github.com'), 'host preserved');
      assert.ok(spy.calls[0].startsWith('Failed to open merge view:'), 'prefix preserved');
    });

    it('_handleSkipCommit scrubs credentials when rebaseSkip rejects', async () => {
      // Simulate user confirming the Skip modal.
      const origWarn = vscode.window.showWarningMessage;
      (
        vscode.window as unknown as {
          showWarningMessage: (...args: unknown[]) => Thenable<string | undefined>;
        }
      ).showWarningMessage = (): Thenable<string | undefined> => Promise.resolve('Skip');

      // Install a rebaseSkip that throws a credential-bearing stderr.
      const throwingGit = {
        ...gitService,
        rebaseSkip: async (): Promise<{ success: boolean; conflicts?: string[] }> => {
          throw new Error(dirtyUrl);
        },
      } as unknown as IGitService;

      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'rebase', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        throwingGit
      );

      const spy = spyShowErrorMessage();
      try {
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'skip',
        });
      } finally {
        spy.restore();
        (vscode.window as unknown as { showWarningMessage: typeof origWarn }).showWarningMessage =
          origWarn;
      }
      assert.strictEqual(spy.calls.length, 1, 'expected exactly one error toast');
      assert.ok(
        !spy.calls[0].includes('ghp_ABC123xyz'),
        `token must be redacted — got ${spy.calls[0]}`
      );
      assert.ok(spy.calls[0].includes('<redacted>@github.com'), 'host preserved');
      assert.ok(spy.calls[0].startsWith('Failed to skip commit:'), 'prefix preserved');
    });

    it('host guard: a forged skip message on a non-continuable rebase never calls rebaseSkip', async () => {
      // The render side hides Skip for a completed rebase (operation:'rebase'
      // + canContinue:false), but a forged webview message could still arrive.
      // The host guard must early-return so `git rebase --skip` is never run —
      // it would dead-end on "no rebase in progress".
      let rebaseSkipCalls = 0;
      const trackingGit = {
        ...gitService,
        rebaseSkip: async (): Promise<{ success: boolean; conflicts?: string[] }> => {
          rebaseSkipCalls++;
          return { success: true };
        },
      } as unknown as IGitService;

      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'rebase', canAbort: false, canContinue: false },
        conflictService,
        mergeView,
        trackingGit
      );

      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'skip',
      });

      assert.strictEqual(rebaseSkipCalls, 0, 'rebaseSkip must not run for a completed rebase');
    });
  });

  describe('continue/abort routing', () => {
    const operations: Array<{
      op: IConflictOpContext['operation'];
      expectedContinue: (g: ReturnType<typeof makeMockGitService>) => boolean;
      expectedAbort: (g: ReturnType<typeof makeMockGitService>) => boolean;
    }> = [
      {
        op: 'merge',
        // continue now uses `git merge --continue` (was `git commit
        // --no-edit`), which is the idiomatic git ≥ 2.12 flow and honors
        // merge-specific hooks / MERGE_MSG correctly.
        expectedContinue: (g) =>
          g._execCalls.some((a) => a[0] === 'merge' && a[1] === '--continue'),
        expectedAbort: (g) => g._execCalls.some((a) => a[0] === 'merge' && a[1] === '--abort'),
      },
      {
        op: 'rebase',
        // Continue routes through gitService.rebaseContinue (NOT a raw
        // `rebase --continue` exec) so the expected non-zero exit at the next
        // commit's conflicts is handled as data, not a thrown error.
        expectedContinue: (g) => g._rebaseContinueCalls > 0,
        expectedAbort: (g) => g._execCalls.some((a) => a[0] === 'rebase' && a[1] === '--abort'),
      },
      {
        op: 'cherryPick',
        expectedContinue: (g) => g._cherryPickContinueCalls > 0,
        expectedAbort: (g) => g._cherryPickAbortCalls > 0,
      },
      {
        op: 'revert',
        expectedContinue: (g) => g._revertContinueCalls > 0,
        expectedAbort: (g) => g._revertAbortCalls > 0,
      },
      {
        op: 'unshelve',
        // unshelve continue is a no-op (the patch is already applied).
        expectedContinue: () => true,
        // CRITICAL fix: abort now restricts checkout to unresolved paths,
        // not `checkout -- .` which would wipe unrelated working-tree changes.
        expectedAbort: (g) =>
          g._execCalls.some(
            (a) => a[0] === 'checkout' && a[1] === 'HEAD' && a[2] === '--' && a.length > 3
          ),
      },
    ];

    operations.forEach(({ op, expectedContinue, expectedAbort }) => {
      it(`routes Continue for operation=${op}`, async () => {
        dialog = new ResolveConflictsDialog(
          ctx,
          repo,
          [{ path: 'a.ts', resolved: true }],
          { operation: op, canAbort: true, canContinue: true },
          conflictService,
          mergeView,
          gitService
        );
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'continue',
        });
        assert.ok(expectedContinue(gitService), `expected Continue dispatch for ${op}`);
      });

      it(`routes Abort for operation=${op}`, async () => {
        dialog = new ResolveConflictsDialog(
          ctx,
          repo,
          [{ path: 'a.ts', resolved: false }],
          { operation: op, canAbort: true, canContinue: true },
          conflictService,
          mergeView,
          gitService
        );
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'abort',
        });
        assert.ok(expectedAbort(gitService), `expected Abort dispatch for ${op}`);
      });
    });
  });

  // H1 — multi-commit rebase Continue. The PRIMARY conflict UI must route
  // rebase Continue through gitService.rebaseContinue (which returns the next
  // commit's conflicts as data) rather than a raw `rebase --continue` exec
  // (which THROWS on the expected non-zero when the rebase stops at the next
  // commit). A raw exec would dead-end the common multi-commit rebase:
  // an error toast + a stale "all resolved" dialog, with the new conflicts
  // never appearing.
  describe('H1 — rebase Continue multi-commit loop', () => {
    function makeRebaseDialog(): ResolveConflictsDialog {
      return new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: true }],
        { operation: 'rebase', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );
    }

    it('routes rebase Continue through gitService.rebaseContinue, never a raw rebase --continue exec', async () => {
      gitService._rebaseContinueResult = { success: true };
      dialog = makeRebaseDialog();

      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'continue',
      });

      assert.strictEqual(gitService._rebaseContinueCalls, 1, 'rebaseContinue must be called');
      assert.ok(
        !gitService._execCalls.some((a) => a[0] === 'rebase' && a[1] === '--continue'),
        'must NOT issue a raw `rebase --continue` exec (it throws on the expected non-zero)'
      );
    });

    it('re-populates the dialog with the next commit conflicts and keeps it open (no completed-close)', async () => {
      gitService._rebaseContinueResult = {
        success: false,
        conflicts: ['next/file.ts'],
        rebaseInProgress: true,
      };
      dialog = makeRebaseDialog();

      let closeReason: string | undefined;
      dialog.onDidClose((r) => {
        closeReason = r;
      });

      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'continue',
      });

      const statuses = dialog.getFileStatuses();
      assert.strictEqual(statuses.size, 1, 'dialog should now list only the next conflict');
      assert.strictEqual(
        statuses.get('next/file.ts'),
        'unresolved',
        'the next commit conflict must show as unresolved'
      );
      assert.strictEqual(closeReason, undefined, 'dialog must stay open, not close as completed');
    });

    it('surfaces a non-conflict failure reason instead of a false "completed"', async () => {
      gitService._rebaseContinueResult = {
        success: false,
        conflicts: [],
        failureReason: 'no rebase in progress',
      };
      dialog = makeRebaseDialog();

      let closeReason: string | undefined;
      dialog.onDidClose((r) => {
        closeReason = r;
      });

      const errors: string[] = [];
      const origErr = vscode.window.showErrorMessage;
      (
        vscode.window as unknown as {
          showErrorMessage: (msg: string) => Thenable<string | undefined>;
        }
      ).showErrorMessage = (msg: string): Thenable<string | undefined> => {
        errors.push(msg);
        return Promise.resolve(undefined);
      };
      try {
        await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
          type: 'continue',
        });
      } finally {
        (vscode.window as unknown as { showErrorMessage: typeof origErr }).showErrorMessage =
          origErr;
      }

      assert.strictEqual(errors.length, 1, 'a non-conflict failure must surface an error toast');
      assert.ok(
        errors[0].includes('no rebase in progress'),
        `toast should carry git's reason, got: ${errors[0]}`
      );
      assert.notStrictEqual(closeReason, 'completed', 'must not close as completed on failure');
    });
  });

  // M5 — merge Continue must run non-interactively. `git merge --continue`
  // opens $EDITOR for the merge message by default; under VS Code's non-TTY
  // spawn that hangs/fails. completeMerge already commits with `--no-edit`, so
  // the dialog's merge Continue must suppress the editor too (GIT_EDITOR=true,
  // since `git merge --continue --no-edit` is rejected as "expects no
  // arguments").
  describe('M5 — merge Continue suppresses the commit-message editor', () => {
    it('runs `git merge --continue` with GIT_EDITOR=true so no editor pops', async () => {
      dialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: true }],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );

      await (dialog as unknown as { _onMessage: (m: unknown) => Promise<void> })._onMessage({
        type: 'continue',
      });

      const idx = gitService._execCalls.findIndex((a) => a[0] === 'merge' && a[1] === '--continue');
      assert.ok(idx >= 0, 'merge --continue must be issued');
      const env = gitService._execOpts[idx]?.env;
      assert.ok(env, 'merge --continue must run with an explicit env');
      assert.strictEqual(
        env?.GIT_EDITOR,
        'true',
        'GIT_EDITOR=true must be set so the merge-message editor never opens'
      );
    });
  });
});

describe('ConflictResolutionService — (a) additions', () => {
  let ctx: vscode.ExtensionContext;
  let gitService: ReturnType<typeof makeMockGitService>;
  let mergeView: ReturnType<typeof makeMockMergeView>;
  let conflictService: ConflictResolutionService;
  let repo: IRepository;
  let gitDir: string;
  let cleanupTmp: () => void;

  beforeEach(() => {
    resetMockConfiguration();
    setMockConfigValue('intellig', 'autoOpenResolveConflictsDialog', true);

    ctx = makeContext();
    gitService = makeMockGitService();
    mergeView = makeMockMergeView();
    conflictService = new ConflictResolutionService(gitService);
    conflictService.setResolveConflictsDependencies(ctx, mergeView);

    const tmp = makeRepoInTmp();
    repo = tmp.repo;
    gitDir = tmp.gitDir;
    cleanupTmp = tmp.cleanup;
  });

  afterEach(() => {
    conflictService.dispose();
    cleanupTmp();
  });

  it('state-file watcher sets context key when MERGE_HEAD present AND unmerged files exist', async () => {
    // Simulate git state: create MERGE_HEAD and set status to return 1 unmerged.
    fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), 'deadbeef\n');
    gitService._statuses.set('a.ts', { indexStatus: 'U', workTreeStatus: 'U' });

    const active = await conflictService.runStateFileCheck(repo);
    assert.strictEqual(active, true);
    assert.strictEqual(conflictService.getConflictsActive(), true);
  });

  it('state-file watcher clears context key when MERGE_HEAD removed', async () => {
    // Start in the "active" state.
    fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), 'deadbeef\n');
    gitService._statuses.set('a.ts', { indexStatus: 'U', workTreeStatus: 'U' });
    await conflictService.runStateFileCheck(repo);
    assert.strictEqual(conflictService.getConflictsActive(), true);

    // Remove MERGE_HEAD & clear unmerged: watcher should clear the key.
    fs.unlinkSync(path.join(gitDir, 'MERGE_HEAD'));
    gitService._statuses.clear();
    const active = await conflictService.runStateFileCheck(repo);
    assert.strictEqual(active, false);
    assert.strictEqual(conflictService.getConflictsActive(), false);
  });

  it('feature flag = false suppresses the dialog but still surfaces context key', async () => {
    setMockConfigValue('intellig', 'autoOpenResolveConflictsDialog', false);

    await conflictService.openResolveConflictsDialog(repo, [{ path: 'a.ts', resolved: false }], {
      operation: 'merge',
      canAbort: true,
      canContinue: true,
    });

    assert.strictEqual(conflictService.hasOpenDialog(repo), false, 'no dialog should be opened');
    assert.strictEqual(
      conflictService.getConflictsActive(),
      true,
      'context key must still be true'
    );
  });

  it('flips an open dialog row to resolved when a repo change reports the file no longer unmerged', async () => {
    // Two files conflicted; dialog opens with both unresolved.
    gitService._statuses.set('a.ts', { indexStatus: 'U', workTreeStatus: 'U' });
    gitService._statuses.set('b.ts', { indexStatus: 'U', workTreeStatus: 'U' });
    await conflictService.openResolveConflictsDialog(
      repo,
      [
        { path: 'a.ts', resolved: false },
        { path: 'b.ts', resolved: false },
      ],
      { operation: 'merge', canAbort: true, canContinue: true }
    );
    const openDialog = conflictService.getOpenDialog(repo);
    assert.ok(openDialog);
    assert.strictEqual(openDialog.getFileStatuses().get('a.ts'), 'unresolved');

    // User resolves a.ts in the native merge editor → it is staged → `git
    // status` no longer reports it as unmerged. The `.git/index` write fires
    // onDidChangeRepository.
    gitService._statuses.delete('a.ts');
    gitService._fireRepoChange(repo);
    // Let the async onDidChangeRepository handler settle.
    await new Promise((resolve) => setImmediate(resolve));

    assert.strictEqual(openDialog.getFileStatuses().get('a.ts'), 'resolved');
    assert.strictEqual(openDialog.getFileStatuses().get('b.ts'), 'unresolved');
  });

  it('in-progress probe surfaces a non-ENOENT fs fault instead of masking it as "absent"', async () => {
    // Make `.git` a FILE so the state-file / rebase-dir existence probes hit
    // ENOTDIR (a real fs fault) rather than ENOENT. The probe must now LOG
    // the non-ENOENT fault — the prior code swallowed every errno as "absent".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-rc-enotdir-'));
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: /nowhere\n');
    const badRepo = {
      rootUri: vscode.Uri.file(root),
      state: 'idle',
      remotes: [],
      submodules: [],
    } as unknown as IRepository;

    const debugMessages: string[] = [];
    (conflictService as unknown as { _logger: unknown })._logger = {
      debug: (msg: string): void => void debugMessages.push(msg),
      info: (): void => {},
      warn: (): void => {},
      error: (): void => {},
      trace: (): void => {},
      child(): unknown {
        return this;
      },
    };

    const active = await conflictService.runStateFileCheck(badRepo);
    assert.strictEqual(active, false, 'degrades to "no operation in progress"');
    assert.ok(
      debugMessages.some((m) => /probe failed/i.test(m)),
      'a non-ENOENT fs fault must be logged, not silently masked'
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('in-progress probe stays silent for the normal ENOENT (absent) case', async () => {
    // gitDir exists with no state files → ENOENT on every probe → no fault log.
    const debugMessages: string[] = [];
    (conflictService as unknown as { _logger: unknown })._logger = {
      debug: (msg: string): void => void debugMessages.push(msg),
      info: (): void => {},
      warn: (): void => {},
      error: (): void => {},
      trace: (): void => {},
      child(): unknown {
        return this;
      },
    };

    const active = await conflictService.runStateFileCheck(repo);
    assert.strictEqual(active, false);
    assert.ok(
      !debugMessages.some((m) => /probe failed/i.test(m)),
      'ENOENT is the expected absent signal — it must not be logged as a fault'
    );
  });

  it('feature flag = true opens dialog and tracks it per repo (single-instance reveal)', async () => {
    await conflictService.openResolveConflictsDialog(repo, [{ path: 'a.ts', resolved: false }], {
      operation: 'merge',
      canAbort: true,
      canContinue: true,
    });
    assert.strictEqual(conflictService.hasOpenDialog(repo), true);

    const first = conflictService.getOpenDialog(repo);
    assert.ok(first);

    // Second call should reuse the dialog (same reference), not open another.
    await conflictService.openResolveConflictsDialog(
      repo,
      [
        { path: 'a.ts', resolved: false },
        { path: 'b.ts', resolved: false },
      ],
      { operation: 'merge', canAbort: true, canContinue: true }
    );
    const second = conflictService.getOpenDialog(repo);
    assert.strictEqual(first, second, 'dialog must be reused');
    assert.strictEqual(
      second!.getFileStatuses().size,
      2,
      'dialog should be updated with new conflicts'
    );
  });

  // ─── Finding #6: completeMerge / completeRebase stale-dialog guard ────────
  //
  // Regression: "Continue" on a stale merge dialog can commit whatever is
  // staged if the repo is no longer mid-merge. completeMerge / completeRebase
  // must bail early when repo.state === 'idle', not fall through to the git
  // command.

  describe('completeMerge — stale-dialog guard', () => {
    it('returns "not in a merge" error when repo state is idle', async () => {
      // repo created by makeRepoInTmp() already has state: 'idle'.
      const result = await conflictService.completeMerge(repo);

      assert.strictEqual(result.success, false);
      assert.ok(
        result.error && /not.*merge|no.*merge/i.test(result.error),
        `expected a "not in a merge" error, got: ${result.error}`
      );
    });

    it('does not invoke git commit when repo is not mid-merge', async () => {
      await conflictService.completeMerge(repo);

      assert.ok(
        !gitService._execCalls.some((args) => args[0] === 'commit'),
        'git commit --no-edit must not be called when repo is not mid-merge'
      );
    });
  });

  describe('completeRebase — stale-dialog guard', () => {
    it('returns "not in a rebase" error when repo state is idle', async () => {
      const result = await conflictService.completeRebase(repo);

      assert.strictEqual(result.success, false);
      assert.ok(
        result.error && /not.*rebase|no.*rebase/i.test(result.error),
        `expected a "not in a rebase" error, got: ${result.error}`
      );
    });

    it('does not invoke git rebase when repo is not mid-rebase', async () => {
      await conflictService.completeRebase(repo);

      assert.ok(
        !gitService._execCalls.some((args) => args[0] === 'rebase'),
        'git rebase --continue must not be called when repo is not mid-rebase'
      );
    });
  });

  // ─── Dialog close lifecycle (tab close vs Continue/Abort) ─────────────────
  //
  // BaseWebviewPanel routes panel.onDidDispose → dispose(). The dialog must
  // fire onDidClose('cancelled') from dispose() so the service clears its
  // _activeDialogs / _opByRepo registries; otherwise a tab-closed dialog leaks
  // (stranded disposed reference, stale recorded operation).
  describe('close lifecycle', () => {
    it('fires onDidClose(cancelled) when the editor tab is closed (dispose)', () => {
      const d: ResolveConflictsDialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );
      const reasons: Array<'completed' | 'aborted' | 'cancelled'> = [];
      d.onDidClose((r) => reasons.push(r));

      d.dispose();
      assert.deepStrictEqual(
        reasons,
        ['cancelled'],
        'tab close must notify owner once as cancelled'
      );
    });

    it('fires onDidClose at most once across repeated dispose', () => {
      const d: ResolveConflictsDialog = new ResolveConflictsDialog(
        ctx,
        repo,
        [{ path: 'a.ts', resolved: false }],
        { operation: 'merge', canAbort: true, canContinue: true },
        conflictService,
        mergeView,
        gitService
      );
      const reasons: Array<'completed' | 'aborted' | 'cancelled'> = [];
      d.onDidClose((r) => reasons.push(r));

      d.dispose();
      d.dispose();
      assert.deepStrictEqual(reasons, ['cancelled'], 'must not double-fire');
    });

    it('clears the service registry on tab close so the repo can reopen a fresh dialog', async () => {
      await conflictService.openResolveConflictsDialog(repo, [{ path: 'a.ts', resolved: false }], {
        operation: 'unstash',
        canAbort: true,
        canContinue: true,
      });
      const first = conflictService.getOpenDialog(repo);
      assert.ok(first, 'dialog opened');

      // Simulate the user closing the editor tab.
      first.dispose();
      assert.strictEqual(
        conflictService.hasOpenDialog(repo),
        false,
        'registry must be cleared when the tab is closed'
      );

      await conflictService.openResolveConflictsDialog(repo, [{ path: 'a.ts', resolved: false }], {
        operation: 'merge',
        canAbort: true,
        canContinue: true,
      });
      const second = conflictService.getOpenDialog(repo);
      assert.ok(second && second !== first, 'a fresh dialog must be created, not the disposed one');
      second.dispose();
    });

    it('replaces a lingering dialog when a different operation opens for the same repo', async () => {
      await conflictService.openResolveConflictsDialog(repo, [{ path: 'a.ts', resolved: false }], {
        operation: 'unstash',
        canAbort: true,
        canContinue: true,
      });
      const first = conflictService.getOpenDialog(repo);
      assert.ok(first);

      // A different operation must NOT reuse the unstash dialog (which would
      // keep the unstash reversal/labels); it replaces it.
      await conflictService.openResolveConflictsDialog(repo, [{ path: 'a.ts', resolved: false }], {
        operation: 'merge',
        canAbort: true,
        canContinue: true,
      });
      const second = conflictService.getOpenDialog(repo);
      assert.ok(second && second !== first, 'different op must create a fresh dialog');
      assert.strictEqual(second.getOpContext().operation, 'merge');
      assert.strictEqual(
        (first as unknown as { _disposed: boolean })._disposed,
        true,
        'the stale dialog must be disposed'
      );
      second.dispose();
    });

    it('keeps the recorded op after tab close so bulk accept-all still reverses (unstash)', async () => {
      // Unstash conflict on a.ts; repo.state is 'idle' (no rebase signal), so
      // the reversal can only come from the recorded operation.
      gitService._statuses.set('a.ts', { indexStatus: 'U', workTreeStatus: 'U' });
      await conflictService.openResolveConflictsDialog(repo, [{ path: 'a.ts', resolved: false }], {
        operation: 'unstash',
        canAbort: true,
        canContinue: true,
      });
      const d = conflictService.getOpenDialog(repo);
      assert.ok(d);

      // User closes the editor tab WITHOUT resolving — the conflict persists.
      d.dispose();

      await conflictService.acceptAllCurrent(repo);
      assert.ok(
        gitService._execCalls.some(
          (a) => a[0] === 'checkout' && a[1] === '--theirs' && a[3] === 'a.ts'
        ),
        'unstash bulk Accept All Current must still reverse to --theirs after the tab is closed'
      );
    });

    it('clears the recorded op once the repo conflicts clear (no stale reversal later)', async () => {
      gitService._statuses.set('a.ts', { indexStatus: 'U', workTreeStatus: 'U' });
      await conflictService.openResolveConflictsDialog(repo, [{ path: 'a.ts', resolved: false }], {
        operation: 'unstash',
        canAbort: true,
        canContinue: true,
      });

      // The unstash conflict resolves → onDidChangeRepository reports 0 conflicts.
      gitService._statuses.delete('a.ts');
      gitService._fireRepoChange(repo);
      await new Promise((resolve) => setImmediate(resolve));

      // A later, unrelated merge conflict (no dialog/op recorded, state idle)
      // must NOT inherit the stale unstash reversal — it takes --ours.
      gitService._statuses.set('b.ts', { indexStatus: 'U', workTreeStatus: 'U' });
      await conflictService.acceptAllCurrent(repo);
      assert.ok(
        gitService._execCalls.some(
          (a) => a[0] === 'checkout' && a[1] === '--ours' && a[3] === 'b.ts'
        ),
        'a later conflict must not inherit the cleared unstash reversal'
      );
    });
  });
});
