/**
 * Unit tests for the Merge Dialog.
 *
 * Covers:
 *  - Pure `resolveMergeMutex` — all six strategy-flag combinations plus
 *    the "no lastToggled" first-wins fallback.
 *  - `GitService.mergeBranch` — arg construction for every option in
 *    isolation and combined, order preserved.
 *  - `MergeDialog._onMessage` via a test subclass that exposes
 *    `simulateMessage` without a real webview:
 *      * cancel → dispose, no git call.
 *      * merge with all flags false → plain `git merge <branch>`.
 *      * merge with `--ff-only` → git arg list contains `--ff-only`.
 *      * merge with message → `-m` + message appended.
 *      * merge success → info toast, dispose, onMergeComplete fired.
 *      * merge conflict → openResolveConflictsDialog invoked with
 *        `operation: 'merge'`, target = source branch.
 *      * defensive mutex: caller sets ffOnly + squash at the same time →
 *        only ffOnly reaches the git call.
 */

/*
 * Stub factories synthesise IGitService / gitCli implementations whose
 * member signatures return `Promise<T>`; no-await stub bodies are
 * intentional here.
 */

import '../../setup';
import * as assert from 'assert';
import { JSDOM } from 'jsdom';
import * as vscode from 'vscode';
import { GitService } from '../../../src/git-core/GitService';
import {
  MergeDialog,
  IMergeDialogOptions,
  IMergeFlagState,
  resolveMergeMutex,
} from '../../../src/conflicts/MergeDialog';
import {
  IGitService,
  IMergeOptions,
  IMergeResult,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import {
  IConflictResolutionService,
  IConflictedFile,
  IConflictOpContext,
} from '../../../src/conflicts/interfaces/IConflictResolutionService';
import { Uri } from '../../mocks/vscode';

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

function makeRepo(headName: string = 'main'): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: `refs/heads/${headName}`, commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

interface MergeCall {
  repo: IRepository;
  branch: string;
  options?: IMergeOptions;
}

function makeGitService(
  result: IMergeResult = { success: true, mergeCommit: 'abc123' },
  shouldThrow?: Error
): IGitService & { _mergeCalls: MergeCall[] } {
  const calls: MergeCall[] = [];
  return {
    _mergeCalls: calls,
    mergeBranch: async (
      repo: IRepository,
      branch: string,
      options?: IMergeOptions
    ): Promise<IMergeResult> => {
      calls.push({ repo, branch, options });
      if (shouldThrow) {
        throw shouldThrow;
      }
      return result;
    },
  } as unknown as IGitService & { _mergeCalls: MergeCall[] };
}

interface ResolveCall {
  repo: IRepository;
  conflicts: IConflictedFile[];
  opContext: IConflictOpContext;
}

function makeConflictService(): IConflictResolutionService & {
  _calls: ResolveCall[];
} {
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

class TestMergeDialog extends MergeDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
  public disposed(): boolean {
    return (this as unknown as { _disposed: boolean })._disposed;
  }
}

function makeDialog(overrides: Partial<IMergeDialogOptions> = {}): {
  dialog: TestMergeDialog;
  gitService: IGitService & { _mergeCalls: MergeCall[] };
  conflictService: IConflictResolutionService & { _calls: ResolveCall[] };
  onMergeCompleteCalls: number;
} {
  const gitService =
    (overrides.gitService as (IGitService & { _mergeCalls: MergeCall[] }) | undefined) ??
    makeGitService();
  const conflictService = overrides.conflictResolutionService ?? makeConflictService();
  let onMergeCompleteCalls = 0;
  const dialog = new TestMergeDialog(makeContext(), {
    repo: overrides.repo ?? makeRepo(),
    sourceBranch: overrides.sourceBranch ?? 'feature/x',
    gitService,
    conflictResolutionService: conflictService,
    onMergeComplete:
      overrides.onMergeComplete ??
      (() => {
        onMergeCompleteCalls += 1;
      }),
  });
  return {
    dialog,
    gitService: gitService as IGitService & { _mergeCalls: MergeCall[] },
    conflictService: conflictService as IConflictResolutionService & { _calls: ResolveCall[] },
    get onMergeCompleteCalls() {
      return onMergeCompleteCalls;
    },
  } as ReturnType<typeof makeDialog>;
}

// ─── resolveMergeMutex ───────────────────────────────────────────────────────

describe('resolveMergeMutex', () => {
  const zero: IMergeFlagState = { ffOnly: false, noFf: false, squash: false, noCommit: false };

  it('passes through when no strategy flag is set', () => {
    const out = resolveMergeMutex({ ...zero, noCommit: true });
    assert.deepStrictEqual(out, { ...zero, noCommit: true });
  });

  it('ffOnly toggled: clears noFf and squash', () => {
    const out = resolveMergeMutex({ ...zero, ffOnly: true, noFf: true, squash: true }, 'ffOnly');
    assert.strictEqual(out.ffOnly, true);
    assert.strictEqual(out.noFf, false);
    assert.strictEqual(out.squash, false);
  });

  it('noFf toggled: clears ffOnly and squash', () => {
    const out = resolveMergeMutex({ ...zero, ffOnly: true, noFf: true, squash: true }, 'noFf');
    assert.strictEqual(out.ffOnly, false);
    assert.strictEqual(out.noFf, true);
    assert.strictEqual(out.squash, false);
  });

  it('squash toggled: clears ffOnly and noFf', () => {
    const out = resolveMergeMutex({ ...zero, ffOnly: true, noFf: true, squash: true }, 'squash');
    assert.strictEqual(out.ffOnly, false);
    assert.strictEqual(out.noFf, false);
    assert.strictEqual(out.squash, true);
  });

  it('no lastToggled + multiple strategy flags on: keeps the first (ffOnly)', () => {
    const out = resolveMergeMutex({ ...zero, ffOnly: true, noFf: true, squash: true });
    assert.strictEqual(out.ffOnly, true);
    assert.strictEqual(out.noFf, false);
    assert.strictEqual(out.squash, false);
  });

  it('preserves noCommit across mutex resolution', () => {
    const out = resolveMergeMutex(
      { ffOnly: true, noFf: true, squash: false, noCommit: true },
      'ffOnly'
    );
    assert.strictEqual(out.noCommit, true);
  });
});

// ─── GitService.mergeBranch arg construction ─────────────────────────────────

describe('GitService.mergeBranch — arg order', () => {
  function installGitService(): { gitService: GitService; executed: string[][] } {
    const gitService = new GitService();
    const executed: string[][] = [];
    const gitCli = {
      onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
      exec: async (args: string[]) => {
        executed.push([...args]);
        // `rev-parse HEAD` is called on success; return a hash.
        if (args[0] === 'rev-parse') {
          return { exitCode: 0, stdout: 'abc123\n', stderr: '', combined: 'abc123\n' };
        }
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      },
      invalidateCache: () => {},
    };
    (gitService as unknown as { _gitCli: unknown })._gitCli = gitCli;
    return { gitService, executed };
  }

  it('no options → `git merge <branch>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x');
    assert.deepStrictEqual(executed[0], ['merge', '--end-of-options', 'feature/x']);
  });

  it('ffOnly → `git merge --ff-only <branch>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x', { ffOnly: true });
    assert.deepStrictEqual(executed[0], ['merge', '--ff-only', '--end-of-options', 'feature/x']);
  });

  it('noFf → `git merge --no-ff <branch>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x', { noFf: true });
    assert.deepStrictEqual(executed[0], ['merge', '--no-ff', '--end-of-options', 'feature/x']);
  });

  it('squash → `git merge --squash <branch>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x', { squash: true });
    assert.deepStrictEqual(executed[0], ['merge', '--squash', '--end-of-options', 'feature/x']);
  });

  it('noCommit → `git merge --no-commit <branch>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x', { noCommit: true });
    assert.deepStrictEqual(executed[0], ['merge', '--no-commit', '--end-of-options', 'feature/x']);
  });

  it('message → `-m <msg>` preserved', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x', { message: 'Merge X' });
    assert.deepStrictEqual(executed[0], [
      'merge',
      '-m',
      'Merge X',
      '--end-of-options',
      'feature/x',
    ]);
  });

  it('empty message → no -m flag', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x', { message: '' });
    assert.deepStrictEqual(executed[0], ['merge', '--end-of-options', 'feature/x']);
  });

  it('combined: noFf + noCommit + message → strategy, noCommit, -m, branch', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x', {
      noFf: true,
      noCommit: true,
      message: 'X',
    });
    // Refs follow `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'merge',
      '--no-ff',
      '--no-commit',
      '-m',
      'X',
      '--end-of-options',
      'feature/x',
    ]);
  });

  it('ffOnly + noFf both true: CLI-precedence picks ffOnly', async () => {
    const { gitService, executed } = installGitService();
    await gitService.mergeBranch(makeRepo(), 'feature/x', { ffOnly: true, noFf: true });
    assert.deepStrictEqual(executed[0], ['merge', '--ff-only', '--end-of-options', 'feature/x']);
  });
});

