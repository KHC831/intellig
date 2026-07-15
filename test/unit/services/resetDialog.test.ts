/**
 * Unit tests for ResetDialog.
 *
 * Covers:
 *  - each mode maps to the correct `git reset` flag (soft/mixed/hard/keep)
 *  - default selection is Mixed (checked attribute in HTML)
 *  - Hard/Keep triggers the single destructive-op confirm modal;
 *    Soft/Mixed does not
 *  - Cancel at dialog OR at confirm modal → no reset
 *  - Protected branches render Hard/Keep radios as `disabled` and
 *    short-circuit the `reset` message handler
 *  - Malformed commit hash surfaces as an error via the toast path
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import { okAsync, ResultAsync } from 'neverthrow';
import { SpawnFailedError } from '../../../src/git-core/errors';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { extractWebviewScript } from '../../helpers/webviewHtml';
import type * as vscode from 'vscode';
import { Uri as MockUri } from '../../mocks/vscode';
import {
  ResetDialog,
  IResetDialogOptions,
  isValidRef,
  resolveDefaultMode,
  showResetDialog,
} from '../../../src/ui-shell/ResetDialog';
import { IGitService, IRepository, ResetMode } from '../../../src/git-core/interfaces/IGitService';
import { writableWindow } from '../../typed/windowStub';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** In-memory Memento so ResetDialog's reset-mode persistence works in tests. */
function makeMemento(): vscode.Memento {
  const data = new Map<string, unknown>();
  return {
    keys: () => Array.from(data.keys()),
    get: <T>(key: string, fallback?: T): T =>
      data.has(key) ? (data.get(key) as T) : (fallback as T),
    update: (key: string, value: unknown): Thenable<void> => {
      data.set(key, value);
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
}

function makeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    workspaceState: makeMemento(),
    globalState: makeMemento(),
    extensionPath: '/tmp/ext',
    storagePath: undefined,
    globalStoragePath: '/tmp/global',
    logPath: '/tmp/log',
    extensionUri: MockUri.file('/tmp/ext'),
    storageUri: undefined,
    globalStorageUri: MockUri.file('/tmp/global'),
    logUri: MockUri.file('/tmp/log'),
    extensionMode: 3, // Test
    asAbsolutePath: (rel: string): string => `/tmp/ext/${rel}`,
  } as unknown as vscode.ExtensionContext;
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/feature', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

interface CallLog {
  method: string;
  args: unknown[];
}

function makeGitService(overrides?: {
  reset?: (repo: IRepository, target: string, mode: ResetMode) => Promise<void>;
}): IGitService & { calls: CallLog[] } {
  const calls: CallLog[] = [];
  const emitter = new EventEmitter<IRepository>();
  return {
    calls,
    onDidChangeRepository: emitter.event,
    getRepository: async () => undefined,
    getRepositories: () => [],
    commit: () => okAsync(undefined),
    amend: () => okAsync(undefined),
    getBranches: async () => [],
    createBranch: async () => {},
    checkout: async () => {},
    deleteBranch: async () => {},
    renameBranch: async () => {},
    mergeBranch: async () => ({ success: true }),
    rebaseBranch: async () => ({ success: true }),
    compareBranches: async () => ({
      commitsAhead: [],
      commitsBehind: [],
      aheadCount: 0,
      behindCount: 0,
      changedFiles: [],
    }),
    fetch: () => {
      return okAsync(undefined);
    },
    pull: () => okAsync(undefined),
    push: () => okAsync(undefined),
    getRemotes: () => okAsync([]),
    addRemote: () => okAsync(undefined),
    removeRemote: () => okAsync(undefined),
    stash: async () => {},
    stashList: async () => [],
    stashApply: async () => {},
    stashPop: async () => {},
    stashDrop: async () => {},
    stashShow: async () => [],
    getTags: async () => [],
    createTag: async () => {},
    deleteTag: async () => {},
    pushTag: async () => {},
    getLog: async () => [],
    getCommit: async () => ({
      hash: '',
      shortHash: '',
      message: '',
      author: { name: '', email: '' },
      committer: { name: '', email: '' },
      parents: [],
      authorDate: new Date(),
      commitDate: new Date(),
    }),
    getFileHistory: async () => [],
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: async () => ({ success: true }),
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: async () => ({ success: true }),
    revertAbort: async () => {},
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    stage: () => okAsync(undefined),
    unstage: () => okAsync(undefined),
    stageHunk: () => okAsync(undefined),
    stageLines: () => okAsync(undefined),
    unstageHunk: () => okAsync(undefined),
    revertFile: () => okAsync(undefined),
    resetToCommit: (repo: IRepository, target: string, mode: ResetMode) => {
      calls.push({ method: 'resetToCommit', args: [repo, target, mode] });
      return ResultAsync.fromPromise(
        overrides?.reset ? overrides.reset(repo, target, mode) : Promise.resolve(),
        (e) => new SpawnFailedError(e instanceof Error ? e.message : String(e))
      );
    },
    dispose: () => {},
  } as unknown as IGitService & { calls: CallLog[] };
}

interface MessageLog {
  info: { message: string }[];
  error: { message: string }[];
  warn: { message: string; items: string[]; modal: boolean; response?: string }[];
}

/**
 * Replace `vscode.window.show*Message` with trackers. Returns the log
 * plus a helper to queue the next warning-modal response.
 */
function installMessageTrackers(): {
  log: MessageLog;
  setNextWarnResponse: (r: string | undefined) => void;
} {
  const log: MessageLog = { info: [], error: [], warn: [] };
  let nextWarnResponse: string | undefined = undefined;
  const w = writableWindow();
  w.showInformationMessage = (message: string): Promise<string | undefined> => {
    log.info.push({ message });
    return Promise.resolve(undefined);
  };
  w.showErrorMessage = (message: string): Promise<string | undefined> => {
    log.error.push({ message });
    return Promise.resolve(undefined);
  };
  w.showWarningMessage = (
    message: string,
    optionsOrFirstItem?: unknown,
    ...rest: unknown[]
  ): Promise<string | undefined> => {
    let modal = false;
    let items: string[] = [];
    const restStrings = rest.filter((i): i is string => typeof i === 'string');
    if (
      optionsOrFirstItem &&
      typeof optionsOrFirstItem === 'object' &&
      'modal' in optionsOrFirstItem
    ) {
      modal = Boolean((optionsOrFirstItem as { modal?: boolean }).modal);
      items = restStrings;
    } else if (typeof optionsOrFirstItem === 'string') {
      items = [optionsOrFirstItem, ...restStrings];
    } else {
      items = restStrings;
    }
    log.warn.push({ message, items, modal, response: nextWarnResponse });
    const r = nextWarnResponse;
    nextWarnResponse = undefined;
    return Promise.resolve(r);
  };
  return {
    log,
    setNextWarnResponse: (r: string | undefined) => {
      nextWarnResponse = r;
    },
  };
}

/**
 * Test-only subclass exposing protected hooks so we can drive message
 * handling without a real webview runtime.
 */
interface ResetDialogInternals {
  _onMessage(raw: unknown): Promise<void>;
  _panel: { webview: { html: string } };
}

class TestResetDialog extends ResetDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as ResetDialogInternals)._onMessage(raw);
  }
  public renderedHtml(): string {
    return (this as unknown as ResetDialogInternals)._panel.webview.html;
  }
}

