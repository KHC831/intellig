/**
 * Unit tests for `ResolveConflictsDialog` + `ConflictResolutionService`
 * extensions added in T1-08(a).
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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConflictResolutionService } from '../../../services/ConflictResolutionService';
import { ResolveConflictsDialog } from '../../../services/ResolveConflictsDialog';
import type { IConflictOpContext } from '../../../services/interfaces/IConflictResolutionService';
import type { IMergeView, IMergeState } from '../../../services/interfaces/IMergeView';
import type { IGitService, IRepository } from '../../../services/interfaces/IGitService';
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
  _cherryPickAbortCalls: number;
  _cherryPickContinueCalls: number;
  _revertAbortCalls: number;
  _revertContinueCalls: number;
  _statuses: Map<string, { indexStatus: string; workTreeStatus: string }>;
} {
  const execCalls: string[][] = [];
  const statuses: Map<string, { indexStatus: string; workTreeStatus: string }> = new Map();

  const svc = {
    getRepositories: (): IRepository[] => [],
    onDidChangeRepository: new vscode.EventEmitter<IRepository>().event,
    getStatus: async () => {
      return Array.from(statuses.entries()).map(([p, s]) => ({
        path: p,
        indexStatus: s.indexStatus,
        workTreeStatus: s.workTreeStatus,
      }));
    },
    stage: async (): Promise<void> => {},
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
    gitCli: {
      exec: async (
        args: string[]
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
        execCalls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    _execCalls: execCalls,
    _cherryPickAbortCalls: 0,
    _cherryPickContinueCalls: 0,
    _revertAbortCalls: 0,
    _revertContinueCalls: 0,
    _statuses: statuses,
  } as unknown as IGitService & {
    _execCalls: string[][];
    _cherryPickAbortCalls: number;
    _cherryPickContinueCalls: number;
    _revertAbortCalls: number;
    _revertContinueCalls: number;
    _statuses: Map<string, { indexStatus: string; workTreeStatus: string }>;
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

      const html = (dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html;
      assert.ok(html.includes('src/a.ts'), 'row for src/a.ts should render');
      assert.ok(html.includes('src/b.ts'), 'row for src/b.ts should render');
      assert.ok(html.includes('Resolve Conflicts'), 'title should include Resolve Conflicts');
      // Title is HTML-escaped so the apostrophe renders as &#39; (LOW-6:
      // codebase-wide the apostrophe entity is the short form).
      assert.ok(
        html.includes('Merge from &#39;feature/x&#39;') || html.includes("Merge from 'feature/x'"),
        'title should include escaped target'
      );
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
      const html = (dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html;
      assert.ok(!html.includes('data-action="abort"'), 'abort button should not render');
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
      const htmlBefore = (dialog as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html;
      // Look for the continue button and verify it has disabled.
      const continueMatch = htmlBefore.match(/<button[^>]*data-action="continue"[^>]*>/);
      assert.ok(continueMatch, 'continue button should render');
      assert.ok(
        /disabled/.test(continueMatch[0]),
        `continue should be disabled: ${continueMatch[0]}`
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

  /**
   * TL-11 regression: every `showErrorMessage` site in ResolveConflictsDialog
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
  });

  describe('continue/abort routing', () => {
    const operations: Array<{
      op: IConflictOpContext['operation'];
      expectedContinue: (g: ReturnType<typeof makeMockGitService>) => boolean;
      expectedAbort: (g: ReturnType<typeof makeMockGitService>) => boolean;
    }> = [
      {
        op: 'merge',
        // MEDIUM-2: continue now uses `git merge --continue` (was `git commit
        // --no-edit`), which is the idiomatic git ≥ 2.12 flow and honors
        // merge-specific hooks / MERGE_MSG correctly.
        expectedContinue: (g) =>
          g._execCalls.some((a) => a[0] === 'merge' && a[1] === '--continue'),
        expectedAbort: (g) => g._execCalls.some((a) => a[0] === 'merge' && a[1] === '--abort'),
      },
      {
        op: 'rebase',
        expectedContinue: (g) =>
          g._execCalls.some((a) => a[0] === 'rebase' && a[1] === '--continue'),
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
});

describe('ConflictResolutionService — T1-08(a) additions', () => {
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
});
