/**
 * Unit tests for the Push Dialog.
 *
 * Covers:
 *  - Pure helpers: `buildPushOptions`, `isProtectedTarget`,
 *    `defaultPrimaryAction`, `classifyPushError`, `isActionAllowedForRow`.
 *  - `runPushRow`: flag-mapping, protected-row guard, error classification.
 *  - `PushDialog` lifecycle via a test subclass that exposes `_onMessage`
 *    without a real webview runtime. Covers:
 *      * multi-repo parallel submit → 2 `gitService.push` calls
 *      * default action Push; switches to Force Push with Lease when
 *        divergence is detected
 *      * Force Push (Anyway) disabled per-row for protected targets
 *      * Force Push (Anyway) enabled when target is not protected
 *      * rejection (non-ff) → per-row error with "Pull and Retry" affordance
 *      * per-row "Force with Lease" escape-hatch path
 *      * --no-verify and --follow-tags propagate through
 *      * target-edit → refspec computed
 *      * protected-branch server reject → no auto-retry offered
 *      * cancel → no push invocation
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import { SpawnFailedError } from '../../../src/git-core/errors';
import { okAsync, errAsync } from 'neverthrow';
import * as assert from 'assert';
import { bootWebviewEntry, IWebviewEntryHarness } from '../../helpers/bootWebviewEntry';
import { extractWebviewScript } from '../../helpers/webviewHtml';
import * as vscode from 'vscode';
import {
  buildPushOptions,
  DEFAULT_PUSH_OVERFLOW,
  classifyPushError,
  pushErrorBannerMessage,
  defaultPrimaryAction,
  IPushDialogOptions,
  IPushOverflowState,
  IPushRow,
  IRunPushRowDeps,
  isActionAllowedForRow,
  isProtectedTarget,
  isValidPushRef,
  PushDialog,
  runPushRow,
  shouldProposeUpdateForRejected,
  updateAndRetryRejectedRows,
  MAX_PUSH_ATTEMPTS,
  IPushRowResult,
} from '../../../src/sync/PushDialog';
import {
  IGitService,
  IPushOptions,
  IRepository,
} from '../../../src/git-core/interfaces/IGitService';
import type { PullDialog } from '../../../src/sync/PullDialog';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

function makeRepo(
  rootPath: string,
  head: {
    name?: string;
    commit?: string;
    upstream?: { remote: string; name: string };
    ahead?: number;
    behind?: number;
  } = {}
): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    head: {
      name: head.name ?? 'refs/heads/feature',
      commit: head.commit ?? 'deadbeef',
      upstream: head.upstream,
      ahead: head.ahead ?? 0,
      behind: head.behind ?? 0,
    },
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
}

function makeRow(overrides: Partial<IPushRow> = {}): IPushRow {
  const repo = makeRepo('/test-repo');
  // Use explicit `'upstreamRemote' in overrides` so callers can clear the
  // field by passing `{ upstreamRemote: undefined }` without `??` falling
  // back to the default.
  const upstreamRemote = 'upstreamRemote' in overrides ? overrides.upstreamRemote : 'origin';
  return {
    id: overrides.id ?? '/test-repo',
    selected: overrides.selected ?? true,
    repo: overrides.repo ?? repo,
    repoLabel: overrides.repoLabel ?? 'test-repo',
    localBranch: overrides.localBranch ?? 'feature',
    targetBranch: overrides.targetBranch ?? 'feature',
    upstreamRemote,
    ahead: overrides.ahead ?? 0,
    behind: overrides.behind ?? 0,
    pushSource: overrides.pushSource,
    error: overrides.error,
  };
}

function makeOverflow(overrides: Partial<IPushOverflowState> = {}): IPushOverflowState {
  return {
    noVerify: false,
    pushTags: false,
    tagScope: 'follow',
    ...overrides,
  };
}

interface PushCallLog {
  repo: IRepository;
  options?: IPushOptions;
}

interface PullCallLog {
  repo: IRepository;
  options?: unknown;
}

interface MockGitServiceOptions {
  pushError?: Error | ((repo: IRepository, options?: IPushOptions) => Error | undefined);
}

type MockGitService = IGitService & { pushCalls: PushCallLog[]; pullCalls: PullCallLog[] };

function makeGitService(options: MockGitServiceOptions = {}): MockGitService {
  const pushCalls: PushCallLog[] = [];
  const pullCalls: PullCallLog[] = [];
  const emitter = new EventEmitter<IRepository>();
  const service = {
    pushCalls,
    pullCalls,
    onDidChangeRepository: emitter.event,
    getRepository: async () => undefined,
    getRepositories: () => [],
    getBranches: async () => [],
    getTags: async () => [],
    commit: () => okAsync(undefined),
    amend: () => okAsync(undefined),
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
    fetch: () => okAsync({ updatedRefs: [], ahead: 0, behind: 0, errors: [] }),
    pull: (repo: IRepository, opts?: unknown) => {
      pullCalls.push({ repo, options: opts });
      return okAsync(undefined);
    },
    push: (repo: IRepository, opts?: IPushOptions) => {
      pushCalls.push({ repo, options: opts });
      if (typeof options.pushError === 'function') {
        const err = options.pushError(repo, opts);
        if (err) {
          throw err;
        }
      } else if (options.pushError) {
        throw options.pushError;
      }
      return okAsync(undefined);
    },
    getRemotes: () => okAsync([]),
    addRemote: () => okAsync(undefined),
    removeRemote: () => okAsync(undefined),
    stash: async () => {},
    stashList: async () => [],
    stashApply: async () => {},
    stashPop: async () => {},
    stashDrop: async () => {},
    stashShow: async () => [],
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
    resetToCommit: () => okAsync(undefined),
    dispose: () => {},
  } as unknown as MockGitService;
  return service;
}

interface MessageLog {
  info: string[];
  error: string[];
  warn: string[];
}

function installMessageTrackers(): MessageLog {
  const log: MessageLog = { info: [], error: [], warn: [] };
  (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage = async (
    message: string
  ) => {
    log.info.push(message);
    return undefined;
  };
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
    message: string
  ) => {
    log.error.push(message);
    return undefined;
  };
  (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (
    message: string
  ) => {
    log.warn.push(message);
    return undefined;
  };
  return log;
}

/** Test subclass exposing message-handling without a real webview. */
class TestPushDialog extends PushDialog {
  public renderCount = 0;
  public sentMessages: Array<{ type: string; [k: string]: unknown }> = [];