/**
 * Narrowed opts: the test-local `gitService` override must carry the
 * `calls` log (produced by {@link makeGitService}) so suites that read
 * `calls` after construction stay type-safe without casts.
 */
type MakeDialogOpts = Omit<Partial<IResetDialogOptions>, 'gitService'> & {
  gitService?: IGitService & { calls: CallLog[] };
};

function makeDialog(opts: MakeDialogOpts = {}): {
  dialog: TestResetDialog;
  gitService: IGitService & { calls: CallLog[] };
  repo: IRepository;
} {
  const gitService = opts.gitService ?? makeGitService();
  const repo = opts.repo ?? makeRepo();
  const dialog = new TestResetDialog(makeContext(), {
    repo,
    target: opts.target ?? {
      hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80123',
      subject: 'feat: add feature',
    },
    currentBranch: opts.currentBranch ?? 'feature',
    protectedBranches: opts.protectedBranches ?? [],
    gitService,
    onResetComplete: opts.onResetComplete,
  });
  return { dialog, gitService, repo };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * Run the dialog's inline nonce'd script in jsdom. Post-migration contract:
 * the script BUILDS the body via document.createElement — the host markup
 * ships an empty root, not pre-baked radios.
 */
const _entryHarnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (_entryHarnesses.length > 0) {
    _entryHarnesses.pop()?.dispose();
  }
});

