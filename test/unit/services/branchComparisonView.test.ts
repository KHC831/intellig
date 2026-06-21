/**
 * BranchComparisonView refresh() canonical-channel
 * contract. Mirrors the StashView migration in the same wave.
 *
 * Before BranchComparisonView used the `_state.error`
 * sideband: `_performComparison()` stashed the error message into
 * `_state.error`, and `show()` read it back at line 127. Per ADR-006
 * (`docs/adr/ADR-006-error-state-binding-by-view-type.md`), QuickPick
 * views surface refresh failures through the refresh()/setBranches()
 * return value rather than a sideband on view state.
 *
 * These specs pin the new contract:
 *   (a) successful refresh resolves to `{}` — no error key present
 *   (b) failing refresh resolves to `{ error: <sanitized> }`
 *   (c) getState() carries no `error` field after either path
 *   (d) sanitized credentialed URLs / home paths in the returned error
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { createBranchComparisonView } from '../../../src/branches/BranchComparisonView';
import {
  IGitService,
  IRepository,
  IBranchComparison,
  ICommit,
} from '../../../src/git-core/interfaces/IGitService';
import { EventEmitter, Uri } from '../../mocks/vscode';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function makeEmptyComparison(): IBranchComparison {
  return {
    commitsAhead: [],
    commitsBehind: [],
    aheadCount: 0,
    behindCount: 0,
    changedFiles: [],
  };
}

/**
 * Build an IGitService stub whose `compareBranches` is controllable per spec.
 * Default returns an empty (no-diff) comparison; override `compareImpl` to
 * exercise the failure path.
 */
function makeGitService(opts?: {
  compareImpl?: (repo: IRepository, b1: string, b2: string) => Promise<IBranchComparison>;
}): IGitService {
  const emitter = new EventEmitter<IRepository>();
  const svc = {
    onDidChangeRepository: emitter.event,
    getRepositories: () => [],
    getRepository: async () => undefined,
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
    compareBranches: async (
      repo: IRepository,
      b1: string,
      b2: string
    ): Promise<IBranchComparison> => {
      if (opts?.compareImpl) {
        return opts.compareImpl(repo, b1, b2);
      }
      return makeEmptyComparison();
    },
    fetch: async () => ({ updatedRefs: [], ahead: 0, behind: 0, errors: [] }),
    onDidFetch: () => ({ dispose: () => {} }),
    resetToCommit: async () => {},
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
    stashBranch: async () => {},
    stashRename: async () => {},
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
    dispose: () => {},
  } as unknown as IGitService;
  return svc;
}

/**
 * The error-toast path inside `_performComparison` calls
 * `vscode.window.showErrorMessage` directly. We swallow it during these
 * specs since refreshing-on-error is a behaviour the callers exercise; we
 * focus on the refresh() return value as the canonical channel.
 */