  constructor(...args: ConstructorParameters<typeof PushDialog>) {
    super(...args);
    // Spy on _render so tests can count full re-renders. We tap the panel's
    // postMessage to record every host→webview patch (SR-5).
    const self = this as unknown as {
      _panel: vscode.WebviewPanel;
      _render: () => void;
    };
    const panel = self._panel;
    const origPost = panel.webview.postMessage.bind(panel.webview);
    panel.webview.postMessage = (payload: unknown): Thenable<boolean> => {
      if (payload && typeof payload === 'object') {
        this.sentMessages.push(payload as { type: string });
      }
      return origPost(payload);
    };
    const origRender = self._render.bind(self);
    self._render = (): void => {
      this.renderCount++;
      origRender();
    };
  }
  public async simulateMessage(raw: unknown): Promise<void> {
    await (this as unknown as { _onMessage(m: unknown): Promise<void> })._onMessage(raw);
  }
  public renderedHtml(): string {
    return (this as unknown as { _panel: vscode.WebviewPanel })._panel.webview.html;
  }
  public disposed(): boolean {
    return (this as unknown as { _disposed: boolean })._disposed;
  }
  public async waitUntilPopulated(): Promise<void> {
    // Poll up to ~250ms for the row table to be non-empty (we populate async
    // in the constructor). Good enough for unit tests; avoids a ticking clock.
    for (let i = 0; i < 50; i++) {
      if (this.rows.length > 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

function makeDialog(
  overrides: Partial<IPushDialogOptions> & { repos?: ReadonlyArray<IRepository> } = {}
): {
  dialog: TestPushDialog;
  gitService: MockGitService;
  pullDialogCalls: Array<{ repo: IRepository; preset?: string; prefilledSource?: unknown }>;
} {
  const gitService = (overrides.gitService as MockGitService | undefined) ?? makeGitService();
  const pullDialogCalls: Array<{ repo: IRepository; preset?: string; prefilledSource?: unknown }> =
    [];
  const pullDialog = {
    show: async (repo: IRepository, preset?: string, prefilledSource?: unknown) => {
      pullDialogCalls.push({ repo, preset, prefilledSource });
      return undefined;
    },
  } as unknown as PullDialog;
  const dialog = new TestPushDialog(makeContext(), {
    repos: overrides.repos ?? [makeRepo('/test-repo')],
    preselect: overrides.preselect,
    preselectForce: overrides.preselectForce,
    gitService,
    protectedBranches: overrides.protectedBranches ?? [],
    pullDialogAccessor: overrides.pullDialogAccessor ?? (() => pullDialog),
    onPushComplete: overrides.onPushComplete,
  });
  return { dialog, gitService, pullDialogCalls };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

const _pushHarnesses: IWebviewEntryHarness[] = [];
afterEach(() => {
  while (_pushHarnesses.length > 0) {
    _pushHarnesses.pop()?.dispose();
  }
});

describe('PushDialog — pure helpers', () => {
  describe('isValidPushRef', () => {
    it('accepts ordinary branch names', () => {
      for (const ok of ['main', 'feature/x', 'release-1.0', 'user/topic_2', 'v1.0.0']) {
        assert.strictEqual(isValidPushRef(ok), true, `${ok} should be valid`);
      }
    });
    it('rejects a leading - or . (flag / invalid ref)', () => {
      assert.strictEqual(isValidPushRef('-x'), false);
      assert.strictEqual(isValidPushRef('.hidden'), false);
    });
    it('rejects ":" inside a half so it cannot expand the refspec', () => {
      // a:b would otherwise produce the spec local:a:b.
      assert.strictEqual(isValidPushRef('a:b'), false);
      assert.strictEqual(isValidPushRef('feature:evil'), false);
    });
  });

  describe('isProtectedTarget', () => {
    it('returns true when target is in the list', () => {
      assert.strictEqual(isProtectedTarget('main', ['main', 'master']), true);
    });
    it('returns false when target is not in the list', () => {
      assert.strictEqual(isProtectedTarget('feature/x', ['main', 'master']), false);
    });
    it('empty list never protects', () => {
      assert.strictEqual(isProtectedTarget('main', []), false);
    });
  });

  describe('classifyPushError', () => {
    it('classifies non-fast-forward as rejected-non-ff', () => {
      assert.strictEqual(
        classifyPushError('! [rejected] main -> main (non-fast-forward)'),
        'rejected-non-ff'
      );
      assert.strictEqual(
        classifyPushError('updates were rejected because the remote'),
        'rejected-non-ff'
      );
    });
    it('classifies protected-branch refuse as rejected-protected', () => {
      assert.strictEqual(
        classifyPushError('remote: GH006: Protected branch update failed'),
        'rejected-protected'
      );
      assert.strictEqual(
        classifyPushError('refusing to allow force push on protected branch'),
        'rejected-protected'
      );
    });
    it('classifies auth failures', () => {
      assert.strictEqual(classifyPushError('Authentication failed'), 'auth');
      assert.strictEqual(classifyPushError('Permission denied (publickey)'), 'auth');
      assert.strictEqual(
        classifyPushError('support for password authentication was removed'),
        'auth'
      );
    });
    it('classifies hook failures', () => {
      assert.strictEqual(classifyPushError('pre-push hook failed'), 'hook');
      assert.strictEqual(classifyPushError('remote: hook declined'), 'hook');
    });
    it('classifies a stale force-with-lease rejection as rejected-stale-lease', () => {
      // Reference result type REJECTED_STALE_INFO: the remote moved after the
      // last fetch, so the lease check refused the push.
      assert.strictEqual(
        classifyPushError('! [rejected]        main -> main (stale info)'),
        'rejected-stale-lease'
      );
    });
    it('falls back to other for unknown errors', () => {
      assert.strictEqual(classifyPushError('some weird git thing'), 'other');
    });
    it('does not read a missing workflow scope as branch protection', () => {
      // GitHub refuses a push that touches .github/workflows when the token
      // lacks the workflow scope. It is not a protected branch, and the canned
      // protected-branch banner would hide the only text that explains it.
      assert.strictEqual(
        classifyPushError(
          '! [remote rejected] main -> main (refusing to allow an OAuth App to ' +
            'create or update workflow `.github/workflows/ci.yml` without `workflow` scope)'
        ),
        'other'
      );
      assert.strictEqual(
        classifyPushError(
          'refusing to allow a Personal Access Token to create or update ' +
            'workflow `.github/workflows/release.yml` without `workflow` scope'
        ),
        'other'
      );
    });
  });

  describe('pushErrorBannerMessage', () => {
    it('keeps the git text for an auth failure', () => {
      // git4idea shows canned text only for the REJECTED_* results; ERROR
      // carries git's own message (GitPushResultNotification.java:308).
      const banner = pushErrorBannerMessage(
        'auth',
        'remote: Invalid username or password.',
        'origin/main'
      );
      assert.ok(banner.includes('credentials'), `keeps the one-liner: ${banner}`);
      assert.ok(
        banner.includes('remote: Invalid username or password.'),
        `must carry git's own text: ${banner}`
      );
    });

    it('keeps the hook output that says WHY the push was rejected', () => {
      const banner = pushErrorBannerMessage(
        'hook',
        'remote: pre-push hook failed: commit message must reference an issue',
        'origin/main'
      );
      assert.ok(banner.includes('pre-push hook'), `keeps the one-liner: ${banner}`);
      assert.ok(
        banner.includes('must reference an issue'),
        `the hook's reason is the only actionable text: ${banner}`
      );
    });

    it('leaves the REJECTED_* banners canned (they carry retry affordances)', () => {
      for (const kind of [
        'rejected-non-ff',
        'rejected-stale-lease',
        'rejected-protected',
      ] as const) {
        const banner = pushErrorBannerMessage(kind, 'raw git noise here', 'origin/main');
        assert.ok(!banner.includes('raw git noise here'), `${kind} stays canned: ${banner}`);
      }
    });

    it('degrades to the plain one-liner when there is no git text', () => {
      assert.strictEqual(
        pushErrorBannerMessage('auth', '', 'origin/main'),
        'Push failed: the remote rejected your credentials.'
      );
    });
  });

  describe('defaultPrimaryAction', () => {
    it('returns push when no rows are selected', () => {
      assert.strictEqual(defaultPrimaryAction([]), 'push');
    });
    it('returns push when selected rows have no divergence', () => {
      const rows = [makeRow({ ahead: 2, behind: 0 })];
      assert.strictEqual(defaultPrimaryAction(rows), 'push');
    });
    it('returns forceWithLease when any selected row is diverged', () => {
      const rows = [
        makeRow({ id: 'a', selected: true, ahead: 0, behind: 0 }),
        makeRow({ id: 'b', selected: true, ahead: 3, behind: 2 }),
      ];
      assert.strictEqual(defaultPrimaryAction(rows), 'forceWithLease');
    });
    it('ignores unselected diverged rows', () => {
      const rows = [
        makeRow({ id: 'a', selected: true, ahead: 2, behind: 0 }),
        makeRow({ id: 'b', selected: false, ahead: 3, behind: 2 }),
      ];
      assert.strictEqual(defaultPrimaryAction(rows), 'push');
    });
  });

  describe('isActionAllowedForRow', () => {
    it('allows force when target is not protected', () => {
      const row = makeRow({ targetBranch: 'feature' });
      assert.strictEqual(isActionAllowedForRow(row, 'force', ['main']), true);
    });
    it('blocks force when target is protected', () => {
      const row = makeRow({ targetBranch: 'main' });
      assert.strictEqual(isActionAllowedForRow(row, 'force', ['main']), false);
    });
    it('blocks forceWithLease when target is protected (reference prohibits ALL force pushes)', () => {
      // GitPushSupport.isForcePushAllowed returns false for a protected target,
      // which disables BOTH force flavors — in IntelliJ force-with-lease IS the
      // force push, chosen by git.use.push.force.with.lease.
      const row = makeRow({ targetBranch: 'main' });
      assert.strictEqual(isActionAllowedForRow(row, 'forceWithLease', ['main']), false);
    });
    it('always allows plain push', () => {
      const row = makeRow({ targetBranch: 'main' });
      assert.strictEqual(isActionAllowedForRow(row, 'push', ['main']), true);
    });
  });

  describe('buildPushOptions', () => {
    it('plain push: remote + branch, no flags', () => {
      const opts = buildPushOptions(makeRow(), 'push', makeOverflow());
      assert.strictEqual(opts.remote, 'origin');
      assert.strictEqual(opts.branch, 'feature');
      assert.strictEqual(opts.force, undefined);
      assert.strictEqual(opts.forceWithLease, undefined);
      assert.strictEqual(opts.setUpstream, undefined);
      assert.strictEqual(opts.noVerify, undefined);
      assert.strictEqual(opts.tags, undefined);
      assert.strictEqual(opts.followTags, undefined);
      assert.strictEqual(opts.refspec, undefined);
    });
    it('sets --set-upstream when row has no upstreamRemote', () => {
      const row = makeRow({ upstreamRemote: undefined });
      const opts = buildPushOptions(row, 'push', makeOverflow());
      assert.strictEqual(opts.setUpstream, true);
      assert.strictEqual(opts.remote, 'origin', 'falls back to origin');
    });
    it('forceWithLease action sets forceWithLease, never force', () => {
      const opts = buildPushOptions(makeRow(), 'forceWithLease', makeOverflow());
      assert.strictEqual(opts.forceWithLease, true);
      assert.strictEqual(opts.force, undefined);
    });
    it('force action sets bare --force', () => {
      const opts = buildPushOptions(makeRow(), 'force', makeOverflow());
      assert.strictEqual(opts.force, true);
      assert.strictEqual(opts.forceWithLease, undefined);
    });
    it('--no-verify overflow propagates', () => {
      const opts = buildPushOptions(makeRow(), 'push', makeOverflow({ noVerify: true }));
      assert.strictEqual(opts.noVerify, true);
    });
    it('push tags + all scope → tags: true', () => {
      const opts = buildPushOptions(
        makeRow(),
        'push',
        makeOverflow({ pushTags: true, tagScope: 'all' })
      );
      assert.strictEqual(opts.tags, true);
      assert.strictEqual(opts.followTags, undefined);
    });
    it('push tags + follow scope → followTags: true', () => {
      const opts = buildPushOptions(
        makeRow(),
        'push',
        makeOverflow({ pushTags: true, tagScope: 'follow' })
      );
      assert.strictEqual(opts.followTags, true);
      assert.strictEqual(opts.tags, undefined);
    });
    it('default tag scope is "all" so checking "Push tags" pushes every tag (git4idea parity)', () => {
      // git4idea's tag-mode combo defaults to ALL (--tags); --follow-tags silently
      // drops lightweight/unreachable tags, surprising users who just want to push a tag.
      assert.strictEqual(DEFAULT_PUSH_OVERFLOW.tagScope, 'all');
      const opts = buildPushOptions(
        makeRow(),
        'push',
        makeOverflow({ pushTags: true, tagScope: DEFAULT_PUSH_OVERFLOW.tagScope })
      );
      assert.strictEqual(opts.tags, true);
      assert.strictEqual(opts.followTags, undefined);
    });
    it('target edit → refspec "local:target" and no positional branch', () => {
      const row = makeRow({ localBranch: 'feature', targetBranch: 'feature-renamed' });
      const opts = buildPushOptions(row, 'push', makeOverflow());
      assert.strictEqual(opts.refspec, 'feature:feature-renamed');
      assert.strictEqual(opts.branch, undefined);
    });
    it('target unchanged → no refspec, positional branch kept', () => {
      const row = makeRow({ localBranch: 'feature', targetBranch: 'feature' });
      const opts = buildPushOptions(row, 'push', makeOverflow());
      assert.strictEqual(opts.refspec, undefined);
      assert.strictEqual(opts.branch, 'feature');
    });

    // ─── SR-3: security guard against git-flag injection via ref name ───
    describe('SR-3 leading-dash rejection (security)', () => {
      it('rejects targetBranch starting with "-" (git would parse as a flag)', () => {
        const row = makeRow({ localBranch: 'feature', targetBranch: '-foo' });
        assert.throws(
          () => buildPushOptions(row, 'push', makeOverflow()),
          /Invalid target branch '-foo'/
        );
      });
      it('rejects targetBranch starting with "-" followed by a slash', () => {
        const row = makeRow({ localBranch: 'feature', targetBranch: '-x/y' });
        assert.throws(
          () => buildPushOptions(row, 'push', makeOverflow()),
          /Invalid target branch '-x\/y'/
        );
      });
      it('rejects targetBranch starting with "." (invalid git ref name)', () => {
        const row = makeRow({ localBranch: 'feature', targetBranch: '-.main' });
        assert.throws(
          () => buildPushOptions(row, 'push', makeOverflow()),
          /Invalid target branch '-\.main'/
        );
      });
      it('rejects localBranch starting with "-"', () => {
        const row = makeRow({ localBranch: '-foo', targetBranch: '-foo' });
        assert.throws(() => buildPushOptions(row, 'push', makeOverflow()), /Invalid local branch/);
      });
      it('accepts normal ref names (main, feature/x, v1.0.0, release-1.0)', () => {
        const cases = ['main', 'feature/x', 'v1.0.0', 'release-1.0', 'hotfix/ISS-123'];
        for (const name of cases) {
          const row = makeRow({ localBranch: name, targetBranch: name });
          assert.doesNotThrow(() => buildPushOptions(row, 'push', makeOverflow()), name);
        }
      });
    });
  });
});

// ─── runPushRow ──────────────────────────────────────────────────────────────

describe('runPushRow', () => {
  it('happy path invokes gitService.push with built options and returns ok:true', async () => {
    const gitService = makeGitService();
    const deps: IRunPushRowDeps = { gitService, protectedBranches: [] };
    const result = await runPushRow(deps, makeRow(), 'push', makeOverflow());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(gitService.pushCalls.length, 1);
    assert.strictEqual(gitService.pushCalls[0].options?.branch, 'feature');
  });

  it('protected-target + force action short-circuits: no push, error returned', async () => {
    const gitService = makeGitService();
    const deps: IRunPushRowDeps = { gitService, protectedBranches: ['main'] };
    const row = makeRow({ targetBranch: 'main' });
    const result = await runPushRow(deps, row, 'force', makeOverflow());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error?.kind, 'rejected-protected');
    assert.strictEqual(gitService.pushCalls.length, 0);
  });

  it('protected-target + forceWithLease action short-circuits: no push, error returned', async () => {
    const gitService = makeGitService();
    const deps: IRunPushRowDeps = { gitService, protectedBranches: ['main'] };
    const row = makeRow({ targetBranch: 'main' });
    const result = await runPushRow(deps, row, 'forceWithLease', makeOverflow());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error?.kind, 'rejected-protected');
    assert.strictEqual(gitService.pushCalls.length, 0);
  });

  it('classifies non-ff errors from gitService.push', async () => {
    const gitService = makeGitService({
      pushError: new Error('! [rejected] main -> main (non-fast-forward)'),
    });
    const deps: IRunPushRowDeps = { gitService, protectedBranches: [] };
    const result = await runPushRow(deps, makeRow(), 'push', makeOverflow());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error?.kind, 'rejected-non-ff');
  });
});

// ─── PushDialog lifecycle ────────────────────────────────────────────────────

describe('PushDialog — lifecycle', () => {
  it('builds a row per repo and preselects per `preselect`', async () => {
    const repoA = makeRepo('/repo-a', { name: 'refs/heads/a' });
    const repoB = makeRepo('/repo-b', { name: 'refs/heads/b' });
    const { dialog } = makeDialog({
      repos: [repoA, repoB],
      preselect: { repo: repoA },
    });
    await dialog.waitUntilPopulated();
    const rows = dialog.rows;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.find((r) => r.id === '/repo-a')?.selected, true);
    assert.strictEqual(rows.find((r) => r.id === '/repo-b')?.selected, false);
    assert.strictEqual(rows.find((r) => r.id === '/repo-a')?.localBranch, 'a');
    dialog.dispose();
  });

  it('default primary action is Push when no rows diverge', async () => {
    const repo = makeRepo('/repo-a', { ahead: 2, behind: 0 });
    const { dialog } = makeDialog({ repos: [repo] });
    await dialog.waitUntilPopulated();
    assert.strictEqual(dialog.primaryAction, 'push');
    dialog.dispose();
  });

  it('default primary action flips to forceWithLease when a row diverges', async () => {
    const repo = makeRepo('/repo-a', { ahead: 2, behind: 3 });
    const { dialog } = makeDialog({ repos: [repo] });
    await dialog.waitUntilPopulated();
    assert.strictEqual(dialog.primaryAction, 'forceWithLease');
    dialog.dispose();
  });

  it('a diverged row with a PROTECTED target never auto-flips the default to forceWithLease', async () => {
    // intellig.protectedBranches: ["main"], local main diverged — the primary
    // action must stay Push (force actions are prohibited on protected targets),
    // never auto-arm a force push behind the Enter key.
    const repo = makeRepo('/repo-a', {
      name: 'refs/heads/main',
      upstream: { remote: 'origin', name: 'main' },
      ahead: 2,
      behind: 3,
    });
    const { dialog } = makeDialog({ repos: [repo], protectedBranches: ['main'] });
    await dialog.waitUntilPopulated();
    assert.strictEqual(dialog.primaryAction, 'push');
    dialog.dispose();
  });

  it('submit with forceWithLease on a protected target is blocked without pushing', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      repos: [
        makeRepo('/repo-a', {
          name: 'refs/heads/main',
          upstream: { remote: 'origin', name: 'main' },
        }),
      ],
      protectedBranches: ['main'],
    });
    await dialog.waitUntilPopulated();
    // Even if a malicious webview message bypasses the disabled select,
    // runPushRow rejects the action locally.
    await dialog.simulateMessage({ type: 'submit', action: 'forceWithLease' });
    assert.strictEqual(gitService.pushCalls.length, 0);
    assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-protected');
    dialog.dispose();
  });

  it('non-HEAD preselected row shows the clicked branch divergence, not HEAD (#19b)', async () => {
    // HEAD = feature, not diverged (0/0). The user right-clicked a DIFFERENT
    // branch 'other' that IS diverged — its own counts must drive the row and
    // the force-with-lease auto-flip, not HEAD's 0/0.
    const repo = makeRepo('/repo-a', { name: 'refs/heads/feature', ahead: 0, behind: 0 });
    const { dialog } = makeDialog({
      repos: [repo],
      preselect: {
        repo,
        branch: 'other',
        upstream: { remote: 'origin', name: 'other' },
        ahead: 2,
        behind: 1,
      },
    });
    await dialog.waitUntilPopulated();
    const row = dialog.rows[0];
    assert.strictEqual(row.localBranch, 'other');
    assert.strictEqual(row.ahead, 2, 'shows the clicked branch ahead, not HEAD 0');
    assert.strictEqual(row.behind, 1, 'shows the clicked branch behind, not HEAD 0');
    assert.strictEqual(
      dialog.primaryAction,
      'forceWithLease',
      'a diverged non-HEAD clicked branch flips the default to force-with-lease'
    );
    dialog.dispose();
  });

  it('preselected HEAD branch still uses HEAD divergence, not stale preselect counts (#19b)', async () => {
    const repo = makeRepo('/repo-a', { name: 'refs/heads/feature', ahead: 4, behind: 2 });
    const { dialog } = makeDialog({
      repos: [repo],
      // Clicked branch IS HEAD → ignore the preselect counts, use HEAD's live ones.
      preselect: { repo, branch: 'feature', ahead: 0, behind: 0 },
    });
    await dialog.waitUntilPopulated();
    const row = dialog.rows[0];
    assert.strictEqual(row.ahead, 4);
    assert.strictEqual(row.behind, 2);
    dialog.dispose();
  });

  it('multi-repo submit invokes gitService.push once per selected row in parallel', async () => {
    const repoA = makeRepo('/repo-a', { name: 'refs/heads/a' });
    const repoB = makeRepo('/repo-b', { name: 'refs/heads/b' });
    const log = installMessageTrackers();
    const { dialog, gitService } = makeDialog({ repos: [repoA, repoB] });
    await dialog.waitUntilPopulated();

    // Both rows should be selected by default when `preselect` is omitted.
    await dialog.simulateMessage({ type: 'submit', action: 'push' });

    assert.strictEqual(gitService.pushCalls.length, 2);
    const branches = gitService.pushCalls.map((c) => c.options?.branch).sort();
    assert.deepStrictEqual(branches, ['a', 'b']);
    assert.strictEqual(log.info.length, 1);
    assert.ok(log.info[0].includes('2 repositories'));
    assert.ok(dialog.disposed(), 'dialog should dispose after all rows succeed');
  });

  it('row-level error keeps dialog open and tags per-row error state', async () => {
    const log = installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      repos: [makeRepo('/repo-a')],
    });
    // Swap in a failing push mid-flight.
    (gitService as unknown as { push: IGitService['push'] }).push = () =>
      errAsync(new SpawnFailedError('! [rejected] main -> main (non-fast-forward)'));
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    assert.strictEqual(dialog.disposed(), false);
    assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-non-ff');
    // No success toast when any row fails.
    assert.deepStrictEqual(log.info, []);
    dialog.dispose();
  });

  it('--no-verify + push tags follow-mode reach gitService.push as options', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({ repos: [makeRepo('/repo-a')] });
    await dialog.waitUntilPopulated();
    // Toggle overflow via updateOverflow message.
    await dialog.simulateMessage({
      type: 'updateOverflow',
      overflow: { noVerify: true, pushTags: true, tagScope: 'follow' },
    });
    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    assert.strictEqual(gitService.pushCalls.length, 1);
    assert.strictEqual(gitService.pushCalls[0].options?.noVerify, true);
    assert.strictEqual(gitService.pushCalls[0].options?.followTags, true);
    assert.strictEqual(gitService.pushCalls[0].options?.tags, undefined);
  });

  it('target edit through updateRow produces a refspec in the push options', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({ repos: [makeRepo('/repo-a')] });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({
      type: 'updateRow',
      rowId: '/repo-a',
      rowPatch: { targetBranch: 'feature-renamed' },
    });
    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    assert.strictEqual(gitService.pushCalls[0].options?.refspec, 'feature:feature-renamed');
    assert.strictEqual(gitService.pushCalls[0].options?.branch, undefined);
  });

  it('Force Push (Anyway) disabled per-row when target is protected (runPushRow blocks)', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      repos: [
        makeRepo('/repo-a', {
          name: 'refs/heads/main',
          upstream: { remote: 'origin', name: 'main' },
        }),
      ],
      protectedBranches: ['main'],
    });
    await dialog.waitUntilPopulated();
    // Even if a malicious webview message bypasses the disabled select,
    // runPushRow rejects the action locally.
    await dialog.simulateMessage({ type: 'submit', action: 'force' });
    assert.strictEqual(gitService.pushCalls.length, 0);
    assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-protected');
    dialog.dispose();
  });

  it('Force Push (Anyway) is accepted when target is not protected', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      repos: [makeRepo('/repo-a', { upstream: { remote: 'origin', name: 'feature' } })],
      protectedBranches: ['main'],
    });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'submit', action: 'force' });
    assert.strictEqual(gitService.pushCalls.length, 1);
    assert.strictEqual(gitService.pushCalls[0].options?.force, true);
  });

  it('pullAndRetry opens PullDialog with the row remote/branch, then clears row error', async () => {
    installMessageTrackers();
    const { dialog, gitService, pullDialogCalls } = makeDialog({
      repos: [makeRepo('/repo-a', { upstream: { remote: 'origin', name: 'feature' } })],
    });
    (gitService as unknown as { push: IGitService['push'] }).push = () =>
      errAsync(new SpawnFailedError('! [rejected] main -> main (non-fast-forward)'));
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-non-ff');

    await dialog.simulateMessage({ type: 'pullAndRetry', rowId: '/repo-a' });
    // The Pull dialog should have been invoked exactly once with the row data.
    // The handler awaits the .then() of dialog.show which returns a resolved
    // undefined in the mock, so the row error is cleared synchronously after.
    // Give the microtask queue a tick to drain the .then().
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(pullDialogCalls.length, 1);
    assert.strictEqual(pullDialogCalls[0].repo.rootUri.fsPath, '/repo-a');
    assert.deepStrictEqual(pullDialogCalls[0].prefilledSource, {
      remote: 'origin',
      branch: 'feature',
    });
    assert.strictEqual(dialog.rows[0].error, undefined);
    dialog.dispose();
  });

  it('protected-branch server reject does NOT offer auto-retry (error kind differs)', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      repos: [makeRepo('/repo-a')],
    });
    (gitService as unknown as { push: IGitService['push'] }).push = () =>
      errAsync(new SpawnFailedError('remote: GH006: Protected branch update failed'));
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-protected');
    // No way to know without re-rendering HTML, but the kind alone determines
    // whether the webview shows Pull-and-Retry. Assert on the kind, not UI.
    dialog.dispose();
  });

  it('cancel disposes the dialog without invoking push', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({ repos: [makeRepo('/repo-a')] });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'cancel' });
    assert.strictEqual(gitService.pushCalls.length, 0);
    assert.strictEqual(dialog.disposed(), true);
  });

  it('per-row "Force with Lease" escape hatch kicks just the targeted row', async () => {
    installMessageTrackers();
    const repoA = makeRepo('/repo-a');
    const repoB = makeRepo('/repo-b', { name: 'refs/heads/b' });
    const { dialog, gitService } = makeDialog({ repos: [repoA, repoB] });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'forceWithLease-row', rowId: '/repo-a' });
    // Only one push, and it's forceWithLease for repoA.
    assert.strictEqual(gitService.pushCalls.length, 1);
    assert.strictEqual(gitService.pushCalls[0].options?.forceWithLease, true);
    assert.strictEqual(gitService.pushCalls[0].repo.rootUri.fsPath, '/repo-a');
  });

  it('per-row "Force Push (Anyway)" after a stale lease force-pushes just that row', async () => {
    // GitPushOperation.deriveForceWithoutLease: the follow-up re-runs with
    // plain force for exactly the stale repos.
    installMessageTrackers();
    const repoA = makeRepo('/repo-a');
    const repoB = makeRepo('/repo-b', { name: 'refs/heads/b' });
    const { dialog, gitService } = makeDialog({ repos: [repoA, repoB] });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'forceAnyway-row', rowId: '/repo-a' });
    assert.strictEqual(gitService.pushCalls.length, 1);
    assert.strictEqual(gitService.pushCalls[0].options?.force, true);
    assert.strictEqual(gitService.pushCalls[0].options?.forceWithLease, undefined);
    assert.strictEqual(gitService.pushCalls[0].repo.rootUri.fsPath, '/repo-a');
  });

  it('per-row "Force Push (Anyway)" respects the protected guard', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      repos: [
        makeRepo('/repo-a', {
          name: 'refs/heads/main',
          upstream: { remote: 'origin', name: 'main' },
        }),
      ],
      protectedBranches: ['main'],
    });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'forceAnyway-row', rowId: '/repo-a' });
    assert.strictEqual(gitService.pushCalls.length, 0);
    assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-protected');
    dialog.dispose();
  });
});

