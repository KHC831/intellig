/**
 * Unit tests for the New Branch Dialog.
 *
 * Covers:
 *  - `validateNewBranchName` — empty / whitespace / valid shapes / invalid chars.
 *  - `looksRemoteStartPoint` — bare `origin/main` → true; `HEAD`, commit
 *    hashes, tag-like `v1.2.3`, and `undefined` → false.
 *  - `GitService.createBranch` — arg construction for every option shape:
 *    legacy string startPoint, options object, force, track, checkout,
 *    checkout + force (uses `-B` in one atomic `git checkout`).
 *  - `NewBranchDialog._onMessage`:
 *      * cancel → dispose, no git call.
 *      * empty name → error toast (from the validator), no git call.
 *      * valid create → createBranch with correct option object; success
 *        toast + onBranchCreated fired; dialog disposed.
 *      * create error (e.g. branch exists w/o overwrite) → error toast,
 *        dialog remains open for retry.
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
import { okAsync, errAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { CommandFailedError } from '../../../src/git-core/errors';
import {
  NewBranchDialog,
  INewBranchDialogOptions,
  isTrackableStartPoint,
  looksRemoteStartPoint,
  validateNewBranchName,
} from '../../../src/branches/NewBranchDialog';
import {
  ICreateBranchOptions,
  IGitService,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
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

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

interface CreateBranchCall {
  repo: IRepository;
  name: string;
  options?: string | ICreateBranchOptions;
}

function makeGitService(shouldThrow?: Error): IGitService & { _createCalls: CreateBranchCall[] } {
  const calls: CreateBranchCall[] = [];
  return {
    _createCalls: calls,
    createBranch: (repo: IRepository, name: string, options?: string | ICreateBranchOptions) => {
      calls.push({ repo, name, options });
      if (shouldThrow) {
        return errAsync(new CommandFailedError(1, '', shouldThrow.message));
      }
      return okAsync(undefined);
    },
    reloadRepository: async () => undefined,
  } as unknown as IGitService & { _createCalls: CreateBranchCall[] };
}

interface MessageLog {
  info: string[];
  error: string[];
}

function installMessageTrackers(): MessageLog {
  const log: MessageLog = { info: [], error: [] };
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
  return log;
}

class TestNewBranchDialog extends NewBranchDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
  public disposed(): boolean {
    return (this as unknown as { _disposed: boolean })._disposed;
  }
}

function makeDialog(overrides: Partial<INewBranchDialogOptions> = {}): {
  dialog: TestNewBranchDialog;
  gitService: IGitService & { _createCalls: CreateBranchCall[] };
  onCreatedCalls: number;
} {
  const gitService =
    (overrides.gitService as (IGitService & { _createCalls: CreateBranchCall[] }) | undefined) ??
    makeGitService();
  let onCreatedCalls = 0;
  const dialog = new TestNewBranchDialog(makeContext(), {
    repo: overrides.repo ?? makeRepo(),
    gitService,
    startPoint: overrides.startPoint,
    defaultName: overrides.defaultName,
    onBranchCreated:
      overrides.onBranchCreated ??
      (() => {
        onCreatedCalls += 1;
      }),
  });
  return {
    dialog,
    gitService: gitService as IGitService & { _createCalls: CreateBranchCall[] },
    get onCreatedCalls() {
      return onCreatedCalls;
    },
  } as ReturnType<typeof makeDialog>;
}

// ─── validateNewBranchName ───────────────────────────────────────────────────

describe('validateNewBranchName', () => {
  it('rejects empty name', () => {
    assert.ok(validateNewBranchName(''));
  });

  it('rejects whitespace-only name', () => {
    assert.ok(validateNewBranchName('   '));
  });

  it('accepts simple name', () => {
    assert.strictEqual(validateNewBranchName('feature'), undefined);
  });

  it('accepts nested name', () => {
    assert.strictEqual(validateNewBranchName('feature/my-branch'), undefined);
  });

  it('accepts dots and hyphens', () => {
    assert.strictEqual(validateNewBranchName('release/v1.2.3-rc.1'), undefined);
  });

  it('rejects spaces', () => {
    assert.ok(validateNewBranchName('my branch'));
  });

  it('rejects colons', () => {
    assert.ok(validateNewBranchName('foo:bar'));
  });

  it('rejects quotes', () => {
    assert.ok(validateNewBranchName('foo"bar'));
  });

  // C-2: SR-3 ref-dash parity. Git parses `-foo` as a CLI flag,
  // bypassing argv-spawn defense. `.hidden` is invalid per
  // git-check-ref-format. Both must be rejected at the dialog boundary.
  it('rejects leading dash (R5 C-2)', () => {
    assert.ok(validateNewBranchName('-foo'));
  });

  it('rejects leading dot (R5 C-2)', () => {
    assert.ok(validateNewBranchName('.hidden'));
  });

  it('accepts dash after a leading letter (R5 C-2)', () => {
    // Only the first character is restricted; embedded dashes are fine.
    assert.strictEqual(validateNewBranchName('feature-x'), undefined);
  });
});

// ─── looksRemoteStartPoint ───────────────────────────────────────────────────

describe('looksRemoteStartPoint', () => {
  it('undefined → false', () => {
    assert.strictEqual(looksRemoteStartPoint(undefined), false);
  });

  it('HEAD → false (no slash)', () => {
    assert.strictEqual(looksRemoteStartPoint('HEAD'), false);
  });

  it('main → false (no slash)', () => {
    assert.strictEqual(looksRemoteStartPoint('main'), false);
  });

  it('origin/main → true', () => {
    assert.strictEqual(looksRemoteStartPoint('origin/main'), true);
  });

  it('upstream/feature/x → true', () => {
    assert.strictEqual(looksRemoteStartPoint('upstream/feature/x'), true);
  });

  it('refs/remotes/origin/main → true', () => {
    assert.strictEqual(looksRemoteStartPoint('refs/remotes/origin/main'), true);
  });

  it('commit hash abc1234 (no slash) → false', () => {
    assert.strictEqual(looksRemoteStartPoint('abc1234'), false);
  });

  it('commit-hash-prefixed slash path like abc1234/subtree → false', () => {
    // Heuristic: first segment hex-only = commit hash, not a remote.
    assert.strictEqual(looksRemoteStartPoint('abc1234/subtree'), false);
  });
});

// ─── GitService.createBranch arg construction ────────────────────────────────

describe('GitService.createBranch — arg order', () => {
  function installGitService(): { gitService: GitService; executed: string[][] } {
    const gitService = new GitService();
    const executed: string[][] = [];
    const gitCli = {
      onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
      exec: async (args: string[]) => {
        executed.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '', combined: '' };
      },
      invalidateCache: () => {},
    };
    (gitService as unknown as { _gitCli: unknown })._gitCli = gitCli;
    return { gitService, executed };
  }

  it('legacy string startPoint → `git branch <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', 'main');
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], ['branch', 'feature/x', '--end-of-options', 'main']);
  });

  it('no startPoint → `git branch <name>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x');
    assert.deepStrictEqual(executed[0], ['branch', 'feature/x']);
  });

  it('options.startPoint → `git branch <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', { startPoint: 'main' });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], ['branch', 'feature/x', '--end-of-options', 'main']);
  });

  it('options.force → `git branch -f <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', { startPoint: 'main', force: true });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], ['branch', '-f', 'feature/x', '--end-of-options', 'main']);
  });

  it('options.track → `git branch --track <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', {
      startPoint: 'origin/main',
      track: true,
    });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'branch',
      '--track',
      'feature/x',
      '--end-of-options',
      'origin/main',
    ]);
  });

  it('options.checkout → `git checkout -b <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', {
      startPoint: 'main',
      checkout: true,
    });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'checkout',
      '-b',
      'feature/x',
      '--end-of-options',
      'main',
    ]);
  });

  it('options.checkout + force → `git checkout -B <name> <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', {
      startPoint: 'main',
      checkout: true,
      force: true,
    });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'checkout',
      '-B',
      'feature/x',
      '--end-of-options',
      'main',
    ]);
  });

  it('options.checkout + track → `git checkout -b <name> --track <startPoint>`', async () => {
    const { gitService, executed } = installGitService();
    await gitService.createBranch(makeRepo(), 'feature/x', {
      startPoint: 'origin/main',
      checkout: true,
      track: true,
    });
    // startPoint follows `--end-of-options`.
    assert.deepStrictEqual(executed[0], [
      'checkout',
      '-b',
      'feature/x',
      '--track',
      '--end-of-options',
      'origin/main',
    ]);
  });

  // C-2: service-boundary defense. Even if an upstream caller
  // skips validateNewBranchName, createBranch must reject names that
  // git would parse as CLI flags (`-foo`) or invalid ref shapes (`.hidden`).
  it('refuses leading dash at the service boundary (R5 C-2)', async () => {
    const { gitService, executed } = installGitService();
    // The validation reject is now a typed Err (createBranch returns a Result);
    // the security invariant (no exec for an invalid name) is preserved.
    const result = await gitService.createBranch(makeRepo(), '-foo', { startPoint: 'main' });
    assert.ok(result.isErr());
    assert.match(result.error.message, /Invalid branch name/);
    assert.strictEqual(executed.length, 0, 'no git command should have been issued');
  });

  it('refuses leading dot at the service boundary (R5 C-2)', async () => {
    const { gitService, executed } = installGitService();
    const result = await gitService.createBranch(makeRepo(), '.hidden');
    assert.ok(result.isErr());
    assert.match(result.error.message, /Invalid branch name/);
    assert.strictEqual(executed.length, 0);
  });

  it('refuses empty name at the service boundary (R5 C-2)', async () => {
    const { gitService, executed } = installGitService();
    const result = await gitService.createBranch(makeRepo(), '');
    assert.ok(result.isErr());
    assert.match(result.error.message, /Invalid branch name/);
    assert.strictEqual(executed.length, 0);
  });
});

// ─── Dialog lifecycle ────────────────────────────────────────────────────────

describe('NewBranchDialog — lifecycle', () => {
  it('cancel disposes without invoking git', async () => {
    installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({ type: 'cancel' });
    assert.strictEqual(h.gitService._createCalls.length, 0);
    assert.strictEqual(h.dialog.disposed(), true);
  });

  it('empty name: error toast, no git call', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({ type: 'create', name: '' });
    assert.strictEqual(h.gitService._createCalls.length, 0);
    assert.strictEqual(log.error.length, 1);
    assert.ok(log.error[0].includes('empty'));
  });

  it('invalid chars: error toast, no git call', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({ type: 'create', name: 'my branch' });
    assert.strictEqual(h.gitService._createCalls.length, 0);
    assert.strictEqual(log.error.length, 1);
    assert.ok(log.error[0].includes('invalid'));
  });

  it('valid create with checkout + track: passes options through', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ startPoint: 'origin/main' });
    await h.dialog.simulateMessage({
      type: 'create',
      name: 'feature/new',
      track: true,
      overwrite: false,
      checkout: true,
    });
    assert.strictEqual(h.gitService._createCalls.length, 1);
    const call = h.gitService._createCalls[0];
    assert.strictEqual(call.name, 'feature/new');
    const opts = call.options as ICreateBranchOptions;
    assert.strictEqual(opts.startPoint, 'origin/main');
    assert.strictEqual(opts.track, true);
    assert.strictEqual(opts.checkout, true);
    assert.strictEqual(opts.force, false);
    assert.strictEqual(log.info.length, 1);
    assert.ok(log.info[0].includes('feature/new'));
    assert.ok(log.info[0].includes('switched')); // "Created and switched to…"
    assert.strictEqual(h.onCreatedCalls, 1);
    assert.strictEqual(h.dialog.disposed(), true);
  });

  it('overwrite flag maps to force: true', async () => {
    installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({
      type: 'create',
      name: 'feature/new',
      overwrite: true,
      checkout: false,
    });
    const opts = h.gitService._createCalls[0].options as ICreateBranchOptions;
    assert.strictEqual(opts.force, true);
  });

  it('no-checkout: info toast says "Created" not "switched"', async () => {
    const log = installMessageTrackers();
    const h = makeDialog({ startPoint: 'main' });
    await h.dialog.simulateMessage({
      type: 'create',
      name: 'feature/new',
      checkout: false,
    });
    assert.strictEqual(log.info.length, 1);
    assert.ok(!log.info[0].includes('switched'));
    assert.ok(log.info[0].includes('Created'));
  });

  it('createBranch throws: error toast shown, dialog not disposed', async () => {
    const log = installMessageTrackers();
    const gitService = makeGitService(new Error("branch 'feature/new' already exists"));
    const h = makeDialog({ startPoint: 'main', gitService });
    await h.dialog.simulateMessage({
      type: 'create',
      name: 'feature/new',
      checkout: true,
    });
    assert.strictEqual(log.error.length, 1);
    assert.ok(log.error[0].includes('already exists'));
    assert.strictEqual(h.dialog.disposed(), false, 'dialog stays open so user can retry');
  });
});

// ─── rendered DOM (script-built) ─────────────────────────────────────────────

/**
 * Run the dialog's inline nonce'd script in jsdom. Post-migration contract:
 * the script BUILDS the body via document.createElement — the host markup
 * ships an empty root, not pre-baked controls.
 */