function silenceErrorToast(): { restore: () => void } {
  const oErr = vscode.window.showErrorMessage;
  (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage =
    async (): Promise<undefined> => undefined;
  return {
    restore: (): void => {
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
    },
  };
}

describe('BranchComparisonView TL-68 — refresh() returns { error? } (no _state.error sideband)', () => {
  it('refresh() resolves with {} when compareBranches succeeds', async () => {
    const gitService = makeGitService();
    const view = createBranchComparisonView(gitService);
    try {
      // Prime internal state without launching the QuickPick UI.
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      const setResult = await view.setBranches('main', 'feature/x');
      assert.deepStrictEqual(setResult, {}, 'setBranches must resolve to {} on success');

      const result = await view.refresh();
      assert.deepStrictEqual(result, {}, 'refresh must resolve to {} on success');
    } finally {
      view.dispose();
    }
  });

  it('refresh() resolves with { error } when compareBranches throws', async () => {
    const gitService = makeGitService({
      compareImpl: () => Promise.reject(new Error('compare failed')),
    });
    const view = createBranchComparisonView(gitService);
    const { restore } = silenceErrorToast();
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      const setResult = await view.setBranches('main', 'feature/x');
      assert.ok(setResult.error, 'setBranches must surface the error on its return value');
      assert.ok(
        setResult.error.includes('compare failed'),
        `unexpected setBranches error: ${setResult.error}`
      );

      const result = await view.refresh();
      assert.ok(result.error, 'refresh must surface the error on its return value');
      assert.ok(
        result.error.includes('compare failed'),
        `unexpected refresh error: ${result.error}`
      );
    } finally {
      restore();
      view.dispose();
    }
  });

  it('getState() does not expose an error field — refresh() is the sole error channel', async () => {
    const gitService = makeGitService();
    const view = createBranchComparisonView(gitService);
    const { restore } = silenceErrorToast();
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();

      // Successful path
      await view.setBranches('main', 'feature/x');
      assert.strictEqual(
        'error' in view.getState(),
        false,
        'getState() must not carry an error field after a successful comparison'
      );

      // Failing path — switch the impl and re-run.
      (gitService as unknown as { compareBranches: unknown }).compareBranches =
        (): Promise<never> => Promise.reject(new Error('compare failed'));
      const result = await view.refresh();
      assert.ok(result.error, 'refresh() must surface error on return value');
      assert.strictEqual(
        'error' in view.getState(),
        false,
        'getState() must not carry an error field after a failed comparison — refresh() return is canonical'
      );
    } finally {
      restore();
      view.dispose();
    }
  });

  it('sanitizes credentialed URLs and home paths in the returned error', async () => {
    const RAW = 'compare failed: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'compare failed: https://<redacted>@example.com/repo.git\n~/project';
    const gitService = makeGitService({
      compareImpl: () => Promise.reject(new Error(RAW)),
    });
    const view = createBranchComparisonView(gitService);
    const { restore } = silenceErrorToast();
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      const setResult = await view.setBranches('main', 'feature/x');
      assert.strictEqual(setResult.error, EXPECTED);
      assert.ok(
        !setResult.error?.includes('alice:secret'),
        'returned error must not leak credentials'
      );
      assert.ok(
        !setResult.error?.includes('/Users/alice'),
        'returned error must not leak home path'
      );
    } finally {
      restore();
      view.dispose();
    }
  });

  it('refresh() resolves with {} when no branches are bound (no-op)', async () => {
    const gitService = makeGitService();
    const view = createBranchComparisonView(gitService);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      // Don't call setBranches — refresh() should no-op.
      const result = await view.refresh();
      assert.deepStrictEqual(result, {});
    } finally {
      view.dispose();
    }
  });
});