// ─── Preselected-branch push: clicked branch is the sole source of the ref ───

describe('PushDialog — preselected branch drives the pushed ref (issue #16)', () => {
  it('right-click Push on branch X while HEAD=Y pushes X, never Y, never the cross-ref Y:X', async () => {
    installMessageTrackers();
    // Resolved repo's current HEAD is `main` (Y) — a DIFFERENT branch than the
    // one the user right-clicked. The clicked branch is dev/cleanup-phase2.3b (X).
    const repo = makeRepo('/repo-a', {
      name: 'refs/heads/main',
      upstream: { remote: 'origin', name: 'main' },
    });
    const { dialog, gitService } = makeDialog({
      repos: [repo],
      preselect: { repo, branch: 'dev/cleanup-phase2.3b' },
    });
    await dialog.waitUntilPopulated();

    // The row must be seeded from the clicked branch, NOT the resolved HEAD.
    assert.strictEqual(
      dialog.rows[0].localBranch,
      'dev/cleanup-phase2.3b',
      'localBranch must come from the clicked branch, not repo.head'
    );

    await dialog.simulateMessage({ type: 'submit', action: 'push' });

    assert.strictEqual(gitService.pushCalls.length, 1);
    const opts = gitService.pushCalls[0].options;
    // The pushed local ref is the clicked branch.
    assert.strictEqual(opts?.branch, 'dev/cleanup-phase2.3b');
    // Guard: NO cross-ref `main:dev/cleanup-phase2.3b` (or any `main:*`) is ever
    // produced — that would ship the active repo's HEAD content to the clicked
    // branch's remote ref (the destructive bug in #16).
    assert.strictEqual(opts?.refspec, undefined, 'must not produce a cross-ref refspec');
    assert.notStrictEqual(opts?.branch, 'main', 'must not push the resolved HEAD branch');
    dialog.dispose();
  });

  it('preselected branch that IS the current HEAD keeps its tracked upstream', async () => {
    installMessageTrackers();
    // When the clicked branch equals HEAD and HEAD has an upstream, the upstream
    // is preserved so a renamed-target push (refspec) still works as before.
    const repo = makeRepo('/repo-a', {
      name: 'refs/heads/feature',
      upstream: { remote: 'origin', name: 'feature-remote' },
    });
    const { dialog, gitService } = makeDialog({
      repos: [repo],
      preselect: { repo, branch: 'feature' },
    });
    await dialog.waitUntilPopulated();
    assert.strictEqual(dialog.rows[0].localBranch, 'feature');
    assert.strictEqual(dialog.rows[0].targetBranch, 'feature-remote');

    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    const opts = gitService.pushCalls[0].options;
    // feature → feature-remote is a legitimate, user-tracked refspec.
    assert.strictEqual(opts?.refspec, 'feature:feature-remote');
    dialog.dispose();
  });

  it('no-preselect multi-repo push still seeds each row from its own HEAD', async () => {
    installMessageTrackers();
    const repoA = makeRepo('/repo-a', { name: 'refs/heads/a' });
    const repoB = makeRepo('/repo-b', { name: 'refs/heads/b' });
    const { dialog, gitService } = makeDialog({ repos: [repoA, repoB] });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    const branches = gitService.pushCalls.map((c) => c.options?.branch).sort();
    assert.deepStrictEqual(branches, ['a', 'b'], 'multi-repo path unchanged: branch per repo HEAD');
    dialog.dispose();
  });
});