function runNewBranchScript(dialog: NewBranchDialog): {
  document: Document;
  window: typeof globalThis;
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

  assert.strictEqual(
    window.document.querySelector('input#branch-name'),
    null,
    'controls must not be pre-baked in host markup — the script builds the DOM'
  );

  const scriptEl = window.document.querySelector('script[nonce]');
  assert.ok(scriptEl, 'a nonce-tagged inline script must be present');
  window.eval(scriptEl.textContent ?? '');

  return {
    document: window.document as unknown as Document,
    window: window as unknown as typeof globalThis,
    posted,
  };
}

describe('NewBranchDialog — rendered DOM (script-built)', () => {
  it('builds the name input seeded with the default name', () => {
    const { dialog } = makeDialog({ defaultName: 'feature/seed' });
    const { document } = runNewBranchScript(dialog);
    const input = document.querySelector('input#branch-name') as HTMLInputElement;
    assert.ok(input, 'script must build #branch-name');
    assert.strictEqual(input.value, 'feature/seed', 'name input seeded with the default name');
    assert.ok(document.querySelector('#name-error'), 'script must build the error region');
  });

  it('builds the three option checkboxes; checkout defaults checked', () => {
    const { dialog } = makeDialog();
    const { document } = runNewBranchScript(dialog);
    assert.ok(document.querySelector('#flag-track'), 'script must build #flag-track');
    assert.ok(document.querySelector('#flag-overwrite'), 'script must build #flag-overwrite');
    const checkout = document.querySelector('#flag-checkout') as HTMLInputElement;
    assert.ok(checkout, 'script must build #flag-checkout');
    assert.strictEqual(checkout.checked, true, 'checkout-after-create defaults to checked');
  });

  it('defaults --track checked when the start point looks remote', () => {
    const { dialog } = makeDialog({ startPoint: 'origin/main' });
    const { document } = runNewBranchScript(dialog);
    const track = document.querySelector('#flag-track') as HTMLInputElement;
    assert.strictEqual(track.checked, true, 'remote start point defaults --track on');
  });

  it('shows the start point in the summary via textContent', () => {
    const { dialog } = makeDialog({ startPoint: 'origin/main' });
    const { document } = runNewBranchScript(dialog);
    const summary = document.querySelector('.summary');
    assert.ok(summary?.textContent?.includes('origin/main'), 'summary shows the start point');
  });

  it('disables Create on an empty name and posts a create message on a valid one', () => {
    const { dialog } = makeDialog({ defaultName: '' });
    const { document, window } = runNewBranchScript(dialog);
    const create = document.querySelector('#create-btn') as HTMLButtonElement;
    assert.strictEqual(create.disabled, true, 'Create is disabled while the name is empty');

    const name = document.querySelector('#branch-name') as HTMLInputElement;
    name.value = 'feature/ok';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.strictEqual(create.disabled, false, 'a valid name enables Create');
  });

  it('Cancel posts a cancel message', () => {
    const { dialog } = makeDialog();
    const { document, posted } = runNewBranchScript(dialog);
    (document.querySelector('#cancel-btn') as HTMLButtonElement).click();
    assert.deepEqual(posted.at(-1), { type: 'cancel' }, 'Cancel posts a cancel message');
  });
});

