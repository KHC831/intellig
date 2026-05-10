/**
 * Unit tests for ResetDialog (T1-11).
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

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  ResetDialog,
  IResetDialogOptions,
  isValidRef,
  resolveDefaultMode,
  showResetDialog,
} from '../../../services/ResetDialog';
import { IGitService, IRepository, ResetMode } from '../../../services/interfaces/IGitService';
import { EventEmitter, Uri } from '../../mocks/vscode';

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
    commit: async () => {},
    amend: async () => {},
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
    fetch: async () => {},
    pull: async () => {},
    push: async () => {},
    getRemotes: async () => [],
    addRemote: async () => {},
    removeRemote: async () => {},
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
    stage: async () => {},
    unstage: async () => {},
    stageHunk: async () => {},
    stageLines: async () => {},
    unstageHunk: async () => {},
    revertFile: async () => {},
    resetToCommit: async (repo: IRepository, target: string, mode: ResetMode) => {
      calls.push({ method: 'resetToCommit', args: [repo, target, mode] });
      if (overrides?.reset) {
        await overrides.reset(repo, target, mode);
      }
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
  (vscode.window as any).showInformationMessage = async (
    message: string
  ): Promise<string | undefined> => {
    log.info.push({ message });
    return undefined;
  };
  (vscode.window as any).showErrorMessage = async (
    message: string
  ): Promise<string | undefined> => {
    log.error.push({ message });
    return undefined;
  };
  (vscode.window as any).showWarningMessage = async (
    message: string,
    optionsOrFirstItem?: unknown,
    ...rest: string[]
  ): Promise<string | undefined> => {
    let modal = false;
    let items: string[] = [];
    if (
      optionsOrFirstItem &&
      typeof optionsOrFirstItem === 'object' &&
      'modal' in (optionsOrFirstItem as Record<string, unknown>)
    ) {
      modal = Boolean((optionsOrFirstItem as { modal?: boolean }).modal);
      items = rest;
    } else if (typeof optionsOrFirstItem === 'string') {
      items = [optionsOrFirstItem, ...rest];
    } else {
      items = rest;
    }
    log.warn.push({ message, items, modal, response: nextWarnResponse });
    const r = nextWarnResponse;
    nextWarnResponse = undefined;
    return r;
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
class TestResetDialog extends ResetDialog {
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as any)._onMessage(raw);
  }
  public renderedHtml(): string {
    return (this as any)._panel.webview.html as string;
  }
}

function makeDialog(opts: Partial<IResetDialogOptions> = {}): {
  dialog: TestResetDialog;
  gitService: IGitService & { calls: CallLog[] };
  repo: IRepository;
} {
  const gitService = opts.gitService ? (opts.gitService as any) : makeGitService();
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

describe('ResetDialog', () => {
  describe('HTML rendering', () => {
    it('renders all four radios (soft/mixed/hard/keep) with Mixed as the default', () => {
      const { dialog } = makeDialog();
      const html = dialog.renderedHtml();
      try {
        assert.ok(html.includes('value="soft"'), 'soft radio rendered');
        assert.ok(html.includes('value="mixed"'), 'mixed radio rendered');
        assert.ok(html.includes('value="hard"'), 'hard radio rendered');
        assert.ok(html.includes('value="keep"'), 'keep radio rendered');

        // The `checked` attribute should sit on the mixed radio.
        const mixedMatch = html.match(/value="mixed"[^>]*checked/);
        assert.ok(mixedMatch, 'mixed radio is checked by default');

        // No other radio should be checked.
        const softMatch = html.match(/value="soft"[^>]*checked/);
        const hardMatch = html.match(/value="hard"[^>]*checked/);
        const keepMatch = html.match(/value="keep"[^>]*checked/);
        assert.ok(!softMatch, 'soft radio NOT checked');
        assert.ok(!hardMatch, 'hard radio NOT checked');
        assert.ok(!keepMatch, 'keep radio NOT checked');
      } finally {
        dialog.dispose();
      }
    });

    it('renders the target short hash and subject', () => {
      const { dialog } = makeDialog({
        target: { hash: 'abcdef1234567890', subject: 'feat: widget' },
      });
      const html = dialog.renderedHtml();
      try {
        assert.ok(html.includes('abcdef12'), 'short hash rendered');
        assert.ok(html.includes('feat: widget'), 'subject rendered');
      } finally {
        dialog.dispose();
      }
    });

    it('escapes HTML in the commit subject', () => {
      const { dialog } = makeDialog({
        target: {
          hash: 'abcdef1234567890',
          subject: '<script>alert(1)</script>',
        },
      });
      const html = dialog.renderedHtml();
      try {
        // Escaped form should appear, raw tag should NOT.
        assert.ok(html.includes('&lt;script&gt;'), 'subject is html-escaped');
        assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag is absent');
      } finally {
        dialog.dispose();
      }
    });

    it('on a protected branch, Hard and Keep radios are disabled; Soft/Mixed are not', () => {
      const { dialog } = makeDialog({
        currentBranch: 'main',
        protectedBranches: ['main'],
      });
      const html = dialog.renderedHtml();
      try {
        const hardMatch = html.match(/value="hard"[^>]*disabled/);
        const keepMatch = html.match(/value="keep"[^>]*disabled/);
        const softMatch = html.match(/value="soft"[^>]*disabled/);
        const mixedMatch = html.match(/value="mixed"[^>]*disabled/);
        assert.ok(hardMatch, 'hard is disabled on protected branch');
        assert.ok(keepMatch, 'keep is disabled on protected branch');
        assert.ok(!softMatch, 'soft stays enabled on protected branch');
        assert.ok(!mixedMatch, 'mixed stays enabled on protected branch');
        assert.ok(html.includes('intellig.protectedBranches'), 'tooltip references the config key');
      } finally {
        dialog.dispose();
      }
    });

    it('renders the inline script inside a nonced <script> tag (CSP-safe)', () => {
      const { dialog } = makeDialog();
      const html = dialog.renderedHtml();
      try {
        // SR-6: nonces are now base64url-encoded 16 random bytes (22 chars).
        const match = html.match(/<script nonce="[A-Za-z0-9_-]{22}">/);
        assert.ok(match, 'inline script has a 22-char base64url nonce');
        assert.ok(html.includes('acquireVsCodeApi'), 'webview bootstrap present');
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
      assert.strictEqual((dialog as any)._disposed, true);
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
});