// ─── Preselected non-HEAD branch keeps its OWN tracking (issue #19) ───────────

describe('PushDialog — preselected non-HEAD branch keeps its own upstream (issue #19)', () => {
  it('threads the clicked branch upstream so an already-tracking branch is not re-set-upstream', async () => {
    installMessageTrackers();
    // HEAD is `main` (tracks origin/main). The user right-clicks a DIFFERENT
    // local branch `dev/feature-x` that already tracks `origin/dev/feature-x`.
    // The clicked branch's OWN upstream must drive the row — not be discarded
    // (the #16 fix correctly stopped seeding from HEAD, but dropped the clicked
    // branch's tracking, forcing --set-upstream against the fallback remote).
    const repo = makeRepo('/repo-a', {
      name: 'refs/heads/main',
      upstream: { remote: 'origin', name: 'main' },
    });
    const { dialog, gitService } = makeDialog({
      repos: [repo],
      preselect: {
        repo,
        branch: 'dev/feature-x',
        upstream: { remote: 'origin', name: 'dev/feature-x' },
      },
    });
    await dialog.waitUntilPopulated();

    assert.strictEqual(dialog.rows[0].localBranch, 'dev/feature-x');
    assert.strictEqual(
      dialog.rows[0].upstreamRemote,
      'origin',
      "row must carry the clicked branch's own upstream remote, not undefined"
    );
    assert.strictEqual(dialog.rows[0].targetBranch, 'dev/feature-x');

    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    const opts = gitService.pushCalls[0].options;
    assert.strictEqual(opts?.remote, 'origin', 'pushes to the tracked remote, not the fallback');
    assert.strictEqual(opts?.branch, 'dev/feature-x');
    assert.strictEqual(
      opts?.setUpstream,
      undefined,
      'must NOT force --set-upstream on a branch that already tracks a remote'
    );
    assert.strictEqual(opts?.refspec, undefined, 'same target name → no refspec');
    dialog.dispose();
  });

  it('a renamed tracked upstream pushes the tracked refspec (local:tracked)', async () => {
    installMessageTrackers();
    const repo = makeRepo('/repo-a', {
      name: 'refs/heads/main',
      upstream: { remote: 'origin', name: 'main' },
    });
    const { dialog, gitService } = makeDialog({
      repos: [repo],
      preselect: {
        repo,
        branch: 'dev/feature-x',
        upstream: { remote: 'upstream', name: 'renamed-x' },
      },
    });
    await dialog.waitUntilPopulated();
    assert.strictEqual(dialog.rows[0].upstreamRemote, 'upstream');
    assert.strictEqual(dialog.rows[0].targetBranch, 'renamed-x');

    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    const opts = gitService.pushCalls[0].options;
    assert.strictEqual(opts?.remote, 'upstream');
    assert.strictEqual(
      opts?.refspec,
      'dev/feature-x:renamed-x',
      'tracked rename → refspec local:tracked'
    );
    assert.strictEqual(opts?.setUpstream, undefined);
    dialog.dispose();
  });

  it('a non-HEAD branch with NO upstream still sets upstream (issue #16 behavior preserved)', async () => {
    installMessageTrackers();
    const repo = makeRepo('/repo-a', {
      name: 'refs/heads/main',
      upstream: { remote: 'origin', name: 'main' },
    });
    const { dialog, gitService } = makeDialog({
      repos: [repo],
      preselect: { repo, branch: 'dev/brand-new' }, // no upstream threaded
    });
    await dialog.waitUntilPopulated();
    assert.strictEqual(dialog.rows[0].upstreamRemote, undefined);

    await dialog.simulateMessage({ type: 'submit', action: 'push' });
    const opts = gitService.pushCalls[0].options;
    assert.strictEqual(opts?.setUpstream, true, 'a never-pushed branch still gets --set-upstream');
    assert.strictEqual(opts?.branch, 'dev/brand-new');
    assert.strictEqual(opts?.remote, 'origin', 'falls back to the default remote');
    dialog.dispose();
  });
});