// `_showComparisonResults` early-return after a
// failed comparison.
//
// Background: the action handler used a non-null assertion
// (`this._state.comparison!`) when rebuilding QuickPick items.
// dropped the bang in favour of an explicit nullable guard, but the
// guard was a code-only change with no spec pinning the contract.
// This test seals the early-return so future maintainers can't strip
// the guard back out without the suite catching it.
//
// Behaviour under test:
//   - When `_state.comparison === undefined` (the post-error state),
//     `_showComparisonResults` must NOT call `vscode.window.createQuickPick`.
//     The method short-circuits at the early-return at the top of the
//     body. Removing the guard would cause `createQuickPick` to be
//     called and downstream code to crash on the now-undefined
//     comparison.
describe('BranchComparisonView TL-75 — _showComparisonResults early-return after failed comparison', () => {
  /**
   * Test surface — reaches into the private method for direct invocation.
   * Standard `TestSurface` idiom (see `docs/testing.md` section 3): the public
   * surface (`show()` → `_performComparison` → `_showComparisonResults`)
   * already short-circuits at `show()` line 129 before we'd reach the
   * private method, so we can't drive the invariant through the public
   * API alone. The seam exists explicitly to pin the inner guard.
   */
  interface BranchComparisonViewTestSurface {
    _state: { comparison: unknown; branch1: string | undefined; branch2: string | undefined };
    _showComparisonResults: () => void;
    _repository: IRepository | undefined;
  }

  it('does NOT call createQuickPick when _state.comparison is undefined', () => {
    const gitService = makeGitService();
    const view = createBranchComparisonView(gitService);
    try {
      const surface = view as unknown as BranchComparisonViewTestSurface;
      surface._repository = makeRepo();

      // Simulate the post-failed-refresh state: branches set, comparison
      // cleared (which is exactly what `_performComparison` does in its
      // catch block).
      surface._state.branch1 = 'main';
      surface._state.branch2 = 'feature/x';
      surface._state.comparison = undefined;

      // Spy on `createQuickPick` to see whether `_showComparisonResults`
      // tries to build one. The mock does not implement
      // `createQuickPick`, so invoking it would crash — but the early-
      // return guard means we never get there. Install a recording
      // stub so the test reads cleanly either way.
      let createQuickPickCalls = 0;
      const win = vscode.window as unknown as {
        createQuickPick?: () => unknown;
      };
      const original = win.createQuickPick;
      win.createQuickPick = (): unknown => {
        createQuickPickCalls++;
        // Return a minimal shape so a missing-guard regression doesn't
        // crash the test inside the method body — we want to see the
        // count, not a stack trace.
        return {
          title: '',
          placeholder: '',
          items: [],
          matchOnDescription: false,
          matchOnDetail: false,
          selectedItems: [],
          onDidAccept: () => ({ dispose: (): void => {} }),
          onDidHide: () => ({ dispose: (): void => {} }),
          show: (): void => {},
          hide: (): void => {},
          dispose: (): void => {},
        };
      };

      try {
        surface._showComparisonResults();
      } finally {
        win.createQuickPick = original;
      }

      assert.strictEqual(
        createQuickPickCalls,
        0,
        '_showComparisonResults must early-return when _state.comparison is undefined; createQuickPick should never be called on the failure path'
      );
    } finally {
      view.dispose();
    }
  });

  it('still calls createQuickPick when _state.comparison is populated (positive path)', () => {
    const gitService = makeGitService();
    const view = createBranchComparisonView(gitService);
    try {
      const surface = view as unknown as BranchComparisonViewTestSurface;
      surface._repository = makeRepo();

      // Populated-comparison state — the happy path. Mirrors what
      // `_performComparison` writes on success.
      surface._state.branch1 = 'main';
      surface._state.branch2 = 'feature/x';
      surface._state.comparison = makeEmptyComparison();

      let createQuickPickCalls = 0;
      const win = vscode.window as unknown as {
        createQuickPick?: () => unknown;
      };
      const original = win.createQuickPick;
      win.createQuickPick = (): unknown => {
        createQuickPickCalls++;
        return {
          title: '',
          placeholder: '',
          items: [],
          matchOnDescription: false,
          matchOnDetail: false,
          selectedItems: [],
          onDidAccept: () => ({ dispose: (): void => {} }),
          onDidHide: () => ({ dispose: (): void => {} }),
          show: (): void => {},
          hide: (): void => {},
          dispose: (): void => {},
        };
      };

      try {
        surface._showComparisonResults();
      } finally {
        win.createQuickPick = original;
      }

      assert.strictEqual(
        createQuickPickCalls,
        1,
        'positive-path sanity: with _state.comparison populated, createQuickPick must be called exactly once'
      );
    } finally {
      view.dispose();
    }
  });
});