// ─── Dialog lifecycle ────────────────────────────────────────────────────────

describe('MergeDialog — lifecycle', () => {
  it('cancel disposes without invoking git', async () => {
    installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({ type: 'cancel' });
    assert.strictEqual(h.gitService._mergeCalls.length, 0);
    assert.strictEqual(h.dialog.disposed(), true);
  });

  it('merge with all flags false: plain mergeBranch call', async () => {
    installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({ type: 'merge', flags: {}, message: '' });
    assert.strictEqual(h.gitService._mergeCalls.length, 1);
    const opts = h.gitService._mergeCalls[0].options;
    assert.strictEqual(opts?.ffOnly, undefined);
    assert.strictEqual(opts?.noFf, undefined);
    assert.strictEqual(opts?.squash, undefined);
    assert.strictEqual(opts?.noCommit, undefined);
    assert.strictEqual(opts?.message, undefined);
  });

  it('merge with ffOnly flag passes through to options', async () => {
    installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({ type: 'merge', flags: { ffOnly: true } });
    assert.strictEqual(h.gitService._mergeCalls[0].options?.ffOnly, true);
  });

  it('merge with message trimmed and included', async () => {
    installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({
      type: 'merge',
      flags: { noFf: true },
      message: 'Release merge',
    });
    const opts = h.gitService._mergeCalls[0].options;
    assert.strictEqual(opts?.noFf, true);
    assert.strictEqual(opts?.message, 'Release merge');
  });

  it('threads --no-verify / --allow-unrelated-histories through to options (#P2)', async () => {
    installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({
      type: 'merge',
      flags: {},
      noVerify: true,
      allowUnrelatedHistories: true,
    });
    const opts = h.gitService._mergeCalls[0].options;
    assert.strictEqual(opts?.noVerify, true);
    assert.strictEqual(opts?.allowUnrelatedHistories, true);
  });

  it('omits the independent flags when not set', async () => {
    installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({ type: 'merge', flags: {} });
    const opts = h.gitService._mergeCalls[0].options;
    assert.strictEqual(opts?.noVerify, undefined);
    assert.strictEqual(opts?.allowUnrelatedHistories, undefined);
  });

  it('merge success: info toast fires, dialog disposes, onMergeComplete called', async () => {
    const log = installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({ type: 'merge' });
    assert.strictEqual(log.info.length, 1);
    assert.ok(log.info[0].includes('feature/x'));
    assert.strictEqual(h.dialog.disposed(), true);
    assert.strictEqual(h.onMergeCompleteCalls, 1);
  });

  it('merge conflict: routes through openResolveConflictsDialog with operation=merge', async () => {
    installMessageTrackers();
    const gitService = makeGitService({ success: false, conflicts: ['a.ts', 'b.ts'] });
    const h = makeDialog({ gitService });
    await h.dialog.simulateMessage({ type: 'merge' });
    assert.strictEqual(h.conflictService._calls.length, 1);
    const call = h.conflictService._calls[0];
    assert.strictEqual(call.opContext.operation, 'merge');
    assert.strictEqual(call.opContext.target, 'feature/x');
    assert.strictEqual(call.opContext.canAbort, true);
    assert.strictEqual(call.opContext.canContinue, true);
    assert.deepStrictEqual(call.conflicts, [
      { path: 'a.ts', resolved: false },
      { path: 'b.ts', resolved: false },
    ]);
    assert.strictEqual(h.dialog.disposed(), true);
  });

  it('defensive mutex: caller sends ffOnly + squash, only ffOnly reaches git', async () => {
    installMessageTrackers();
    const h = makeDialog();
    await h.dialog.simulateMessage({
      type: 'merge',
      flags: { ffOnly: true, squash: true, noFf: true },
    });
    const opts = h.gitService._mergeCalls[0].options;
    assert.strictEqual(opts?.ffOnly, true);
    assert.strictEqual(opts?.squash, undefined);
    assert.strictEqual(opts?.noFf, undefined);
  });

  // `_executeMerge` catch block must run the raw
  // git stderr through `sanitizeGitError` before pushing it into the
  // showErrorMessage toast template. Pre-fix, MergeDialog.ts:407
  // concatenated `error.message` directly, so credentialed remote URLs
  // (e.g. https://x:token@github.com/o/r.git in `fatal: unable to
  // access`) and POSIX home paths leaked into the user's notification
  // history.
  it('TL-72 — merge failure toast sanitizes credentialed URL + home path', async () => {
    const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';
    const log = installMessageTrackers();
    const gitService = makeGitService(undefined, new Error(RAW));
    const h = makeDialog({ gitService });
    await h.dialog.simulateMessage({ type: 'merge' });

    assert.strictEqual(log.error.length, 1, 'expected one error toast');
    assert.strictEqual(log.error[0], `Failed to merge: ${EXPECTED}`);
    assert.ok(!log.error[0].includes('alice:secret'), 'toast must not leak credentials');
    assert.ok(!log.error[0].includes('/Users/alice'), 'toast must not leak home path');
  });
});