// ─── Rejected-push update proposal gates (GitPushOperation parity) ───────────

describe('shouldProposeUpdateForRejected', () => {
  function trackedRow(overrides: Partial<IPushRow> = {}): IPushRow {
    const repo = makeRepo('/r', {
      name: 'refs/heads/feature',
      upstream: { remote: 'origin', name: 'feature' },
    });
    return makeRow({ repo, localBranch: 'feature', targetBranch: 'feature', ...overrides });
  }

  it('allows the proposal when every rejected row is the current branch on its tracked target', () => {
    assert.strictEqual(shouldProposeUpdateForRejected([trackedRow()]), true);
  });
  it('blocks when the pushed branch is not the current branch', () => {
    assert.strictEqual(
      shouldProposeUpdateForRejected([trackedRow({ localBranch: 'other', targetBranch: 'other' })]),
      false
    );
  });
  it('blocks when the target is not the tracked upstream branch', () => {
    assert.strictEqual(
      shouldProposeUpdateForRejected([trackedRow({ targetBranch: 'main' })]),
      false
    );
  });
  it('blocks when the row pushes to a different remote than the tracked one', () => {
    assert.strictEqual(
      shouldProposeUpdateForRejected([trackedRow({ upstreamRemote: 'fork' })]),
      false
    );
  });
  it('blocks when the current branch has no upstream', () => {
    const repo = makeRepo('/r', { name: 'refs/heads/feature' });
    assert.strictEqual(
      shouldProposeUpdateForRejected([
        makeRow({ repo, localBranch: 'feature', upstreamRemote: undefined }),
      ]),
      false
    );
  });
  it('blocks when HEAD is detached', () => {
    const repo = makeRepo('/r');
    (repo as { head?: unknown }).head = undefined;
    assert.strictEqual(shouldProposeUpdateForRejected([makeRow({ repo })]), false);
  });
  it('one non-updatable row blocks the proposal for the whole submit (reference: break, not filter)', () => {
    assert.strictEqual(
      shouldProposeUpdateForRejected([
        trackedRow(),
        trackedRow({ id: '/r2', localBranch: 'other', targetBranch: 'other' }),
      ]),
      false
    );
  });
  it('an empty rejected set never proposes', () => {
    assert.strictEqual(shouldProposeUpdateForRejected([]), false);
  });
});

describe('PushDialog — rejected-push update proposal gates', () => {
  const NON_FF = new SpawnFailedError('! [rejected] main -> main (non-fast-forward)');

  it('a rejected non-HEAD branch push gets NO update proposal and NO pull', async () => {
    // Reference: GitPushOperation breaks out of the update loop when the
    // pushed source is not the current branch (pushingNotCurrentBranch,
    // :243-252) — its update leg integrates the CURRENT branch, so proposing
    // Merge/Rebase would pull upstream into a branch the user never touched.
    const log = installMessageTrackers();
    const repo = makeRepo('/repo-a', {
      name: 'refs/heads/main',
      upstream: { remote: 'origin', name: 'main' },
    });
    const { dialog, gitService } = makeDialog({
      gitService: makeGitService({ pushError: NON_FF }),
      repos: [repo],
      preselect: { repo, branch: 'feature', upstream: { remote: 'origin', name: 'feature' } },
    });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'submit', action: 'push' });

    assert.deepStrictEqual(log.warn, [], 'no Merge/Rebase modal for a non-current-branch push');
    assert.strictEqual(gitService.pullCalls.length, 0, 'the current branch is never pulled');
    assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-non-ff', 'rejection surfaces as-is');
    dialog.dispose();
  });

  it('a rejected push to an edited non-tracked target gets NO update proposal', async () => {
    // Reference: pushingToNotTrackedBranch (:231-241) — target differs from
    // the current branch's tracked upstream, so an update would not resolve
    // the rejection.
    const log = installMessageTrackers();
    const repo = makeRepo('/repo-a', {
      name: 'refs/heads/feature',
      upstream: { remote: 'origin', name: 'feature' },
    });
    const { dialog, gitService } = makeDialog({
      gitService: makeGitService({ pushError: NON_FF }),
      repos: [repo],
    });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({
      type: 'updateRow',
      rowId: '/repo-a',
      rowPatch: { targetBranch: 'other' },
    });
    await dialog.simulateMessage({ type: 'submit', action: 'push' });

    assert.deepStrictEqual(log.warn, [], 'no Merge/Rebase modal for a non-tracked target');
    assert.strictEqual(gitService.pullCalls.length, 0);
    dialog.dispose();
  });

  it('a rejected push of a branch with NO upstream gets NO update proposal', async () => {
    const log = installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      gitService: makeGitService({ pushError: NON_FF }),
      repos: [makeRepo('/repo-a', { name: 'refs/heads/feature' })],
    });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'submit', action: 'push' });

    assert.deepStrictEqual(log.warn, [], 'no Merge/Rebase modal without a tracked upstream');
    assert.strictEqual(gitService.pullCalls.length, 0);
    dialog.dispose();
  });

  it('a rejected current-branch push onto its tracked target DOES propose, and the update pull prunes', async () => {
    // Positive control for the gates + F-E4: the one sanctioned update leg
    // must carry prune (every fetch/pull site does — GitImpl.java:648-653
    // appends --prune unconditionally to update fetches).
    const log = installMessageTrackers();
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = async (
      message: string
    ) => {
      log.warn.push(message);
      return 'Merge';
    };
    let attempts = 0;
    const gitServiceIn = makeGitService({
      pushError: () => (++attempts === 1 ? NON_FF : undefined),
    });
    const { dialog, gitService } = makeDialog({
      gitService: gitServiceIn,
      repos: [
        makeRepo('/repo-a', {
          name: 'refs/heads/feature',
          upstream: { remote: 'origin', name: 'feature' },
        }),
      ],
    });
    await dialog.waitUntilPopulated();
    await dialog.simulateMessage({ type: 'submit', action: 'push' });

    assert.strictEqual(log.warn.length, 1, 'the Merge/Rebase modal is shown once');
    assert.strictEqual(gitService.pullCalls.length, 1, 'one update pull before the retry');
    const pullOpts = gitService.pullCalls[0].options as {
      rebase?: boolean;
      autostash?: boolean;
      prune?: boolean;
    };
    assert.strictEqual(pullOpts.rebase, false, 'Merge choice → non-rebase pull');
    assert.strictEqual(pullOpts.autostash, true);
    assert.strictEqual(
      pullOpts.prune,
      true,
      'the update pull must prune like every other fetch/pull site'
    );
    assert.strictEqual(gitService.pushCalls.length, 2, 'rejected push retried after the update');
  });
});

// ─── Revision push source (push up to here — GitPushSource.createRef/createDetached) ───