function runResetScript(dialog: TestResetDialog): { document: Document } {
  const bodyHtml = extractWebviewScript(dialog.renderedHtml()).bodyHtml;
  assert.ok(
    !/name="reset-mode"/.test(bodyHtml),
    'radios must not be pre-baked in host markup — the entry builds the DOM'
  );
  const h = bootWebviewEntry('ui-shell/webview/resetDialog', { bodyHtml });
  _entryHarnesses.push(h);
  return { document: h.document };
}

function radio(document: Document, mode: string): HTMLInputElement {
  return document.querySelector(`input[name="reset-mode"][value="${mode}"]`) as HTMLInputElement;
}

describe('ResetDialog', () => {
  describe('rendered DOM (script-built)', () => {
    it('builds all four radios (soft/mixed/hard/keep) with Mixed as the default', () => {
      const { dialog } = makeDialog();
      try {
        const { document } = runResetScript(dialog);
        for (const mode of ['soft', 'mixed', 'hard', 'keep']) {
          assert.ok(radio(document, mode), `${mode} radio built`);
        }
        assert.strictEqual(radio(document, 'mixed').checked, true, 'mixed is checked by default');
        assert.strictEqual(radio(document, 'soft').checked, false, 'soft NOT checked');
        assert.strictEqual(radio(document, 'hard').checked, false, 'hard NOT checked');
        assert.strictEqual(radio(document, 'keep').checked, false, 'keep NOT checked');
      } finally {
        dialog.dispose();
      }
    });

    it('builds the target short hash and subject via textContent', () => {
      const { dialog } = makeDialog({
        target: { hash: 'abcdef1234567890', subject: 'feat: widget' },
      });
      try {
        const { document } = runResetScript(dialog);
        const target = document.querySelector('.target');
        assert.ok(target?.textContent?.includes('abcdef12'), 'short hash rendered');
        assert.ok(target?.textContent?.includes('feat: widget'), 'subject rendered');
      } finally {
        dialog.dispose();
      }
    });

    it('renders a malicious subject as inert text (no injected script element)', () => {
      const { dialog } = makeDialog({
        target: {
          hash: 'abcdef1234567890',
          subject: '<script>alert(1)</script>',
        },
      });
      try {
        const { document } = runResetScript(dialog);
        const subject = document.querySelector('.target .subject');
        assert.strictEqual(
          subject?.textContent,
          '<script>alert(1)</script>',
          'the subject is set as literal text via textContent'
        );
        // The client code is an external bundle (no inline script in the body),
        // so a subject string that reaches the DOM via textContent spawns zero
        // <script> elements.
        assert.strictEqual(
          document.querySelectorAll('script').length,
          0,
          'subject text cannot inject a script element'
        );
      } finally {
        dialog.dispose();
      }
    });

    it('on a protected branch, Hard and Keep radios are disabled; Soft/Mixed are not', () => {
      const { dialog } = makeDialog({
        currentBranch: 'main',
        protectedBranches: ['main'],
      });
      try {
        const { document } = runResetScript(dialog);
        assert.strictEqual(radio(document, 'hard').disabled, true, 'hard disabled on protected');
        assert.strictEqual(radio(document, 'keep').disabled, true, 'keep disabled on protected');
        assert.strictEqual(radio(document, 'soft').disabled, false, 'soft stays enabled');
        assert.strictEqual(radio(document, 'mixed').disabled, false, 'mixed stays enabled');
        const hardLabel = document.querySelector('label.mode[data-mode="hard"]');
        assert.ok(
          hardLabel?.getAttribute('title')?.includes('intellig.protectedBranches'),
          'tooltip references the config key'
        );
      } finally {
        dialog.dispose();
      }
    });

    it('loads its bundle from a nonced external <script> tag (CSP-safe)', () => {
      const { dialog } = makeDialog();
      const html = dialog.renderedHtml();
      try {
        // Phase 5: the client code is a bundled entry loaded via an external
        // nonced tag; the nonce is a base64url-encoded 16 random bytes (22 chars).
        const match = html.match(
          /<script nonce="[A-Za-z0-9_-]{22}" src="[^"]*resetDialog\.js"><\/script>/
        );
        assert.ok(match, 'external bundle tag has a 22-char base64url nonce + resetDialog.js src');
      } finally {
        dialog.dispose();
      }
    });
  });

  describe('message handling — mode flag mapping', () => {
    const modes: ResetMode[] = ['soft', 'mixed', 'hard', 'keep'];

    for (const mode of modes) {
      it(`${mode} → calls gitService.resetToCommit with '${mode}'`, async () => {
        const trackers = installMessageTrackers();
        // Hard and Keep need the destructive confirm to return "Reset".
        if (mode === 'hard' || mode === 'keep') {
          trackers.setNextWarnResponse('Reset');
        }

        const { dialog, gitService } = makeDialog();
        try {
          await dialog.simulateMessage({ type: 'reset', mode });

          const call = gitService.calls.find((c) => c.method === 'resetToCommit');
          assert.ok(call, 'resetToCommit invoked');
          assert.strictEqual(call.args[2], mode);
        } finally {
          dialog.dispose();
        }
      });
    }

    it('Soft does NOT show a confirm modal', async () => {
      const trackers = installMessageTrackers();
      const { dialog } = makeDialog();
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'soft' });
        assert.strictEqual(trackers.log.warn.length, 0, 'no warning modal for soft');
      } finally {
        dialog.dispose();
      }
    });

    it('Mixed does NOT show a confirm modal', async () => {
      const trackers = installMessageTrackers();
      const { dialog } = makeDialog();
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'mixed' });
        assert.strictEqual(trackers.log.warn.length, 0, 'no warning modal for mixed');
      } finally {
        dialog.dispose();
      }
    });

    it('Hard shows a single modal confirm (not a double-confirm)', async () => {
      const trackers = installMessageTrackers();
      trackers.setNextWarnResponse('Reset');
      const { dialog, gitService } = makeDialog();
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'hard' });
        assert.strictEqual(trackers.log.warn.length, 1, 'exactly one warning modal');
        assert.strictEqual(trackers.log.warn[0].modal, true, 'warning is modal');
        assert.deepStrictEqual(
          trackers.log.warn[0].items,
          ['Reset', 'Cancel'],
          'buttons: Reset / Cancel'
        );
        assert.ok(
          gitService.calls.some((c) => c.method === 'resetToCommit'),
          'reset executed after confirm'
        );
      } finally {
        dialog.dispose();
      }
    });

    it('Keep shows the same single modal confirm', async () => {
      const trackers = installMessageTrackers();
      trackers.setNextWarnResponse('Reset');
      const { dialog, gitService } = makeDialog();
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'keep' });
        assert.strictEqual(trackers.log.warn.length, 1);
        assert.ok(gitService.calls.some((c) => c.method === 'resetToCommit'));
      } finally {
        dialog.dispose();
      }
    });
  });

  describe('cancellation paths', () => {
    it('cancel message → no reset, dialog disposes', async () => {
      installMessageTrackers();
      const { dialog, gitService } = makeDialog();
      await dialog.simulateMessage({ type: 'cancel' });
      assert.strictEqual(gitService.calls.length, 0);
      // After dispose the panel should report disposed via its internal flag.
      assert.strictEqual((dialog as unknown as { _disposed: boolean })._disposed, true);
    });

    it('cancel at destructive-confirm modal (Hard) → no reset executed', async () => {
      const trackers = installMessageTrackers();
      trackers.setNextWarnResponse('Cancel');
      const { dialog, gitService } = makeDialog();
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'hard' });
        assert.strictEqual(
          gitService.calls.filter((c) => c.method === 'resetToCommit').length,
          0,
          'no reset after cancelling confirm'
        );
        assert.strictEqual(trackers.log.warn.length, 1, 'only the confirm modal was shown');
      } finally {
        dialog.dispose();
      }
    });

    it('cancel at destructive-confirm modal (Keep) → no reset executed', async () => {
      const trackers = installMessageTrackers();
      trackers.setNextWarnResponse(undefined); // user dismissed with ESC
      const { dialog, gitService } = makeDialog();
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'keep' });
        assert.strictEqual(gitService.calls.filter((c) => c.method === 'resetToCommit').length, 0);
      } finally {
        dialog.dispose();
      }
    });
  });

  describe('protected-branch guard', () => {
    it('rejects Hard at the message boundary (belt-and-suspenders) when branch is protected', async () => {
      const trackers = installMessageTrackers();
      const { dialog, gitService } = makeDialog({
        currentBranch: 'main',
        protectedBranches: ['main'],
      });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'hard' });
        assert.strictEqual(gitService.calls.length, 0, 'no reset on protected branch');
        assert.strictEqual(trackers.log.warn.length, 1, 'one non-modal warning shown');
        assert.strictEqual(
          trackers.log.warn[0].modal,
          false,
          'the protection warning is non-modal (just informs)'
        );
        assert.ok(
          trackers.log.warn[0].message.includes('protected branch'),
          'protection message mentions the protected-branch config'
        );
      } finally {
        dialog.dispose();
      }
    });

    it('rejects Keep on a protected branch', async () => {
      installMessageTrackers();
      const { dialog, gitService } = makeDialog({
        currentBranch: 'main',
        protectedBranches: ['main'],
      });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'keep' });
        assert.strictEqual(gitService.calls.length, 0);
      } finally {
        dialog.dispose();
      }
    });

    it('allows Soft on a protected branch', async () => {
      installMessageTrackers();
      const { dialog, gitService } = makeDialog({
        currentBranch: 'main',
        protectedBranches: ['main'],
      });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'soft' });
        const resetCalls = gitService.calls.filter((c) => c.method === 'resetToCommit');
        assert.strictEqual(resetCalls.length, 1);
        assert.strictEqual(resetCalls[0].args[2], 'soft');
      } finally {
        dialog.dispose();
      }
    });

    it('allows Mixed on a protected branch', async () => {
      installMessageTrackers();
      const { dialog, gitService } = makeDialog({
        currentBranch: 'main',
        protectedBranches: ['main'],
      });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'mixed' });
        const resetCalls = gitService.calls.filter((c) => c.method === 'resetToCommit');
        assert.strictEqual(resetCalls.length, 1);
        assert.strictEqual(resetCalls[0].args[2], 'mixed');
      } finally {
        dialog.dispose();
      }
    });

    it('isProtected returns false when currentBranch not in list', () => {
      const { dialog } = makeDialog({
        currentBranch: 'feature/x',
        protectedBranches: ['main', 'master'],
      });
      try {
        assert.strictEqual(dialog.isProtected, false);
      } finally {
        dialog.dispose();
      }
    });

    it('isProtected returns true when currentBranch is in list', () => {
      const { dialog } = makeDialog({
        currentBranch: 'main',
        protectedBranches: ['main', 'master'],
      });
      try {
        assert.strictEqual(dialog.isProtected, true);
      } finally {
        dialog.dispose();
      }
    });
  });

  describe('error surfacing', () => {
    it('malformed commit hash → error toast, no reset executed', async () => {
      const trackers = installMessageTrackers();
      const { dialog, gitService } = makeDialog({
        target: { hash: 'bad hash with spaces', subject: 'nope' },
      });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'soft' });
        assert.strictEqual(
          gitService.calls.filter((c) => c.method === 'resetToCommit').length,
          0,
          'reset must not run with an invalid ref'
        );
        assert.strictEqual(trackers.log.error.length, 1);
        assert.ok(trackers.log.error[0].message.includes('Invalid commit reference'));
      } finally {
        dialog.dispose();
      }
    });

    it('gitService.resetToCommit throwing surfaces as error toast', async () => {
      const trackers = installMessageTrackers();
      const failingGitService = makeGitService({
        reset: async () => {
          throw new Error('boom from git');
        },
      });
      const { dialog } = makeDialog({ gitService: failingGitService });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'soft' });
        assert.strictEqual(trackers.log.error.length, 1);
        assert.ok(trackers.log.error[0].message.includes('boom from git'));
      } finally {
        dialog.dispose();
      }
    });

    it('successful reset shows info toast with short hash', async () => {
      const trackers = installMessageTrackers();
      const { dialog } = makeDialog({
        target: { hash: 'abcdef1234567890', subject: 'feat: thing' },
      });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'mixed' });
        assert.strictEqual(trackers.log.info.length, 1);
        assert.ok(trackers.log.info[0].message.includes('abcdef12'));
      } finally {
        dialog.dispose();
      }
    });

    it('onResetComplete callback fires after successful reset', async () => {
      installMessageTrackers();
      let called = 0;
      const { dialog } = makeDialog({
        onResetComplete: () => {
          called++;
        },
      });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'soft' });
        assert.strictEqual(called, 1);
      } finally {
        dialog.dispose();
      }
    });

    it('onResetComplete throwing does not break the flow', async () => {
      const trackers = installMessageTrackers();
      const { dialog, gitService } = makeDialog({
        onResetComplete: () => {
          throw new Error('refresh bug');
        },
      });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'soft' });
        // Reset should have still executed, and the dialog should not
        // have surfaced the callback error to the user.
        assert.strictEqual(gitService.calls.filter((c) => c.method === 'resetToCommit').length, 1);
        assert.strictEqual(trackers.log.error.length, 0, 'callback failure is logged, not toasted');
      } finally {
        dialog.dispose();
      }
    });
  });

  describe('message validation', () => {
    it('ignores unknown message types', async () => {
      installMessageTrackers();
      const { dialog, gitService } = makeDialog();
      try {
        await dialog.simulateMessage({ type: 'whatever' });
        await dialog.simulateMessage(null);
        await dialog.simulateMessage(undefined);
        await dialog.simulateMessage('string');
        assert.strictEqual(gitService.calls.length, 0);
      } finally {
        dialog.dispose();
      }
    });

    it('ignores reset with an unknown mode string', async () => {
      installMessageTrackers();
      const { dialog, gitService } = makeDialog();
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'nuclear' });
        assert.strictEqual(gitService.calls.length, 0);
      } finally {
        dialog.dispose();
      }
    });

    it('message handler is a no-op while a reset is in flight', async () => {
      installMessageTrackers();
      let release: (() => void) | undefined;
      const pending = new Promise<void>((r) => {
        release = r;
      });
      const failingGitService = makeGitService({
        reset: async () => {
          await pending;
        },
      });
      const { dialog } = makeDialog({ gitService: failingGitService });
      try {
        const first = dialog.simulateMessage({ type: 'reset', mode: 'soft' });
        // While first is in flight, subsequent messages should be ignored.
        await dialog.simulateMessage({ type: 'reset', mode: 'hard' });
        release!();
        await first;
        const calls = failingGitService.calls.filter((c) => c.method === 'resetToCommit');
        assert.strictEqual(calls.length, 1, 'only the first reset runs');
      } finally {
        dialog.dispose();
      }
    });
  });

  // ─── SR-3: leading-dash ref validation (security) ──────────────────────
  describe('isValidRef (SR-3 ref-flag-injection guard)', () => {
    it('rejects refs starting with "-" (git would parse as a flag)', () => {
      assert.strictEqual(isValidRef('-foo'), false);
      assert.strictEqual(isValidRef('-x/y'), false);
      assert.strictEqual(isValidRef('--force'), false);
    });
    it('rejects refs starting with "." (invalid git-check-ref-format)', () => {
      assert.strictEqual(isValidRef('.main'), false);
      assert.strictEqual(isValidRef('.hidden'), false);
      // And the combination `-.main` that the review brief called out.
      assert.strictEqual(isValidRef('-.main'), false);
    });
    it('accepts normal refs (main, feature/x, v1.0.0, release-1.0)', () => {
      for (const name of ['main', 'feature/x', 'v1.0.0', 'release-1.0', 'hotfix/ISS-123']) {
        assert.strictEqual(isValidRef(name), true, name);
      }
    });
    it('accepts sha1 hashes (40-char hex)', () => {
      assert.strictEqual(isValidRef('a'.repeat(40)), true);
      assert.strictEqual(isValidRef('deadbeef'), true);
    });
  });

  describe('resolveDefaultMode helper', () => {
    it('returns the preferred mode when it is not disabled', () => {
      assert.strictEqual(resolveDefaultMode('mixed', new Set()), 'mixed');
      assert.strictEqual(resolveDefaultMode('soft', new Set()), 'soft');
      assert.strictEqual(resolveDefaultMode('hard', new Set()), 'hard');
    });

    it('falls back to the next enabled mode in preference order', () => {
      // Default Mixed is disabled → fall back to first non-disabled preference:
      // 'mixed' > 'soft' > 'keep' > 'hard'. With mixed disabled and everything
      // else enabled, we get 'soft'.
      assert.strictEqual(resolveDefaultMode('mixed', new Set<ResetMode>(['mixed'])), 'soft');
    });

    it('protected-branch case: preferred=hard falls back to mixed', () => {
      const disabled = new Set<ResetMode>(['hard', 'keep']);
      // If someone later flips the default to Hard, on a protected branch
      // (hard/keep disabled) we must fall back to Mixed, not render a disabled
      // radio as still checked.
      assert.strictEqual(resolveDefaultMode('hard', disabled), 'mixed');
    });

    it('protected-branch case: preferred=keep falls back to mixed', () => {
      const disabled = new Set<ResetMode>(['hard', 'keep']);
      assert.strictEqual(resolveDefaultMode('keep', disabled), 'mixed');
    });

    it('degenerate: every mode disabled returns preferred unchanged', () => {
      const disabled = new Set<ResetMode>(['soft', 'mixed', 'hard', 'keep']);
      assert.strictEqual(resolveDefaultMode('mixed', disabled), 'mixed');
    });
  });

  describe('showResetDialog factory', () => {
    it('returns a ResetDialog instance', () => {
      installMessageTrackers();
      const gitService = makeGitService();
      const dialog = showResetDialog(makeContext(), {
        repo: makeRepo(),
        target: { hash: 'a'.repeat(40), subject: 'x' },
        currentBranch: 'feature',
        protectedBranches: [],
        gitService,
      });
      try {
        assert.ok(dialog instanceof ResetDialog);
      } finally {
        dialog.dispose();
      }
    });
  });

  // `_executeReset` catch block must run the raw git stderr through
  // `sanitizeGitError` before pushing it into the showErrorMessage toast
  // template, so credentialed remote URLs and POSIX home paths don't leak
  // into the user's notification history.
  describe('error toast sanitization', () => {
    it('reset failure toast sanitizes credentialed URL + home path', async () => {
      const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
      const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';
      const trackers = installMessageTrackers();
      const gitService = makeGitService({
        reset: () => Promise.reject(new Error(RAW)),
      });
      const { dialog } = makeDialog({ gitService });
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'soft' });

        assert.strictEqual(trackers.log.error.length, 1, 'expected one error toast');
        assert.strictEqual(trackers.log.error[0].message, `Failed to reset: ${EXPECTED}`);
        assert.ok(
          !trackers.log.error[0].message.includes('alice:secret'),
          'toast must not leak credentials'
        );
        assert.ok(
          !trackers.log.error[0].message.includes('/Users/alice'),
          'toast must not leak home path'
        );
      } finally {
        dialog.dispose();
      }
    });
  });

  // ─── Smart Reset stash bracket (R2-1: stash pin, not stash@{0}) ──────────
  describe('Smart Reset — SHA-pinned stash bracket', () => {
    interface GitExec {
      args: string[];
    }

    /** Scriptable gitCli covering the saveLocalChanges / restoreLocalChanges bracket. */
    function makeStashCli(opts: {
      statusZ: string;
      stashListRows?: string;
      popExit?: number;
      pinnedSha?: string;
    }): { gitCli: unknown; execs: GitExec[] } {
      const execs: GitExec[] = [];
      const pinnedSha = opts.pinnedSha ?? 'PINNEDSHA';
      const gitCli = {
        exec: async (args: string[]) => {
          execs.push({ args });
          const j = args.join(' ');
          if (j.startsWith('status --porcelain')) {
            return { exitCode: 0, stdout: opts.statusZ, stderr: '', combined: opts.statusZ };
          }
          if (j === 'rev-parse refs/stash') {
            return { exitCode: 0, stdout: `${pinnedSha}\n`, stderr: '', combined: '' };
          }
          if (j.startsWith('stash list')) {
            const rows = opts.stashListRows ?? `stash@{0}\x1f${pinnedSha}`;
            return { exitCode: 0, stdout: rows, stderr: '', combined: rows };
          }
          if (j.startsWith('stash pop')) {
            const code = opts.popExit ?? 0;
            const err = code === 0 ? '' : 'CONFLICT (content): merge conflict';
            return { exitCode: code, stdout: '', stderr: err, combined: err };
          }
          // stash push and everything else succeed.
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      };
      return { gitCli, execs };
    }

    /** gitService whose FIRST reset trips the overwrite guard, later resets succeed. */
    function makeSmartGitService(
      gitCli: unknown,
      firstError = 'error: Your local changes to the following files would be overwritten by reset'
    ): IGitService & { calls: CallLog[] } {
      let resetCount = 0;
      const gs = makeGitService({
        reset: async () => {
          resetCount += 1;
          if (resetCount === 1) {
            throw new Error(firstError);
          }
        },
      });
      (gs as unknown as { gitCli: unknown }).gitCli = gitCli;
      return gs;
    }

    it('pops the PINNED stash sha even after another entry is pushed between save and restore', async () => {
      const trackers = installMessageTrackers();
      // At restore time the pinned entry has been bumped to stash@{1} by an
      // interloper at stash@{0}. A blind head-pop would apply the WRONG entry.
      const { gitCli, execs } = makeStashCli({
        statusZ: ' M src/file.ts\0',
        stashListRows: 'stash@{0}\x1fINTERLOPER\nstash@{1}\x1fPINNEDSHA',
      });
      const gitService = makeSmartGitService(gitCli);
      const { dialog } = makeDialog({ gitService });
      trackers.setNextWarnResponse('Stash and Reset');
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'mixed' });

        const pop = execs.find((e) => e.args[0] === 'stash' && e.args[1] === 'pop');
        assert.ok(pop, 'the bracket must pop the saved stash via gitCli');
        assert.deepStrictEqual(
          pop.args,
          ['stash', 'pop', 'stash@{1}'],
          'must pop the pinned entry (stash@{1}), never the head (stash@{0})'
        );
        const resets = gitService.calls.filter((c) => c.method === 'resetToCommit');
        assert.strictEqual(
          resets.length,
          2,
          'first reset trips overwrite; second lands after stash'
        );
        assert.ok(
          trackers.log.info.some((m) => m.message.startsWith('Reset to ')),
          'a successful smart reset shows the info toast'
        );
      } finally {
        dialog.dispose();
      }
    });

    it('blocked by unmerged files → error toast, no reset performed', async () => {
      const trackers = installMessageTrackers();
      const { gitCli, execs } = makeStashCli({ statusZ: 'UU src/c.ts\0' });
      const gitService = makeSmartGitService(gitCli);
      const { dialog } = makeDialog({ gitService });
      trackers.setNextWarnResponse('Stash and Reset');
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'mixed' });

        assert.ok(
          trackers.log.error.some((m) => /unmerged|conflicted/i.test(m.message)),
          'must surface an unmerged-files error'
        );
        assert.ok(
          !execs.some((e) => e.args[0] === 'stash' && e.args[1] === 'push'),
          'must not stash when unmerged'
        );
        const resets = gitService.calls.filter((c) => c.method === 'resetToCommit');
        assert.strictEqual(
          resets.length,
          1,
          'only the initial (failing) reset runs — no second reset'
        );
      } finally {
        dialog.dispose();
      }
    });

    it('reset lands but restoring the stash conflicts → reports reset-succeeded, changes parked', async () => {
      const trackers = installMessageTrackers();
      const { gitCli } = makeStashCli({ statusZ: ' M src/file.ts\0', popExit: 1 });
      const gitService = makeSmartGitService(gitCli);
      const { dialog } = makeDialog({ gitService });
      trackers.setNextWarnResponse('Stash and Reset');
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'mixed' });

        assert.ok(
          trackers.log.warn.some((m) =>
            /succeeded, but your stashed changes conflicted/.test(m.message)
          ),
          'must report reset-succeeded-restore-conflicted'
        );
        assert.strictEqual(trackers.log.error.length, 0, 'must NOT claim the reset failed');
      } finally {
        dialog.dispose();
      }
    });

    it('clean tree (overwrite not from stashable changes) → surfaces the original error, no reset', async () => {
      const trackers = installMessageTrackers();
      const { gitCli, execs } = makeStashCli({ statusZ: '' });
      const gitService = makeSmartGitService(gitCli);
      const { dialog } = makeDialog({ gitService });
      trackers.setNextWarnResponse('Stash and Reset');
      try {
        await dialog.simulateMessage({ type: 'reset', mode: 'mixed' });

        assert.ok(
          trackers.log.error.some((m) => /would be overwritten/i.test(m.message)),
          'must surface the original overwrite error'
        );
        assert.ok(
          !execs.some((e) => e.args[0] === 'stash' && e.args[1] === 'push'),
          'a clean tree must not stash'
        );
        const resets = gitService.calls.filter((c) => c.method === 'resetToCommit');
        assert.strictEqual(resets.length, 1, 'must not reset blind on a clean tree');
      } finally {
        dialog.dispose();
      }
    });
  });
});