// action-path catch-block toasts must run through
// `sanitizeGitError`. Pre-fix, `viewCommit` and `_showFileDiffContent`
// concatenated raw `error.message` into the toast template, so a
// credentialed remote URL or absolute home path in stderr leaked
// straight into the user's notification history. The refresh-path
// (`_performComparison` line 412 area) was already sanitised in;
// these two action paths are the residual sites.
describe('BranchComparisonView TL-72 — action-path toasts route through sanitizeGitError', () => {
  const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
  const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';

  function captureErrorToasts(): { errors: string[]; restore: () => void } {
    const errors: string[] = [];
    const oErr = vscode.window.showErrorMessage;
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
      m: string
    ): Promise<string | undefined> => {
      errors.push(m);
      return undefined;
    };
    return {
      errors,
      restore: (): void => {
        (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
      },
    };
  }

  function makeCommit(): ICommit {
    return {
      hash: 'a1b2c3d4',
      shortHash: 'a1b2c3d',
      message: 'feat: thing',
      author: { name: 'A', email: 'a@b.co' },
      committer: { name: 'A', email: 'a@b.co' },
      parents: [],
      authorDate: new Date('2026-01-01'),
      commitDate: new Date('2026-01-01'),
    };
  }

  it('viewCommit sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService();
    (gitService as unknown as { getCommitDiff: unknown }).getCommitDiff = (): Promise<never> =>
      Promise.reject(new Error(RAW));
    const view = createBranchComparisonView(gitService);
    const { errors, restore } = captureErrorToasts();
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      await view.viewCommit(makeCommit());
      assert.strictEqual(errors.length, 1, 'expected one error toast');
      assert.strictEqual(errors[0], `Failed to view commit: ${EXPECTED}`);
      assert.ok(!errors[0].includes('alice:secret'), 'toast must not leak credentials');
      assert.ok(!errors[0].includes('/Users/alice'), 'toast must not leak home path');
    } finally {
      restore();
      view.dispose();
    }
  });

  it('_showFileDiffContent sanitizes credentialed URL + home path in toast', async () => {
    const gitService = makeGitService();
    // _showFileDiffContent reaches into gitCli.exec — make that throw.
    (gitService as unknown as { gitCli: unknown }).gitCli = {
      exec: (): Promise<never> => Promise.reject(new Error(RAW)),
    };
    const view = createBranchComparisonView(gitService);
    const { errors, restore } = captureErrorToasts();
    try {
      // Prime branches so _showFileDiffContent won't early-return.
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      (view as unknown as { _state: { branch1?: string; branch2?: string } })._state.branch1 =
        'main';
      (view as unknown as { _state: { branch1?: string; branch2?: string } })._state.branch2 =
        'feature/x';

      await (
        view as unknown as { _showFileDiffContent: (filePath: string) => Promise<void> }
      )._showFileDiffContent('src/app.ts');

      assert.strictEqual(errors.length, 1, 'expected one error toast');
      assert.strictEqual(errors[0], `Failed to get file diff: ${EXPECTED}`);
      assert.ok(!errors[0].includes('alice:secret'), 'toast must not leak credentials');
      assert.ok(!errors[0].includes('/Users/alice'), 'toast must not leak home path');
    } finally {
      restore();
      view.dispose();
    }
  });
});

// [HIGH-class] argv injection — `_showFileDiffContent` lands
// `${branch1}...${branch2}` as the LEADING positional after `diff`. The branch
// names are repo-derived refs; a `-`-leading one (e.g. `--output=/tmp/pwned`,
// authorable in a hostile clone's packed-refs and selectable via the Compare
// UI) would be parsed by git as a flag — `git diff --output=<file> …` writes an
// arbitrary out-of-repo file. The range MUST ride behind `--end-of-options`.
describe('BranchComparisonView — diff argv-injection (--end-of-options before the range)', () => {
  function captureDiffArgv(): {
    calls: string[][];
    gitCli: { exec: (args: string[], options: { cwd: string }) => Promise<unknown> };
  } {
    const calls: string[][] = [];
    return {
      calls,
      gitCli: {
        exec: (args: string[]): Promise<unknown> => {
          calls.push([...args]);
          // exitCode 0 + empty stdout → method shows an info toast and returns,
          // avoiding the openTextDocument success path.
          return Promise.resolve({ stdout: '', exitCode: 0 });
        },
      },
    };
  }

  it('treats a `--output=`-style branch name as a REV, never as a git flag', async () => {
    const gitService = makeGitService();
    const { calls, gitCli } = captureDiffArgv();
    (gitService as unknown as { gitCli: unknown }).gitCli = gitCli;
    const view = createBranchComparisonView(gitService);
    try {
      (view as unknown as { _repository: IRepository })._repository = makeRepo();
      const state = (view as unknown as { _state: { branch1?: string; branch2?: string } })._state;
      state.branch1 = '--output=/tmp/pwned';
      state.branch2 = 'main';

      await (
        view as unknown as { _showFileDiffContent: (filePath: string) => Promise<void> }
      )._showFileDiffContent('src/app.ts');

      assert.strictEqual(calls.length, 1, 'expected one git diff invocation');
      const argv = calls[0];
      const eooIdx = argv.indexOf('--end-of-options');
      assert.ok(eooIdx > 0, `expected --end-of-options in argv, got ${JSON.stringify(argv)}`);
      // The payload must not sit ahead of the separator (where git parses flags).
      for (let i = 1; i < eooIdx; i++) {
        assert.ok(
          !argv[i].startsWith('--output'),
          `--output payload landed as a flag before --end-of-options: ${JSON.stringify(argv)}`
        );
      }
      const rangeIdx = argv.indexOf('--output=/tmp/pwned...main', eooIdx);
      assert.ok(
        rangeIdx > eooIdx,
        `range token must ride after --end-of-options; got ${JSON.stringify(argv)}`
      );
    } finally {
      view.dispose();
    }
  });
});