describe('PushDialog — revision push source (push up to here)', () => {
  const HASH = 'beebeebeebeebeebeebeebeebeebeebeebeebeeb';
  const SHORT = HASH.slice(0, 7);

  describe('buildPushOptions with a revision source', () => {
    it('pushes the hash refspec onto refs/heads/<target> with no positional branch', () => {
      const row = makeRow({ pushSource: { hash: HASH, detached: false } });
      const opts = buildPushOptions(row, 'push', DEFAULT_PUSH_OVERFLOW);
      assert.strictEqual(opts.refspec, `${HASH}:refs/heads/feature`);
      assert.strictEqual(opts.branch, undefined, 'no positional branch beside the refspec');
      assert.strictEqual(opts.remote, 'origin');
    });

    it('never sets --set-upstream, even when the row has no upstream remote', () => {
      const row = makeRow({
        pushSource: { hash: HASH, detached: false },
        upstreamRemote: undefined,
      });
      const opts = buildPushOptions(row, 'push', DEFAULT_PUSH_OVERFLOW);
      assert.strictEqual(
        opts.setUpstream,
        undefined,
        'a revision source is not a branch ref — there is nothing to track (GitPushTarget.shouldSetUpstream)'
      );
      assert.strictEqual(opts.refspec, `${HASH}:refs/heads/feature`);
    });

    it('maps force actions through unchanged', () => {
      const row = makeRow({ pushSource: { hash: HASH, detached: false } });
      const lease = buildPushOptions(row, 'forceWithLease', DEFAULT_PUSH_OVERFLOW);
      assert.strictEqual(lease.forceWithLease, true);
      const force = buildPushOptions(row, 'force', DEFAULT_PUSH_OVERFLOW);
      assert.strictEqual(force.force, true);
    });

    it('a detached row (no local branch) still builds the hash refspec', () => {
      const row = makeRow({
        pushSource: { hash: HASH, detached: true },
        localBranch: '',
        upstreamRemote: undefined,
        targetBranch: 'main',
      });
      const opts = buildPushOptions(row, 'push', DEFAULT_PUSH_OVERFLOW);
      assert.strictEqual(opts.refspec, `${HASH}:refs/heads/main`);
      assert.strictEqual(opts.branch, undefined);
    });

    it('an empty target on a revision row throws instead of producing a broken refspec', () => {
      const row = makeRow({ pushSource: { hash: HASH, detached: true }, targetBranch: '' });
      assert.throws(() => buildPushOptions(row, 'push', DEFAULT_PUSH_OVERFLOW), /target/i);
    });

    it('a malformed hash throws (defense against a smuggled flag)', () => {
      const row = makeRow({ pushSource: { hash: '--upload-pack=evil', detached: false } });
      assert.throws(() => buildPushOptions(row, 'push', DEFAULT_PUSH_OVERFLOW), /hash/i);
    });

    it('a target already in full ref form is not double-prefixed', () => {
      const row = makeRow({
        pushSource: { hash: HASH, detached: false },
        targetBranch: 'refs/heads/qa',
      });
      const opts = buildPushOptions(row, 'push', DEFAULT_PUSH_OVERFLOW);
      assert.strictEqual(opts.refspec, `${HASH}:refs/heads/qa`);
    });
  });

  it('shouldProposeUpdateForRejected never proposes for a revision row, even one shaped like the current tracked branch', () => {
    // An update + re-push of a FIXED hash would push the wrong commit — the
    // reference gates its HEAD^n re-push variant behind a registry flag for
    // exactly this reason.
    const repo = makeRepo('/r', {
      name: 'refs/heads/feature',
      upstream: { remote: 'origin', name: 'feature' },
    });
    const row = makeRow({
      repo,
      localBranch: 'feature',
      targetBranch: 'feature',
      pushSource: { hash: HASH, detached: false },
    });
    assert.strictEqual(shouldProposeUpdateForRejected([row]), false);
  });

  describe('lifecycle', () => {
    it('preselect seeds the row from the containing branch and carries the hash + its own ahead count', async () => {
      const repo = makeRepo('/repo-a', {
        name: 'refs/heads/main',
        upstream: { remote: 'origin', name: 'main' },
        ahead: 5,
      });
      const { dialog } = makeDialog({
        repos: [repo],
        preselect: {
          repo,
          branch: 'feature',
          upstream: { remote: 'origin', name: 'feature' },
          ahead: 2,
          behind: 0,
          pushSource: { hash: HASH, detached: false },
        },
      });
      await dialog.waitUntilPopulated();
      const row = dialog.rows[0];
      assert.strictEqual(row.pushSource?.hash, HASH);
      assert.strictEqual(row.localBranch, 'feature');
      assert.strictEqual(row.targetBranch, 'feature');
      assert.strictEqual(row.upstreamRemote, 'origin');
      assert.strictEqual(row.ahead, 2, "the hash's own count, not HEAD's");
      dialog.dispose();
    });

    it('a revision source on the CURRENT branch still uses the threaded ahead count, not the branch tip', async () => {
      const repo = makeRepo('/repo-a', {
        name: 'refs/heads/feature',
        upstream: { remote: 'origin', name: 'feature' },
        ahead: 5,
      });
      const { dialog } = makeDialog({
        repos: [repo],
        preselect: {
          repo,
          branch: 'feature',
          upstream: { remote: 'origin', name: 'feature' },
          ahead: 2,
          behind: 0,
          pushSource: { hash: HASH, detached: false },
        },
      });
      await dialog.waitUntilPopulated();
      assert.strictEqual(
        dialog.rows[0].ahead,
        2,
        'an older commit on HEAD pushes fewer commits than the tip'
      );
      dialog.dispose();
    });

    it('a detached revision source has no local branch and defaults the target to the current branch name', async () => {
      // GitPushSupport.getDefaultTarget: a detached source targets the
      // current branch name when one exists.
      const repo = makeRepo('/repo-a', {
        name: 'refs/heads/main',
        upstream: { remote: 'origin', name: 'main' },
      });
      const { dialog } = makeDialog({
        repos: [repo],
        preselect: { repo, pushSource: { hash: HASH, detached: true } },
      });
      await dialog.waitUntilPopulated();
      const row = dialog.rows[0];
      assert.strictEqual(row.pushSource?.detached, true);
      assert.strictEqual(row.localBranch, '', 'no local branch contains the commit');
      assert.strictEqual(row.targetBranch, 'main');
      dialog.dispose();
    });

    it('a detached revision source with no current branch targets "detached"', async () => {
      const repo = makeRepo('/repo-a');
      (repo.head as { name?: string }).name = undefined;
      const { dialog } = makeDialog({
        repos: [repo],
        preselect: { repo, pushSource: { hash: HASH, detached: true } },
      });
      await dialog.waitUntilPopulated();
      assert.strictEqual(dialog.rows[0].targetBranch, 'detached');
      dialog.dispose();
    });

    it('submit pushes the hash refspec through gitService.push and toasts the commit, not a branch', async () => {
      const log = installMessageTrackers();
      const repo = makeRepo('/repo-a', {
        name: 'refs/heads/main',
        upstream: { remote: 'origin', name: 'main' },
      });
      const { dialog, gitService } = makeDialog({
        repos: [repo],
        preselect: {
          repo,
          branch: 'feature',
          upstream: { remote: 'origin', name: 'feature' },
          pushSource: { hash: HASH, detached: false },
        },
      });
      await dialog.waitUntilPopulated();
      await dialog.simulateMessage({ type: 'submit', action: 'push' });
      assert.strictEqual(gitService.pushCalls.length, 1);
      assert.strictEqual(gitService.pushCalls[0].options?.refspec, `${HASH}:refs/heads/feature`);
      assert.strictEqual(gitService.pushCalls[0].options?.branch, undefined);
      assert.deepStrictEqual(
        log.info,
        [`Pushed up to ${SHORT}`],
        'a detached row has no branch name to toast'
      );
    });

    it('protected target blocks force submit for a revision row (normal dialog rules apply)', async () => {
      installMessageTrackers();
      const repo = makeRepo('/repo-a', {
        name: 'refs/heads/main',
        upstream: { remote: 'origin', name: 'main' },
      });
      const { dialog, gitService } = makeDialog({
        repos: [repo],
        protectedBranches: ['main'],
        preselect: {
          repo,
          branch: 'main',
          upstream: { remote: 'origin', name: 'main' },
          pushSource: { hash: HASH, detached: false },
        },
      });
      await dialog.waitUntilPopulated();
      await dialog.simulateMessage({ type: 'submit', action: 'forceWithLease' });
      assert.strictEqual(gitService.pushCalls.length, 0, 'the guard blocks before pushing');
      assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-protected');
      dialog.dispose();
    });

    it('a rejected revision row surfaces as-is: NO Merge/Rebase modal, NO pull', async () => {
      const log = installMessageTrackers();
      const NON_FF = new SpawnFailedError('! [rejected] beebeeb -> main (non-fast-forward)');
      const repo = makeRepo('/repo-a', {
        name: 'refs/heads/feature',
        upstream: { remote: 'origin', name: 'feature' },
      });
      const { dialog, gitService } = makeDialog({
        gitService: makeGitService({ pushError: NON_FF }),
        repos: [repo],
        preselect: {
          repo,
          branch: 'feature',
          upstream: { remote: 'origin', name: 'feature' },
          pushSource: { hash: HASH, detached: false },
        },
      });
      await dialog.waitUntilPopulated();
      await dialog.simulateMessage({ type: 'submit', action: 'push' });

      assert.deepStrictEqual(log.warn, [], 'no Merge/Rebase modal for a fixed-hash push');
      assert.strictEqual(gitService.pullCalls.length, 0, 'no update pull');
      assert.strictEqual(gitService.pushCalls.length, 1, 'no retry — the rejection stands');
      assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-non-ff');
      dialog.dispose();
    });
  });

  describe('rendered DOM', () => {
    function renderDoc(dialog: TestPushDialog): Document {
      const bodyHtml = extractWebviewScript(dialog.renderedHtml()).bodyHtml;
      const h = bootWebviewEntry('sync/webview/pushDialog', { bodyHtml });
      _pushHarnesses.push(h);
      return h.document;
    }

    it('the source cell renders the short hash, not the branch tip name', async () => {
      // GitPushSource.OnRevision presentation is the short hash.
      const repo = makeRepo('/repo-a', {
        name: 'refs/heads/main',
        upstream: { remote: 'origin', name: 'main' },
      });
      const { dialog } = makeDialog({
        repos: [repo],
        preselect: {
          repo,
          branch: 'feature',
          upstream: { remote: 'origin', name: 'feature' },
          pushSource: { hash: HASH, detached: false },
        },
      });
      try {
        await dialog.waitUntilPopulated();
        const document = renderDoc(dialog);
        const sourceCell = document.querySelector(
          '#rows tr[data-row-id] td:nth-child(3)'
        ) as HTMLElement;
        assert.strictEqual(sourceCell.textContent, SHORT);
      } finally {
        dialog.dispose();
      }
    });

    it('a rejected revision row offers no Pull-and-Retry affordance', async () => {
      installMessageTrackers();
      const NON_FF = new SpawnFailedError('! [rejected] beebeeb -> feature (non-fast-forward)');
      const repo = makeRepo('/repo-a', {
        name: 'refs/heads/feature',
        upstream: { remote: 'origin', name: 'feature' },
      });
      const { dialog } = makeDialog({
        gitService: makeGitService({ pushError: NON_FF }),
        repos: [repo],
        preselect: {
          repo,
          branch: 'feature',
          upstream: { remote: 'origin', name: 'feature' },
          pushSource: { hash: HASH, detached: false },
        },
      });
      try {
        await dialog.waitUntilPopulated();
        await dialog.simulateMessage({ type: 'submit', action: 'push' });
        const document = renderDoc(dialog);
        const banner = document.querySelector('tr.row-error');
        assert.ok(banner, 'rejection banner renders');
        assert.strictEqual(
          banner.querySelector('button[data-action="pullAndRetry"]'),
          null,
          'pulling cannot make a fixed hash pushable — no update/retry affordance'
        );
      } finally {
        dialog.dispose();
      }
    });
  });
});