/**
 * Run the dialog's inline nonce'd script in jsdom, mirroring how the webview
 * host executes it. The post-migration contract is that the script BUILDS the
 * body via `document.createElement` — the host markup ships an empty root, not
 * pre-baked controls. Returns the live document + the posted messages.
 */
function runMergeDialogScript(dialog: MergeDialog): {
  document: Document;
  posted: unknown[];
} {
  const html = (dialog as unknown as { _panel: { webview: { html: string } } })._panel.webview.html;
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const window = dom.window;
  const posted: unknown[] = [];
  (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
    postMessage: (m: unknown): void => {
      posted.push(m);
    },
    getState: (): void => {},
    setState: (): void => {},
  });

  // Migration contract: controls are NOT pre-baked into the host markup.
  assert.strictEqual(
    window.document.querySelector('input[type="checkbox"]'),
    null,
    'flag checkboxes must not be pre-baked in host markup — the script builds the DOM'
  );

  const scriptEl = window.document.querySelector('script[nonce]');
  assert.ok(scriptEl, 'a nonce-tagged inline script must be present');
  window.eval(scriptEl.textContent ?? '');

  return { document: window.document as unknown as Document, posted };
}

describe('MergeDialog — rendered DOM (script-built)', () => {
  it('builds the source/target summary from host data via textContent', () => {
    const { dialog } = makeDialog({ sourceBranch: 'feature/x' });
    const { document } = runMergeDialogScript(dialog);
    const summary = document.querySelector('.summary');
    assert.ok(summary, 'script must build the summary block');
    assert.ok(summary.textContent?.includes('feature/x'), 'summary shows the source branch');
    assert.ok(summary.textContent?.includes('main'), 'summary shows the target branch');
  });

  it('builds all six option checkboxes and a merge-message textarea', () => {
    const { dialog } = makeDialog();
    const { document } = runMergeDialogScript(dialog);
    for (const id of [
      'flag-ffOnly',
      'flag-noFf',
      'flag-squash',
      'flag-noCommit',
      'flag-noVerify',
      'flag-allowUnrelatedHistories',
    ]) {
      assert.ok(document.querySelector('#' + id), `script must build #${id}`);
    }
    assert.ok(document.querySelector('textarea#merge-message'), 'script must build the textarea');
    assert.ok(document.querySelector('#merge-btn'), 'script must build the Merge button');
    assert.ok(document.querySelector('#cancel-btn'), 'script must build the Cancel button');
  });

  it('enforces the strategy mutex client-side (ffOnly clears noFf/squash)', () => {
    const { dialog } = makeDialog();
    const { document } = runMergeDialogScript(dialog);
    const win = dialog2Window(document);
    const noFf = document.querySelector('#flag-noFf') as HTMLInputElement;
    const ffOnly = document.querySelector('#flag-ffOnly') as HTMLInputElement;
    noFf.checked = true;
    ffOnly.checked = true;
    ffOnly.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.strictEqual(noFf.checked, false, 'enabling ffOnly must clear noFf (mutex)');
  });

  it('Merge posts the flag state; Cancel posts a cancel message', () => {
    const { dialog } = makeDialog();
    const { document, posted } = runMergeDialogScript(dialog);
    (document.querySelector('#flag-squash') as HTMLInputElement).checked = true;
    (document.querySelector('#merge-btn') as HTMLButtonElement).click();
    const last = posted.at(-1) as { type: string; flags: { squash: boolean } };
    assert.strictEqual(last.type, 'merge', 'Merge posts a merge message');
    assert.strictEqual(last.flags.squash, true, 'the squash flag is carried');

    (document.querySelector('#cancel-btn') as HTMLButtonElement).click();
    assert.deepEqual(posted.at(-1), { type: 'cancel' }, 'Cancel posts a cancel message');
  });
});

/** Resolve the jsdom window from a document so tests can construct Events. */
function dialog2Window(document: Document): typeof globalThis {
  return (document.defaultView ?? globalThis) as unknown as typeof globalThis;
}