// ─── Track-remote gating ─────────────────────────────────────────────────────

describe('isTrackableStartPoint', () => {
  it('no start point (HEAD) → true: --track tracks the current branch', () => {
    assert.strictEqual(isTrackableStartPoint(undefined), true);
  });

  it('a commit hash is never trackable', () => {
    assert.strictEqual(isTrackableStartPoint('a'.repeat(40)), false);
    assert.strictEqual(isTrackableStartPoint('abc1234'), false);
  });

  it('remote-looking start point without context → true (heuristic)', () => {
    assert.strictEqual(isTrackableStartPoint('origin/main'), true);
    assert.strictEqual(isTrackableStartPoint('refs/remotes/origin/main'), true);
  });

  it('bare name without context → true (git stays the final authority)', () => {
    assert.strictEqual(isTrackableStartPoint('main'), true);
  });

  it('a known local branch is trackable', () => {
    assert.strictEqual(
      isTrackableStartPoint('main', { localBranches: ['main'], remoteBranches: [] }),
      true
    );
  });

  it('a known remote branch is trackable (context stores stripped names)', () => {
    assert.strictEqual(
      isTrackableStartPoint('origin/feature/x', {
        localBranches: [],
        remoteBranches: ['feature/x'],
      }),
      true
    );
  });

  it('a name the loaded branch list does not contain (e.g. a tag) is not trackable', () => {
    assert.strictEqual(
      isTrackableStartPoint('v1.2.3', { localBranches: ['main'], remoteBranches: ['main'] }),
      false
    );
    assert.strictEqual(
      isTrackableStartPoint('release/v1', { localBranches: ['main'], remoteBranches: ['main'] }),
      false
    );
  });

  it('an empty (load-failed) context is permissive: only a commit hash blocks', () => {
    assert.strictEqual(isTrackableStartPoint('origin/main', {}), true);
    assert.strictEqual(isTrackableStartPoint('main', {}), true);
    assert.strictEqual(isTrackableStartPoint('a'.repeat(40), {}), false);
  });
});