// ─── SR-5: incremental patch on updateRow / updateOverflow ───────────────────

describe('PushDialog — SR-5 incremental patch (no full re-render)', () => {
  it('updateRow sends a patchRow message and does NOT trigger _render', async () => {
    installMessageTrackers();
    const { dialog } = makeDialog({ repos: [makeRepo('/repo-a')] });
    await dialog.waitUntilPopulated();

    const rendersBefore = dialog.renderCount;
    dialog.sentMessages = [];
    await dialog.simulateMessage({
      type: 'updateRow',
      rowId: '/repo-a',
      rowPatch: { targetBranch: 'feature-renamed' },
    });

    assert.strictEqual(
      dialog.renderCount,
      rendersBefore,
      `expected no full _render() during updateRow, but renderCount went from ${rendersBefore} to ${dialog.renderCount}`
    );
    const patches = dialog.sentMessages.filter((m) => m.type === 'patchRow');
    assert.strictEqual(patches.length, 1, 'expected exactly one patchRow message');
    const patch = patches[0] as unknown as {
      rowId: string;
      protected: boolean;
      primary: { label: string };
    };
    assert.strictEqual(patch.rowId, '/repo-a');
    assert.strictEqual(patch.protected, false);
    assert.strictEqual(patch.primary.label, 'Push');

    // State update landed internally.
    assert.strictEqual(dialog.rows[0].targetBranch, 'feature-renamed');

    dialog.dispose();
  });

  it('updateRow that makes the target protected reports protected:true in the patch', async () => {
    installMessageTrackers();
    const { dialog } = makeDialog({
      repos: [makeRepo('/repo-a')],
      protectedBranches: ['main'],
    });
    await dialog.waitUntilPopulated();
    dialog.sentMessages = [];

    await dialog.simulateMessage({
      type: 'updateRow',
      rowId: '/repo-a',
      rowPatch: { targetBranch: 'main' },
    });

    const patch = dialog.sentMessages.find((m) => m.type === 'patchRow') as unknown as {
      protected: boolean;
      primary: { anyProtected: boolean };
    };
    assert.strictEqual(patch.protected, true);
    assert.strictEqual(patch.primary.anyProtected, true);
    dialog.dispose();
  });

  it('updateOverflow sends a patchOverflow message and does NOT trigger _render', async () => {
    installMessageTrackers();
    const { dialog } = makeDialog({ repos: [makeRepo('/repo-a')] });
    await dialog.waitUntilPopulated();
    const rendersBefore = dialog.renderCount;
    dialog.sentMessages = [];

    await dialog.simulateMessage({
      type: 'updateOverflow',
      overflow: { noVerify: true, pushTags: false, tagScope: 'follow' },
    });

    assert.strictEqual(
      dialog.renderCount,
      rendersBefore,
      `expected no full _render() during updateOverflow, but renderCount went from ${rendersBefore} to ${dialog.renderCount}`
    );
    const patches = dialog.sentMessages.filter((m) => m.type === 'patchOverflow');
    assert.strictEqual(patches.length, 1, 'expected exactly one patchOverflow message');

    // Internal overflow state updated.
    assert.strictEqual(dialog.overflow.noVerify, true);
    dialog.dispose();
  });

  it('action-select change through updateOverflow reports the new primary label in the patch', async () => {
    installMessageTrackers();
    const { dialog } = makeDialog({ repos: [makeRepo('/repo-a')] });
    await dialog.waitUntilPopulated();
    dialog.sentMessages = [];

    await dialog.simulateMessage({ type: 'updateOverflow', action: 'forceWithLease' });
    const patch = dialog.sentMessages.find((m) => m.type === 'patchOverflow') as unknown as {
      primary: { action: string; label: string };
    };
    assert.strictEqual(patch.primary.action, 'forceWithLease');
    assert.strictEqual(patch.primary.label, 'Force Push with Lease');
    dialog.dispose();
  });

  it('structural change (row error after failed submit) DOES trigger a full _render', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({ repos: [makeRepo('/repo-a')] });
    (gitService as unknown as { push: IGitService['push'] }).push = () =>
      errAsync(new SpawnFailedError('! [rejected] main -> main (non-fast-forward)'));
    await dialog.waitUntilPopulated();
    const rendersBefore = dialog.renderCount;

    await dialog.simulateMessage({ type: 'submit', action: 'push' });

    assert.ok(
      dialog.renderCount > rendersBefore,
      `expected full _render after a failed submit (row error adds structure), got ${dialog.renderCount} vs ${rendersBefore}`
    );
    assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-non-ff');
    dialog.dispose();
  });
});

// ─── rendered DOM (script-built) ─────────────────────────────────────────────

describe('PushDialog — rendered DOM (script-built)', () => {
  /**
   * Run the dialog's inline nonce'd script in jsdom. Post-migration contract:
   * the script BUILDS the table/options/actions via document.createElement —
   * the host markup ships an empty root, not pre-baked controls.
   */
  function renderDoc(dialog: TestPushDialog): { document: Document; posted: unknown[] } {
    const bodyHtml = extractWebviewScript(dialog.renderedHtml()).bodyHtml;
    assert.ok(
      !/id="rows"/.test(bodyHtml),
      'the table must not be pre-baked in host markup — the entry builds the DOM'
    );
    const h = bootWebviewEntry('sync/webview/pushDialog', { bodyHtml });
    _pushHarnesses.push(h);
    return { document: h.document, posted: h.posted };
  }

  it('builds a table row per repository with checkbox, target input, and action bar', async () => {
    const { dialog } = makeDialog({ repos: [makeRepo('/repo-a'), makeRepo('/repo-b')] });
    try {
      await dialog.waitUntilPopulated();
      const { document } = renderDoc(dialog);
      const rows = document.querySelectorAll('#rows tr[data-row-id]');
      assert.strictEqual(rows.length, 2, 'one row per repository');
      assert.strictEqual(
        document.querySelectorAll('input.row-select').length,
        2,
        'a select checkbox per row'
      );
      assert.strictEqual(
        document.querySelectorAll('input.row-target').length,
        2,
        'a target input per row'
      );
      assert.ok(document.querySelector('#action-select'), 'action select built');
      assert.ok(document.querySelector('#push-btn'), 'push button built');
      assert.ok(document.querySelector('#cancel-btn'), 'cancel button built');
    } finally {
      dialog.dispose();
    }
  });

  it('disables BOTH force options in the action select when a selected target is protected', async () => {
    const { dialog } = makeDialog({
      repos: [
        makeRepo('/repo-a', {
          name: 'refs/heads/main',
          upstream: { remote: 'origin', name: 'main' },
        }),
      ],
      protectedBranches: ['main'],
    });
    try {
      await dialog.waitUntilPopulated();
      const { document } = renderDoc(dialog);
      const sel = document.querySelector('#action-select') as HTMLSelectElement;
      const byValue = (v: string): HTMLOptionElement =>
        [...sel.options].find((o) => o.value === v) as HTMLOptionElement;
      assert.strictEqual(byValue('force').disabled, true, 'bare force disabled');
      assert.strictEqual(
        byValue('forceWithLease').disabled,
        true,
        'force-with-lease disabled too — ALL force pushes are prohibited on protected targets'
      );
      assert.strictEqual(byValue('push').disabled, false, 'plain push stays available');
    } finally {
      dialog.dispose();
    }
  });

  it('a stale-lease rejection renders a "Force Push (Anyway)" affordance', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      repos: [makeRepo('/repo-a', { upstream: { remote: 'origin', name: 'feature' } })],
    });
    (gitService as unknown as { push: IGitService['push'] }).push = () =>
      errAsync(new SpawnFailedError('! [rejected]        feature -> feature (stale info)'));
    try {
      await dialog.waitUntilPopulated();
      await dialog.simulateMessage({ type: 'submit', action: 'forceWithLease' });
      assert.strictEqual(dialog.rows[0].error?.kind, 'rejected-stale-lease');
      const { document } = renderDoc(dialog);
      const banner = document.querySelector('tr.row-error');
      assert.ok(banner, 'rejection banner renders');
      const forceBtn = banner.querySelector('button[data-action="forceAnyway-row"]');
      assert.ok(forceBtn, 'stale-lease rejection offers an explicit force-anyway follow-up');
    } finally {
      dialog.dispose();
    }
  });

  it('omits the per-row "Force with Lease" rejection affordance on a protected row', async () => {
    installMessageTrackers();
    const { dialog, gitService } = makeDialog({
      repos: [
        makeRepo('/repo-a', {
          name: 'refs/heads/main',
          upstream: { remote: 'origin', name: 'main' },
        }),
      ],
      protectedBranches: ['main'],
    });
    (gitService as unknown as { push: IGitService['push'] }).push = () =>
      errAsync(new SpawnFailedError('! [rejected] main -> main (non-fast-forward)'));
    try {
      await dialog.waitUntilPopulated();
      await dialog.simulateMessage({ type: 'submit', action: 'push' });
      const { document } = renderDoc(dialog);
      const banner = document.querySelector('tr.row-error');
      assert.ok(banner, 'rejection banner renders');
      const leaseBtn = banner.querySelector('button[data-action="forceWithLease-row"]');
      assert.strictEqual(leaseBtn, null, 'no force-with-lease escape hatch on a protected row');
    } finally {
      dialog.dispose();
    }
  });

  it('toggling a row checkbox posts an updateRow patch', async () => {
    const { dialog } = makeDialog({ repos: [makeRepo('/repo-a')] });
    try {
      await dialog.waitUntilPopulated();
      const { document, posted } = renderDoc(dialog);
      const cb = document.querySelector('input.row-select') as HTMLInputElement;
      cb.checked = false;
      cb.dispatchEvent(
        new (document.defaultView as unknown as { Event: typeof Event }).Event('change', {
          bubbles: true,
        })
      );
      const last = posted.at(-1) as { type: string; rowPatch: { selected: boolean } };
      assert.strictEqual(last.type, 'updateRow', 'change posts an updateRow message');
      assert.strictEqual(last.rowPatch.selected, false, 'carries the new checkbox state');
    } finally {
      dialog.dispose();
    }
  });

  it('tag scope is a dropdown, disabled until "Push tags" is checked, defaulting to All tags', async () => {
    const { dialog } = makeDialog({ repos: [makeRepo('/repo-a')] });
    try {
      await dialog.waitUntilPopulated();
      const { document, posted } = renderDoc(dialog);
      const scope = document.querySelector('#tag-scope') as HTMLSelectElement;
      assert.ok(scope, 'tag scope is a single select, not radios');
      assert.strictEqual(scope.tagName, 'SELECT');
      assert.strictEqual(
        document.querySelectorAll('input[name=tag-scope]').length,
        0,
        'the old tag-scope radios are gone'
      );
      assert.strictEqual(scope.value, 'all', 'defaults to All tags');
      assert.strictEqual(scope.disabled, true, 'disabled while "Push tags" is off');
      const hint = document.querySelector('#tag-hint') as HTMLElement;
      assert.ok(hint, 'a tag-scope hint line is present');
      assert.strictEqual(hint.textContent, '', 'hint is empty while "Push tags" is off');

      const pushTags = document.querySelector('#push-tags') as HTMLInputElement;
      pushTags.checked = true;
      pushTags.dispatchEvent(
        new (document.defaultView as unknown as { Event: typeof Event }).Event('change', {
          bubbles: true,
        })
      );
      assert.strictEqual(scope.disabled, false, 'enables when "Push tags" is checked');
      assert.match(
        hint.textContent ?? '',
        /every local tag/,
        'checking Push tags shows the All-tags explanation'
      );

      const noVerify = document.querySelector('#no-verify') as HTMLInputElement;
      noVerify.checked = true;
      noVerify.dispatchEvent(
        new (document.defaultView as unknown as { Event: typeof Event }).Event('change', {
          bubbles: true,
        })
      );
      assert.match(
        hint.textContent ?? '',
        /Skip the pre-push git hook/,
        'checking --no-verify adds its explanation to the hint'
      );
      const last = posted.at(-1) as {
        type: string;
        overflow: { pushTags: boolean; tagScope: string };
      };
      assert.strictEqual(last.type, 'updateOverflow');
      assert.strictEqual(last.overflow.pushTags, true);
      assert.strictEqual(
        last.overflow.tagScope,
        'all',
        'checking Push tags keeps the All-tags default'
      );
    } finally {
      dialog.dispose();
    }
  });
});

