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
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  buildPushOptions,
  classifyPushError,
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

interface MockGitServiceOptions {
  pushError?: Error | ((repo: IRepository, options?: IPushOptions) => Error | undefined);
}

function makeGitService(
  options: MockGitServiceOptions = {}
): IGitService & { pushCalls: PushCallLog[] } {
  const pushCalls: PushCallLog[] = [];
  const emitter = new EventEmitter<IRepository>();
  const service = {
    pushCalls,
    onDidChangeRepository: emitter.event,
    getRepository: async () => undefined,
    getRepositories: () => [],
    getBranches: async () => [],
    getTags: async () => [],
    commit: async () => {},
    amend: async () => {},
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
    fetch: async () => ({ updatedRefs: [], ahead: 0, behind: 0, errors: [] }),
    pull: async () => {},
    push: async (repo: IRepository, opts?: IPushOptions) => {
      pushCalls.push({ repo, options: opts });
      if (typeof options.pushError === 'function') {
        const err = options.pushError(repo, opts);
        if (err) {
          throw err;
        }
      } else if (options.pushError) {
        throw options.pushError;
      }
    },
    getRemotes: async () => [],
    addRemote: async () => {},
    removeRemote: async () => {},
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
    stage: async () => {},
    unstage: async () => {},
    stageHunk: async () => {},
    stageLines: async () => {},
    unstageHunk: async () => {},
    revertFile: async () => {},
    resetToCommit: async () => {},
    dispose: () => {},
  } as unknown as IGitService & { pushCalls: PushCallLog[] };
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
  gitService: IGitService & { pushCalls: PushCallLog[] };
  pullDialogCalls: Array<{ repo: IRepository; preset?: string; prefilledSource?: unknown }>;
} {
  const gitService =
    (overrides.gitService as (IGitService & { pushCalls: PushCallLog[] }) | undefined) ??
    makeGitService();
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
    it('falls back to other for unknown errors', () => {
      assert.strictEqual(classifyPushError('some weird git thing'), 'other');
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
    it('always allows forceWithLease even on protected target', () => {
      const row = makeRow({ targetBranch: 'main' });
      assert.strictEqual(isActionAllowedForRow(row, 'forceWithLease', ['main']), true);
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

  it('protected-target allows forceWithLease', async () => {
    const gitService = makeGitService();
    const deps: IRunPushRowDeps = { gitService, protectedBranches: ['main'] };
    const row = makeRow({ targetBranch: 'main' });
    const result = await runPushRow(deps, row, 'forceWithLease', makeOverflow());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(gitService.pushCalls[0].options?.forceWithLease, true);
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
    (gitService as unknown as { push: (r: IRepository) => Promise<void> }).push = async () => {
      throw new Error('! [rejected] main -> main (non-fast-forward)');
    };
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
    (gitService as unknown as { push: () => Promise<void> }).push = async () => {
      throw new Error('! [rejected] main -> main (non-fast-forward)');
    };
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
    (gitService as unknown as { push: () => Promise<void> }).push = async () => {
      throw new Error('remote: GH006: Protected branch update failed');
    };
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
    (gitService as unknown as { push: () => Promise<void> }).push = async () => {
      throw new Error('! [rejected] main -> main (non-fast-forward)');
    };
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