describe('NewBranchDialog — Track checkbox gating', () => {
  it('a commit-hash start point renders with the track row hidden', () => {
    const { dialog } = makeDialog({ startPoint: 'a'.repeat(40) });
    const { document } = runNewBranchScript(dialog);
    const row = document.querySelector('#track-row') as HTMLElement;
    assert.ok(row, 'script must build the track row');
    assert.strictEqual(row.hidden, true, 'track row hidden for a non-branch start point');
  });

  it('a remote start point renders with the track row visible and checked', () => {
    const { dialog } = makeDialog({ startPoint: 'origin/main' });
    const { document } = runNewBranchScript(dialog);
    const row = document.querySelector('#track-row') as HTMLElement;
    assert.strictEqual(row.hidden, false, 'track row visible for a remote start point');
    const box = document.querySelector('#flag-track') as HTMLInputElement;
    assert.strictEqual(box.checked, true, 'track defaults on for a remote start point');
  });

  it('a conflicts message that marks the start point untrackable hides and unchecks track', () => {
    const { dialog } = makeDialog({ startPoint: 'release/v1' });
    const { document, window } = runNewBranchScript(dialog);
    const row = document.querySelector('#track-row') as HTMLElement;
    const box = document.querySelector('#flag-track') as HTMLInputElement;
    assert.strictEqual(row.hidden, false, 'precondition: slash heuristic shows the row');
    box.checked = true;

    window.dispatchEvent(
      new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent('message', {
        data: {
          type: 'conflicts',
          localBranches: ['main'],
          remoteBranches: ['main'],
          currentBranch: 'main',
          startPointTrackable: false,
        },
      })
    );
    assert.strictEqual(row.hidden, true, 'track row hides when the start point is not a branch');
    assert.strictEqual(box.checked, false, 'a hidden track row unchecks the box');
  });

  it('create with track for a commit-hash start point is blocked before git runs', async () => {
    const log = installMessageTrackers();
    const { dialog, gitService } = makeDialog({ startPoint: 'a'.repeat(40) });
    await dialog.simulateMessage({ type: 'create', name: 'feat', track: true, checkout: true });

    assert.strictEqual(gitService._createCalls.length, 0, 'no git command may run');
    assert.strictEqual(log.error.length, 1, 'the user sees why the create was blocked');
    assert.ok(/track/i.test(log.error[0]), 'the error names tracking');
    assert.strictEqual(dialog.disposed(), false, 'dialog stays open for retry');
  });

  it('create without track for a commit-hash start point still goes through', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({ startPoint: 'a'.repeat(40) });
    await dialog.simulateMessage({ type: 'create', name: 'feat', track: false, checkout: true });
    assert.strictEqual(gitService._createCalls.length, 1, 'create must run');
    assert.strictEqual(dialog.disposed(), true, 'dialog closes on success');
  });
});