// ─── updateAndRetryRejectedRows (IntelliJ GitPushOperation update loop) ──────

function rejectedRow(id: string): IPushRow {
  return {
    id,
    selected: true,
    repo: { rootUri: { fsPath: id } } as never,
    repoLabel: id,
    localBranch: 'main',
    targetBranch: 'main',
    ahead: 1,
    behind: 1,
    error: { kind: 'rejected-non-ff', message: 'rejected (non-fast-forward)' },
  };
}

describe('updateAndRetryRejectedRows', () => {
  it('leaves the rejection untouched and runs nothing when the user cancels', async () => {
    const pulls: string[] = [];
    const pushes: string[] = [];
    const results = await updateAndRetryRejectedRows(
      {
        pushRow: async (r) => {
          pushes.push(r.id);
          return { ok: true };
        },
        pull: async (r) => {
          pulls.push(r.id);
          return { ok: true };
        },
        askUpdateMethod: async () => undefined,
      },
      [rejectedRow('/a')]
    );
    assert.deepStrictEqual(pulls, []);
    assert.deepStrictEqual(pushes, []);
    const res = results.get('/a');
    assert.ok(res && !res.ok && res.error?.kind === 'rejected-non-ff');
  });

  it('pulls with the chosen method then re-pushes to success', async () => {
    const pulls: Array<{ id: string; method: string }> = [];
    const results = await updateAndRetryRejectedRows(
      {
        pushRow: async () => ({ ok: true }),
        pull: async (r, method) => {
          pulls.push({ id: r.id, method });
          return { ok: true };
        },
        askUpdateMethod: async () => 'merge',
      },
      [rejectedRow('/a')]
    );
    assert.deepStrictEqual(pulls, [{ id: '/a', method: 'merge' }]);
    assert.strictEqual(results.get('/a')?.ok, true);
  });

  it('asks the Merge/Rebase question exactly once for several rejected rows', async () => {
    let asks = 0;
    const results = await updateAndRetryRejectedRows(
      {
        pushRow: async () => ({ ok: true }),
        pull: async () => ({ ok: true }),
        askUpdateMethod: async () => {
          asks += 1;
          return 'rebase';
        },
      },
      [rejectedRow('/a'), rejectedRow('/b')]
    );
    assert.strictEqual(asks, 1);
    assert.strictEqual(results.get('/a')?.ok, true);
    assert.strictEqual(results.get('/b')?.ok, true);
  });

  it('caps a persistent rejection at MAX_PUSH_ATTEMPTS total pushes', async () => {
    let pushCount = 0;
    const results = await updateAndRetryRejectedRows(
      {
        pushRow: async () => {
          pushCount += 1;
          return {
            ok: false,
            error: { kind: 'rejected-non-ff', message: 'still rejected' },
          } as IPushRowResult;
        },
        pull: async () => ({ ok: true }),
        askUpdateMethod: async () => 'merge',
      },
      [rejectedRow('/a')]
    );
    // The submit's first push was attempt 1; the loop owns the rest.
    assert.strictEqual(pushCount, MAX_PUSH_ATTEMPTS - 1);
    const res = results.get('/a');
    assert.ok(res && !res.ok && res.error?.kind === 'rejected-non-ff');
  });

  it('stops a row on a failed update and reports it without re-pushing', async () => {
    const pushes: string[] = [];
    const results = await updateAndRetryRejectedRows(
      {
        pushRow: async (r) => {
          pushes.push(r.id);
          return { ok: true };
        },
        pull: async (r) =>
          r.id === '/a' ? { ok: false, message: 'CONFLICT (content): a.txt' } : { ok: true },
        askUpdateMethod: async () => 'merge',
      },
      [rejectedRow('/a'), rejectedRow('/b')]
    );
    const resA = results.get('/a');
    assert.ok(resA && !resA.ok && resA.error?.kind === 'other');
    assert.ok(resA.error.message.includes('CONFLICT'), resA.error.message);
    assert.deepStrictEqual(pushes, ['/b'], 'only the updated row is re-pushed');
    assert.strictEqual(results.get('/b')?.ok, true);
  });

  it('drops a row from the loop when a retry fails for a non-non-ff reason', async () => {
    let pushCount = 0;
    const results = await updateAndRetryRejectedRows(
      {
        pushRow: async () => {
          pushCount += 1;
          return {
            ok: false,
            error: { kind: 'auth', message: 'authentication failed' },
          } as IPushRowResult;
        },
        pull: async () => ({ ok: true }),
        askUpdateMethod: async () => 'merge',
      },
      [rejectedRow('/a')]
    );
    assert.strictEqual(pushCount, 1, 'a non-retriable failure ends the loop');
    assert.strictEqual(results.get('/a')?.error?.kind, 'auth');
  });
});

// ─── Row-banner message ──────────────────────────────────────────────────────

describe('classified push failures surface a concise banner message', () => {
  const RAW_NON_FF = [
    'Git command failed: git push --end-of-options origin HEAD:refs/heads/dev',
    'To https://example.com/remote.git',
    ' ! [rejected]        dev -> dev (non-fast-forward)',
    'hint: Updates were rejected because the tip of your current branch is behind',
    'hint: its remote counterpart. Integrate the remote changes before pushing again.',
  ].join('\n');

  async function pushError(err: Error, row = makeRow()): Promise<IPushRowResult> {
    const gitService = makeGitService({ pushError: err });
    return runPushRow({ gitService, protectedBranches: [] }, row, 'push', makeOverflow());
  }

  it('names the rejected target instead of echoing the git invocation', async () => {
    const result = await pushError(new SpawnFailedError(RAW_NON_FF));

    assert.strictEqual(
      result.error?.message,
      "Push to 'feature' was rejected: the remote has commits you don't have. " +
        'Remote changes need to be merged before pushing.'
    );
  });

  it('keeps the git command line out of the banner on a rejection', async () => {
    const result = await pushError(new SpawnFailedError(RAW_NON_FF));

    assert.ok(
      !/git push|--end-of-options/.test(result.error?.message ?? ''),
      result.error?.message
    );
  });

  it('explains a refused lease as a remote that moved since the last fetch', async () => {
    const result = await pushError(
      new SpawnFailedError('! [rejected] dev -> dev (stale info)\nhint: ...')
    );

    assert.strictEqual(
      result.error?.message,
      "Force push with lease to 'feature' was rejected: the remote was updated after your last fetch."
    );
  });

  it('reports an auth failure and keeps the remote text under the one-liner', async () => {
    const result = await pushError(
      new SpawnFailedError('remote: Authentication failed\nhint: see gh auth login')
    );

    assert.strictEqual(
      result.error?.message,
      'Push failed: the remote rejected your credentials.\n' +
        'remote: Authentication failed\nhint: see gh auth login'
    );
  });

  it('reports a declined pre-push hook and keeps the hook output', async () => {
    const result = await pushError(
      new SpawnFailedError('error: failed to push some refs\npre-push hook declined')
    );

    assert.strictEqual(
      result.error?.message,
      'Push failed: the pre-push hook rejected the push.\n' +
        'error: failed to push some refs\npre-push hook declined'
    );
  });

  it('reports a server-side protected-branch rejection against the target', async () => {
    const result = await pushError(
      new SpawnFailedError('remote: GH006: Protected branch update failed for refs/heads/main')
    );

    assert.strictEqual(
      result.error?.message,
      "Push to 'feature' was rejected: the remote protects that branch."
    );
  });

  it('falls back to the sanitized git output when the failure is unclassified', async () => {
    const result = await pushError(new SpawnFailedError('fatal: the disk is on fire'));

    assert.strictEqual(result.error?.kind, 'other');
    assert.ok(result.error?.message.includes('the disk is on fire'), result.error?.message);
  });
});
