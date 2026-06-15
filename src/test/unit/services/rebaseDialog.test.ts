/**
 * Unit tests for the unified Rebase Dialog (#25).
 *
 * Drives `RebaseDialog._onMessage` via a test subclass that exposes
 * `simulateMessage` without a real webview. Covers:
 *   - cancel → dispose, no git call.
 *   - non-interactive success → `rebaseBranch(onto)`, info toast, reload,
 *     dispose, onComplete fired.
 *   - interactive → the editor factory's `show({ onto })` runs, `rebaseBranch`
 *     is NOT called, dispose + onComplete.
 *   - defensive onto: a target outside `branchChoices` falls back to the
 *     preselected onto (a compromised webview cannot steer the rebase).
 *   - conflict → `openResolveConflictsDialog` with `operation: 'rebase'`,
 *     target = onto; continue/abort gated on `rebaseInProgress`.
 *   - autostash-pop conflict (`rebaseInProgress: false`) → continue/abort off.
 *   - orphan recovery → a non-conflict failure that newly created a rebasing
 *     state is auto-aborted; a pre-existing paused rebase is NOT.
 *   - failure toast runs through `sanitizeGitError`.
 *   - structural: the preselected (non-branch) onto is added to the dropdown;
 *     the Interactive checkbox reflects `interactiveDefault`.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  RebaseDialog,
  IRebaseDialogOptions,
  rebaseInProgressMessage,
} from '../../../rebase/RebaseDialog';
import {
  IGitService,
  IRepository,
  IBasicRebaseResult,
  IRebaseOptions,
} from '../../../git-core/interfaces/IGitService';
import {
  IConflictResolutionService,
  IConflictedFile,
  IConflictOpContext,
} from '../../../conflicts/interfaces/IConflictResolutionService';
import { RebaseEditor } from '../../../rebase/RebaseEditor';
import { Uri } from '../../mocks/vscode';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: {} as vscode.Memento,
    globalState: {} as vscode.Memento,
    extensionPath: '/tmp/ext',
    extensionUri: vscode.Uri.file('/tmp/ext'),
    globalStorageUri: vscode.Uri.file('/tmp/global'),
    logUri: vscode.Uri.file('/tmp/log'),
    extensionMode: 3,
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

function makeRepo(headName: string = 'main', inProgressKind?: string): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: `refs/heads/${headName}`, commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
    ...(inProgressKind ? { inProgress: { kind: inProgressKind } } : {}),
  } as unknown as IRepository;
}

interface RebaseCall {
  repo: IRepository;
  onto: string;
  options?: IRebaseOptions;
}

interface GitServiceStub extends IGitService {
  _rebaseCalls: RebaseCall[];
  _abortCalls: number;
  _reloadResult: IRepository | undefined;
}

function makeGitService(
  result: IBasicRebaseResult = { success: true },
  reloadResult?: IRepository,
  shouldThrow?: Error
): GitServiceStub {
  const rebaseCalls: RebaseCall[] = [];
  const stub = {
    _rebaseCalls: rebaseCalls,
    _abortCalls: 0,
    _reloadResult: reloadResult,
    rebaseBranch: async (
      repo: IRepository,
      onto: string,
      options?: IRebaseOptions
    ): Promise<IBasicRebaseResult> => {
      rebaseCalls.push({ repo, onto, options });
      if (shouldThrow) {
        throw shouldThrow;
      }
      return result;
    },
    reloadRepository: async (): Promise<IRepository | undefined> => stub._reloadResult,
    rebaseAbort: async (): Promise<void> => {
      stub._abortCalls += 1;
    },
  } as unknown as GitServiceStub;
  return stub;
}

interface ResolveCall {
  repo: IRepository;
  conflicts: IConflictedFile[];
  opContext: IConflictOpContext;
}

function makeConflictService(): IConflictResolutionService & { _calls: ResolveCall[] } {
  const calls: ResolveCall[] = [];
  return {
    _calls: calls,
    openResolveConflictsDialog: async (
      repo: IRepository,
      conflicts: IConflictedFile[],
      opContext: IConflictOpContext
    ) => {
      calls.push({ repo, conflicts, opContext });
    },
  } as unknown as IConflictResolutionService & { _calls: ResolveCall[] };
}

interface EditorShowCall {
  repo: IRepository;
  onto: string;
}

function makeEditorFactory(): { factory: () => RebaseEditor; calls: EditorShowCall[] } {
  const calls: EditorShowCall[] = [];
  const editor = {
    show: async (repo: IRepository, opts: { onto: string }) => {
      calls.push({ repo, onto: opts.onto });
      return { completed: true };
    },
  } as unknown as RebaseEditor;
  return { factory: () => editor, calls };
}

interface MessageLog {
  info: string[];
  error: string[];
  warn: string[];
}

function installMessageTrackers(): MessageLog {
  const log: MessageLog = { info: [], error: [], warn: [] };
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = async (
    m: string
  ) => {
    log.info.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
    m: string
  ) => {
    log.error.push(m);
    return undefined;
  };
  (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (
    m: string
  ) => {
    log.warn.push(m);
    return undefined;
  };
  return log;
}

class TestRebaseDialog extends RebaseDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
  public disposed(): boolean {
    return (this as unknown as { _disposed: boolean })._disposed;
  }
  public bodyHtml(): string {
    return (this as unknown as { _getBodyParts(): { body: string } })._getBodyParts().body;
  }
}

function makeDialog(overrides: Partial<IRebaseDialogOptions> = {}): {
  dialog: TestRebaseDialog;
  gitService: GitServiceStub;
  conflictService: IConflictResolutionService & { _calls: ResolveCall[] };
  editorCalls: EditorShowCall[];
  onCompleteCalls: number;
} {
  const gitService = (overrides.gitService as GitServiceStub | undefined) ?? makeGitService();
  const conflictService = overrides.conflictResolutionService ?? makeConflictService();
  const { factory, calls: editorCalls } = makeEditorFactory();
  let onCompleteCalls = 0;
  const dialog = new TestRebaseDialog(makeContext(), {
    repo: overrides.repo ?? makeRepo(),
    onto: overrides.onto ?? 'main',
    branchChoices: overrides.branchChoices ?? ['main', 'develop'],
    interactiveDefault: overrides.interactiveDefault,
    gitService,
    createRebaseEditor: overrides.createRebaseEditor ?? factory,
    conflictResolutionService: conflictService,
    onComplete:
      overrides.onComplete ??
      (() => {
        onCompleteCalls += 1;
      }),
  });
  return {
    dialog,
    gitService,
    conflictService: conflictService as IConflictResolutionService & { _calls: ResolveCall[] },
    editorCalls,
    get onCompleteCalls() {
      return onCompleteCalls;
    },
  } as ReturnType<typeof makeDialog>;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

describe('RebaseDialog — lifecycle (#25)', () => {
  it('cancel disposes without invoking git', async () => {
    installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({ type: 'cancel' });
    assert.strictEqual(h.gitService._rebaseCalls.length, 0);
    assert.strictEqual(h.dialog.disposed(), true);
  });

  it('non-interactive success: rebaseBranch(onto), info toast, dispose, onComplete', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ onto: 'develop' });
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'develop', interactive: false });
    assert.strictEqual(h.gitService._rebaseCalls.length, 1);
    assert.strictEqual(h.gitService._rebaseCalls[0].onto, 'develop');
    assert.strictEqual(h.editorCalls.length, 0, 'interactive editor must NOT run');
    assert.ok(log.info[0].includes('develop'));
    assert.strictEqual(h.dialog.disposed(), true);
    assert.strictEqual(h.onCompleteCalls, 1);
  });

  it('interactive: editor.show({ onto }) runs, rebaseBranch is NOT called', async () => {
    installMessageTrackers();
    const h = makeDialog({ onto: 'develop' });
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'develop', interactive: true });
    assert.strictEqual(h.gitService._rebaseCalls.length, 0, 'plain rebase must not run');
    assert.strictEqual(h.editorCalls.length, 1);
    assert.strictEqual(h.editorCalls[0].onto, 'develop');
    assert.strictEqual(h.dialog.disposed(), true);
    assert.strictEqual(h.onCompleteCalls, 1);
  });

  it('defensive onto: a target outside branchChoices falls back to the preselected onto', async () => {
    installMessageTrackers();
    const h = makeDialog({ onto: 'main', branchChoices: ['main', 'develop'] });
    // A compromised webview tries to steer the rebase onto an un-offered ref.
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'origin/evil', interactive: false });
    assert.strictEqual(h.gitService._rebaseCalls[0].onto, 'main', 'falls back to preselected onto');
  });
});

// ─── Conflict + recovery ───────────────────────────────────────────────────────

describe('RebaseDialog — conflict + recovery (#25)', () => {
  it('conflict (live rebase): routes to openResolveConflictsDialog, operation=rebase, continue/abort ON', async () => {
    installMessageTrackers();
    const gitService = makeGitService({
      success: false,
      conflicts: ['a.ts', 'b.ts'],
      rebaseInProgress: true,
    });
    const h = makeDialog({ gitService, onto: 'develop' });
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'develop', interactive: false });
    assert.strictEqual(h.conflictService._calls.length, 1);
    const call = h.conflictService._calls[0];
    assert.strictEqual(call.opContext.operation, 'rebase');
    assert.strictEqual(call.opContext.target, 'develop');
    assert.strictEqual(call.opContext.canAbort, true);
    assert.strictEqual(call.opContext.canContinue, true);
    assert.deepStrictEqual(call.conflicts, [
      { path: 'a.ts', resolved: false },
      { path: 'b.ts', resolved: false },
    ]);
    assert.strictEqual(h.dialog.disposed(), true);
  });

  it('autostash-pop conflict (rebaseInProgress=false): continue/abort suppressed', async () => {
    installMessageTrackers();
    const gitService = makeGitService({
      success: false,
      conflicts: ['a.ts'],
      rebaseInProgress: false,
    });
    const h = makeDialog({ gitService });
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'main', interactive: false });
    const call = h.conflictService._calls[0];
    assert.strictEqual(call.opContext.canAbort, false);
    assert.strictEqual(call.opContext.canContinue, false);
  });

  it('orphan recovery: a non-conflict failure that NEWLY created a rebasing state is auto-aborted', async () => {
    const log = installMessageTrackers();
    // before: no in-progress op; reload reports a rebasing state our failed
    // call left behind → auto-abort.
    const gitService = makeGitService(
      { success: false, failureReason: 'fatal: could not apply' },
      makeRepo('main', 'rebasing')
    );
    const h = makeDialog({ gitService, repo: makeRepo('main') });
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'develop', interactive: false });
    assert.strictEqual(h.gitService._abortCalls, 1, 'orphaned rebase must be auto-aborted');
    assert.ok(log.error.some((m) => m.includes('Failed to rebase onto')));
  });

  it('does NOT auto-abort a rebase the user already had paused before the click', async () => {
    installMessageTrackers();
    // before AND after: rebasing. The state pre-existed → never our orphan.
    const gitService = makeGitService(
      { success: false, failureReason: 'fatal: cannot rebase: in progress' },
      makeRepo('main', 'rebasing')
    );
    const h = makeDialog({ gitService, repo: makeRepo('main', 'rebasing') });
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'develop', interactive: false });
    assert.strictEqual(h.gitService._abortCalls, 0, 'a pre-existing paused rebase is left alone');
  });

  it('failure toast runs through sanitizeGitError (no credential / home-path leak)', async () => {
    const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const log = installMessageTrackers();
    const gitService = makeGitService(undefined, undefined, new Error(RAW));
    const h = makeDialog({ gitService });
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'main', interactive: false });
    assert.strictEqual(log.error.length, 1);
    assert.ok(!log.error[0].includes('alice:secret'), 'toast must not leak credentials');
    assert.ok(!log.error[0].includes('/Users/alice'), 'toast must not leak home path');
  });
});

// ─── Structural ────────────────────────────────────────────────────────────────

describe('RebaseDialog — body structure (#25)', () => {
  it('adds a preselected non-branch onto (commit hash) to the dropdown', () => {
    installMessageTrackers();
    const h = makeDialog({ onto: 'abc1234', branchChoices: ['main', 'develop'] });
    const body = h.dialog.bodyHtml();
    assert.ok(body.includes('value="abc1234"'), 'commit-hash target is offered as an option');
    assert.ok(body.includes('selected>abc1234<'), 'and it is the selected option');
  });

  it('reflects interactiveDefault in the Interactive checkbox', () => {
    installMessageTrackers();
    const checked = makeDialog({ interactiveDefault: true });
    assert.ok(/id="flag-interactive"[^>]*checked/.test(checked.dialog.bodyHtml()));
    const unchecked = makeDialog({ interactiveDefault: false });
    assert.ok(!/id="flag-interactive"[^>]*checked/.test(unchecked.dialog.bodyHtml()));
  });

  it('emits the four git4idea rebase-option checkboxes (#P2)', () => {
    installMessageTrackers();
    const body = makeDialog({}).dialog.bodyHtml();
    assert.ok(body.includes('id="flag-rebaseMerges"'), 'rebase-merges checkbox');
    assert.ok(body.includes('id="flag-updateRefs"'), 'update-refs checkbox');
    assert.ok(body.includes('id="flag-keepEmpty"'), 'keep-empty checkbox');
    assert.ok(body.includes('id="flag-autosquash"'), 'autosquash checkbox');
    // Options start unchecked (off by default — legacy behavior).
    assert.ok(!/id="flag-rebaseMerges"[^>]*checked/.test(body), 'options default to off');
  });
});

describe('rebaseInProgressMessage — in-progress guard (#P2)', () => {
  it('returns a message when the repo is mid-rebase (git4idea blocks here)', () => {
    const repo = { inProgress: { kind: 'rebasing' } } as unknown as IRepository;
    const msg = rebaseInProgressMessage(repo);
    assert.ok(msg && /rebase/i.test(msg), 'a rebasing repo yields a guard message');
  });

  it('returns undefined for an idle repo', () => {
    assert.strictEqual(rebaseInProgressMessage({} as IRepository), undefined);
    assert.strictEqual(
      rebaseInProgressMessage({ inProgress: { kind: 'merging' } } as unknown as IRepository),
      undefined,
      'a non-rebase in-progress op does not block the rebase dialog'
    );
  });
});

describe('RebaseDialog — rebase options threading (#P2)', () => {
  beforeEach(() => {
    installMessageTrackers();
  });

  it('forwards the selected options to rebaseBranch on the non-interactive path', async () => {
    const h = makeDialog({ branchChoices: ['main', 'develop'] });
    await h.dialog.simulateMessage({
      type: 'rebase',
      onto: 'develop',
      interactive: false,
      rebaseMerges: true,
      updateRefs: true,
      keepEmpty: false,
      autosquash: false,
    });
    const call = h.gitService._rebaseCalls[0];
    assert.strictEqual(call.onto, 'develop');
    assert.deepStrictEqual(call.options, {
      rebaseMerges: true,
      keepEmpty: false,
      updateRefs: true,
      autosquash: false,
    });
  });

  it('passes all-false options when none are selected', async () => {
    const h = makeDialog({ branchChoices: ['main', 'develop'] });
    await h.dialog.simulateMessage({ type: 'rebase', onto: 'develop', interactive: false });
    assert.deepStrictEqual(h.gitService._rebaseCalls[0].options, {
      rebaseMerges: false,
      keepEmpty: false,
      updateRefs: false,
      autosquash: false,
    });
  });
});