describe('NewBranchDialog — deterministic post-create refresh', () => {
  it('a rejecting reload does not masquerade as a failed create', async () => {
    const log = installMessageTrackers();
    const gitService = makeGitService();
    gitService.reloadRepository = (async () => {
      throw new Error('index.lock contention');
    }) as unknown as IGitService['reloadRepository'];
    let created = 0;
    const { dialog } = makeDialog({
      gitService,
      startPoint: 'origin/main',
      onBranchCreated: () => {
        created += 1;
      },
    });
    await dialog.simulateMessage({ type: 'create', name: 'feat', track: true, checkout: true });

    assert.strictEqual(log.error.length, 0, 'the branch WAS created — no failure toast');
    assert.strictEqual(log.info.length, 1, 'success toast still shows');
    assert.strictEqual(created, 1, 'refresh callback still fires');
    assert.strictEqual(dialog.disposed(), true, 'dialog closes on success');
  });

  it('a successful create reloads the repository before onBranchCreated fires', async () => {
    installMessageTrackers();
    const order: string[] = [];
    const gitService = makeGitService();
    gitService.reloadRepository = (async () => {
      order.push('reload');
      return undefined;
    }) as IGitService['reloadRepository'];
    const { dialog } = makeDialog({
      gitService,
      startPoint: 'origin/main',
      onBranchCreated: () => {
        order.push('created');
      },
    });
    await dialog.simulateMessage({ type: 'create', name: 'feat', track: true, checkout: true });

    assert.deepStrictEqual(
      order,
      ['reload', 'created'],
      'reload must land before the graph/branch refresh callback so no view can repaint from a stale cache'
    );
  });
});
