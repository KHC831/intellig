/**
 * Unit tests for T2-06 CommitDialog polish:
 *  - Recent-messages LRU integration (shared with CommitToolWindow).
 *  - Custom author override (validation + --author pass-through).
 *  - Gear-menu items: --no-verify toggle + disabled "Run before-commit
 *    checks" stub.
 *
 * The CommitDialog webview is not instantiated in every test — tests call
 * the exported `performCommit` helper directly (it's the single code path
 * shared by CommitDialog and CommitToolWindow) plus the
 * `buildGearMenuItems` / `isValidAuthorFormat` pure helpers.
 *
 * Persistence is asserted against a lightweight in-memory `Memento` that
 * mirrors the VS Code workspaceState contract.
 */

/*
 * Stub factories synthesise IGitService implementations whose member
 * signatures return `Promise<T>`; no-await stub bodies are intentional here.
 */

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  performCommit,
  isValidAuthorFormat,
  AUTHOR_FORMAT_REGEX,
  buildGearMenuItems,
  LAST_NO_VERIFY_STATE_KEY,
  CommitDialog,
  createCommitDialog,
} from '../../../services/CommitDialog';
import {
  RECENT_MESSAGES_STATE_KEY,
  RECENT_MESSAGES_MAX,
  updateRecentMessagesLru,
} from '../../../services/CommitToolWindow';
import type {
  IGitService,
  IRepository,
  ICommitOptions,
} from '../../../services/interfaces/IGitService';
import { EventEmitter, Uri } from '../../mocks/vscode';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface CallLog {
  method: string;
  args: unknown[];
}

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

function makeGitService(overrides?: {
  commitImpl?: (repo: IRepository, message: string, options: ICommitOptions) => Promise<void>;
  stageImpl?: (repo: IRepository, paths: string[]) => Promise<void>;
  unstageImpl?: (repo: IRepository, paths: string[]) => Promise<void>;
}): IGitService & { calls: CallLog[] } {
  const calls: CallLog[] = [];
  const emitter = new EventEmitter<IRepository>();
  const svc = {
    calls,
    onDidChangeRepository: emitter.event,
    getRepositories: () => [],
    getRepository: async () => undefined,
    getBranches: async () => [],
    getTags: async () => [],
    commit: async (repo: IRepository, message: string, options: ICommitOptions): Promise<void> => {
      calls.push({ method: 'commit', args: [repo, message, options] });
      if (overrides?.commitImpl) {
        await overrides.commitImpl(repo, message, options);
      }
    },
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
    stage: async (repo: IRepository, paths: string[]): Promise<void> => {
      calls.push({ method: 'stage', args: [repo, paths] });
      if (overrides?.stageImpl) {
        await overrides.stageImpl(repo, paths);
      }
    },
    unstage: async (repo: IRepository, paths: string[]): Promise<void> => {
      calls.push({ method: 'unstage', args: [repo, paths] });
      if (overrides?.unstageImpl) {
        await overrides.unstageImpl(repo, paths);
      }
    },
    stageHunk: async () => {},
    stageLines: async () => {},
    unstageHunk: async () => {},
    revertFile: async () => {},
    dispose: () => {},
  } as unknown as IGitService & { calls: CallLog[] };
  return svc;
}

/**
 * Lightweight Memento impl for workspaceState. Good enough for these tests.
 */
class InMemoryMemento implements vscode.Memento {
  private _store = new Map<string, unknown>();
  keys(): readonly string[] {
    return Array.from(this._store.keys());
  }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this._store.has(key)) {
      return this._store.get(key) as T;
    }
    return defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this._store.delete(key);
    } else {
      this._store.set(key, value);
    }
    return Promise.resolve();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setKeysForSync?(_keys: string[]): void {
    // no-op; only present on newer VS Code API
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CommitDialog T2-06 — recent messages + author + gear', () => {
  describe('isValidAuthorFormat / AUTHOR_FORMAT_REGEX', () => {
    const accept = [
      'Ada Lovelace <ada@example.com>',
      'Kit-Ho Chan <kho@example.org>',
      'A B <a@b.co>',
      'Bob O. <bob+git@team.example>',
      'Name With Spaces <n@example.com>',
    ];
    const reject = [
      'Just Name',
      'no-email@example.com',
      'Bad <no-at-sign>',
      '<only@email.com>',
      'Name <weird space@example.com>',
      'Name <<nested@example.com>',
      'Name <unclosed@example.com',
    ];

    for (const ok of accept) {
      it(`accepts: ${ok}`, () => {
        assert.strictEqual(AUTHOR_FORMAT_REGEX.test(ok), true);
        assert.strictEqual(isValidAuthorFormat(ok), true);
      });
    }
    for (const bad of reject) {
      it(`rejects: ${bad}`, () => {
        assert.strictEqual(AUTHOR_FORMAT_REGEX.test(bad), false);
        assert.strictEqual(isValidAuthorFormat(bad), false);
      });
    }

    it('treats empty / whitespace-only as valid (= "no override")', () => {
      assert.strictEqual(isValidAuthorFormat(undefined), true);
      assert.strictEqual(isValidAuthorFormat(''), true);
      assert.strictEqual(isValidAuthorFormat('   '), true);
    });
  });

  describe('performCommit — author pass-through', () => {
    it('passes --author when the override is valid', async () => {
      const gitService = makeGitService();
      const repo = makeRepo();
      const result = await performCommit(gitService, repo, {
        message: 'feat: thing',
        selectedFiles: ['a.ts'],
        allFiles: [{ path: 'a.ts', staged: true }],
        author: 'Kit <k@e.com>',
      });
      assert.strictEqual(result.success, true);
      const commitCall = gitService.calls.find((c) => c.method === 'commit');
      assert.ok(commitCall);
      const opts = commitCall.args[2] as ICommitOptions;
      assert.strictEqual(opts.author, 'Kit <k@e.com>');
    });

    it('does NOT attach --author when the override is empty', async () => {
      const gitService = makeGitService();
      const repo = makeRepo();
      await performCommit(gitService, repo, {
        message: 'feat: thing',
        selectedFiles: ['a.ts'],
        allFiles: [{ path: 'a.ts', staged: true }],
      });
      const commitCall = gitService.calls.find((c) => c.method === 'commit');
      const opts = commitCall!.args[2] as ICommitOptions;
      assert.strictEqual(opts.author, undefined);
    });

    it('rejects invalid author BEFORE any git stage/unstage/commit call', async () => {
      const gitService = makeGitService();
      const repo = makeRepo();
      const result = await performCommit(gitService, repo, {
        message: 'feat: thing',
        selectedFiles: ['a.ts'],
        allFiles: [{ path: 'a.ts', staged: true }],
        author: 'not-valid',
      });
      assert.strictEqual(result.success, false);
      assert.ok(result.error && result.error.includes('Invalid author format'));
      // No git operations at all.
      assert.strictEqual(gitService.calls.length, 0);
    });

    it('passes --no-verify when noVerify is true', async () => {
      const gitService = makeGitService();
      const repo = makeRepo();
      await performCommit(gitService, repo, {
        message: 'feat: thing',
        selectedFiles: ['a.ts'],
        allFiles: [{ path: 'a.ts', staged: true }],
        noVerify: true,
      });
      const commitCall = gitService.calls.find((c) => c.method === 'commit');
      const opts = commitCall!.args[2] as ICommitOptions;
      assert.strictEqual(opts.noVerify, true);
    });

    it('sends noVerify=false when omitted (back-compat)', async () => {
      const gitService = makeGitService();
      const repo = makeRepo();
      await performCommit(gitService, repo, {
        message: 'feat: thing',
        selectedFiles: ['a.ts'],
        allFiles: [{ path: 'a.ts', staged: true }],
      });
      const commitCall = gitService.calls.find((c) => c.method === 'commit');
      const opts = commitCall!.args[2] as ICommitOptions;
      assert.strictEqual(opts.noVerify, false);
    });

    it('remains back-compat with callers that supply no new options', async () => {
      // T1-04 CommitToolWindow calls performCommit with only the original
      // option set. This test mirrors that shape to guard the contract.
      const gitService = makeGitService();
      const repo = makeRepo();
      const result = await performCommit(gitService, repo, {
        message: 'chore: bump',
        selectedFiles: ['pkg.json'],
        allFiles: [{ path: 'pkg.json', staged: true }],
        amend: false,
        signOff: false,
      });
      assert.strictEqual(result.success, true);
    });
  });

  describe('CommitDialog recent-messages LRU', () => {
    it('pushes the commit message onto the shared recent-messages LRU on success', async () => {
      const mem = new InMemoryMemento();
      const gitService = makeGitService();
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService, mem);
      try {
        // Drive _handleCommit through the internal path — the dialog's own
        // webview isn't available under the mock, so we call the handler
        // directly after priming the internal state.
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        (dialog as unknown as { _stagedFiles: unknown })._stagedFiles = [
          { path: 'a.ts', status: 'M', staged: true, selected: true },
        ];
        (dialog as unknown as { _commitMessage: string })._commitMessage = 'feat: hello';

        await (
          dialog as unknown as {
            _handleCommit: (m: { type: string; message?: string }) => Promise<void>;
          }
        )._handleCommit({ type: 'commit', message: 'feat: hello' });

        const lru = mem.get<string[]>(RECENT_MESSAGES_STATE_KEY, []);
        assert.deepStrictEqual(lru, ['feat: hello']);
      } finally {
        dialog.dispose();
      }
    });

    it('de-duplicates and respects the shared RECENT_MESSAGES_MAX', async () => {
      // The LRU helper is the same one CommitToolWindow uses; verify it
      // here too so the two surfaces stay in sync.
      const seed = Array.from({ length: RECENT_MESSAGES_MAX }, (_, i) => `msg-${i}`);
      const afterPush = updateRecentMessagesLru(seed, 'fresh');
      assert.strictEqual(afterPush.length, RECENT_MESSAGES_MAX);
      assert.strictEqual(afterPush[0], 'fresh');
      assert.ok(!afterPush.includes(`msg-${RECENT_MESSAGES_MAX - 1}`));

      const afterDup = updateRecentMessagesLru(['a', 'b', 'c'], 'b');
      assert.deepStrictEqual(afterDup, ['b', 'a', 'c']);
    });

    it('openRecentMessages pre-fills the commit-message textarea with the chosen entry', async () => {
      const mem = new InMemoryMemento();
      await mem.update(RECENT_MESSAGES_STATE_KEY, ['most recent', 'older one']);

      const gitService = makeGitService();
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService, mem);

      // Stub showQuickPick to simulate user picking the second entry.
      const originalPick = vscode.window.showQuickPick;
      (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
        items: unknown
      ): Promise<unknown> => {
        const arr = (await Promise.resolve(items)) as Array<{ message: string }>;
        return arr.find((i) => i.message === 'older one');
      };

      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        await (
          dialog as unknown as {
            _handleOpenRecentMessages: () => Promise<void>;
          }
        )._handleOpenRecentMessages();

        const msg = (dialog as unknown as { _commitMessage: string })._commitMessage;
        assert.strictEqual(msg, 'older one');
      } finally {
        (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalPick;
        dialog.dispose();
      }
    });
  });

  describe('CommitDialog gear menu', () => {
    it('renders two items: the disabled stub and the --no-verify toggle', () => {
      const items = buildGearMenuItems(false);
      assert.strictEqual(items.length, 2);
      assert.strictEqual(items[0].id, 'beforeCommit');
      assert.ok(
        items[0].description && items[0].description.toLowerCase().includes('coming soon'),
        `beforeCommit stub should be marked "Coming soon", got: "${items[0].description}"`
      );
      assert.strictEqual(items[1].id, 'noVerify');
      assert.ok(items[1].label.includes('--no-verify'));
    });

    it('reflects the current --no-verify state in the label and description', () => {
      const off = buildGearMenuItems(false);
      const on = buildGearMenuItems(true);
      assert.ok(off[1].description?.includes('off'));
      assert.ok(on[1].description?.includes('on'));
      assert.ok(!off[1].label.includes('$(check)'));
      assert.ok(on[1].label.includes('$(check)'));
    });

    it('toggling --no-verify persists to workspaceState under the LAST_NO_VERIFY key', async () => {
      const mem = new InMemoryMemento();
      const gitService = makeGitService();
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService, mem);
      try {
        // Stub showQuickPick to select the noVerify entry.
        const originalPick = vscode.window.showQuickPick;
        (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
          items: unknown
        ): Promise<unknown> => {
          const arr = (await Promise.resolve(items)) as Array<{ id: string }>;
          return arr.find((i) => i.id === 'noVerify');
        };
        try {
          // Starts false → toggling turns it on.
          await (
            dialog as unknown as { _handleOpenGearMenu: () => Promise<void> }
          )._handleOpenGearMenu();
          assert.strictEqual(mem.get(LAST_NO_VERIFY_STATE_KEY), true);

          // Toggle again → off.
          await (
            dialog as unknown as { _handleOpenGearMenu: () => Promise<void> }
          )._handleOpenGearMenu();
          assert.strictEqual(mem.get(LAST_NO_VERIFY_STATE_KEY), false);
        } finally {
          (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalPick;
        }
      } finally {
        dialog.dispose();
      }
    });

    it('selecting "Run before-commit checks" shows the "coming soon" info toast and does not change state', async () => {
      const mem = new InMemoryMemento();
      await mem.update(LAST_NO_VERIFY_STATE_KEY, false);
      const gitService = makeGitService();
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService, mem);
      try {
        const infoMessages: string[] = [];
        const originalInfo = vscode.window.showInformationMessage;
        (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
          async (m: string): Promise<string | undefined> => {
            infoMessages.push(m);
            return undefined;
          };
        const originalPick = vscode.window.showQuickPick;
        (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = async (
          items: unknown
        ): Promise<unknown> => {
          const arr = (await Promise.resolve(items)) as Array<{ id: string }>;
          return arr.find((i) => i.id === 'beforeCommit');
        };
        try {
          await (
            dialog as unknown as { _handleOpenGearMenu: () => Promise<void> }
          )._handleOpenGearMenu();

          assert.strictEqual(mem.get(LAST_NO_VERIFY_STATE_KEY), false, 'noVerify unchanged');
          assert.strictEqual(infoMessages.length, 1);
          assert.ok(
            infoMessages[0].toLowerCase().includes('coming') ||
              infoMessages[0].toLowerCase().includes('later'),
            `info toast should signal the stub, got: "${infoMessages[0]}"`
          );
        } finally {
          (vscode.window as unknown as { showInformationMessage: unknown }).showInformationMessage =
            originalInfo;
          (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalPick;
        }
      } finally {
        dialog.dispose();
      }
    });
  });

  describe('CommitDialog — end-to-end _handleCommit with author + noVerify', () => {
    it('valid author + noVerify → both pass through to GitService.commit', async () => {
      const mem = new InMemoryMemento();
      const gitService = makeGitService();
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService, mem);
      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        (dialog as unknown as { _stagedFiles: unknown })._stagedFiles = [
          { path: 'a.ts', status: 'M', staged: true, selected: true },
        ];
        (dialog as unknown as { _commitMessage: string })._commitMessage = 'feat: wire';
        (dialog as unknown as { _author: string })._author = 'Kit <k@e.com>';
        (dialog as unknown as { _noVerify: boolean })._noVerify = true;

        await (
          dialog as unknown as {
            _handleCommit: (m: { type: string; message?: string }) => Promise<void>;
          }
        )._handleCommit({ type: 'commit', message: 'feat: wire' });

        const commitCall = gitService.calls.find((c) => c.method === 'commit');
        assert.ok(commitCall);
        const opts = commitCall.args[2] as ICommitOptions;
        assert.strictEqual(opts.author, 'Kit <k@e.com>');
        assert.strictEqual(opts.noVerify, true);

        const lru = mem.get<string[]>(RECENT_MESSAGES_STATE_KEY, []);
        assert.deepStrictEqual(lru, ['feat: wire']);
      } finally {
        dialog.dispose();
      }
    });

    it('invalid author blocks the commit and surfaces an error', async () => {
      const mem = new InMemoryMemento();
      const gitService = makeGitService();
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService, mem);

      const errs: string[] = [];
      const originalError = vscode.window.showErrorMessage;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = async (
        m: string
      ): Promise<string | undefined> => {
        errs.push(m);
        return undefined;
      };

      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        (dialog as unknown as { _stagedFiles: unknown })._stagedFiles = [
          { path: 'a.ts', status: 'M', staged: true, selected: true },
        ];
        (dialog as unknown as { _commitMessage: string })._commitMessage = 'feat: bad';
        (dialog as unknown as { _author: string })._author = 'not-valid';

        await (
          dialog as unknown as {
            _handleCommit: (m: { type: string; message?: string }) => Promise<void>;
          }
        )._handleCommit({ type: 'commit', message: 'feat: bad' });

        assert.strictEqual(
          gitService.calls.filter((c) => c.method === 'commit').length,
          0,
          'commit must not be invoked on invalid author'
        );
        assert.strictEqual(errs.length, 1);
        assert.ok(errs[0].toLowerCase().includes('invalid author'));
      } finally {
        (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage =
          originalError;
        dialog.dispose();
      }
    });
  });

  // TL-72 (Wave 9) — every CommitDialog action-path catch block must
  // run the raw git stderr through `sanitizeGitError` before pushing
  // it into the showErrorMessage toast. Pre-fix, six call-sites in
  // CommitDialog.ts (commit failure + stage/unstage/stage-hunk/unstage-hunk
  // /stage-lines failures) concatenated `error.message` directly into
  // the toast template, leaking credentialed remote URLs and POSIX
  // home paths into the user's notification history. Each spec drives
  // the corresponding private handler directly through the dialog
  // instance and asserts the sanitised toast surface.
  describe('CommitDialog TL-72 — action-path toasts route through sanitizeGitError', () => {
    const RAW = 'fail: https://alice:secret@example.com/repo.git\n/Users/alice/project';
    const EXPECTED = 'fail: https://<redacted>@example.com/repo.git\n~/project';

    function captureErrorToasts(): { errors: string[]; restore: () => void } {
      const errors: string[] = [];
      const oErr = vscode.window.showErrorMessage;
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = (
        m: string
      ): Promise<string | undefined> => {
        errors.push(m);
        return Promise.resolve(undefined);
      };
      return {
        errors,
        restore: (): void => {
          (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage = oErr;
        },
      };
    }

    function assertSanitized(actual: string, prefix: string): void {
      assert.strictEqual(actual, `${prefix}: ${EXPECTED}`);
      assert.ok(!actual.includes('alice:secret'), 'toast must not leak credentials');
      assert.ok(!actual.includes('/Users/alice'), 'toast must not leak home path');
    }

    it('_handleCommit failure toast sanitizes credentialed URL + home path', async () => {
      const mem = new InMemoryMemento();
      const gitService = makeGitService({
        commitImpl: () => Promise.reject(new Error(RAW)),
      });
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService, mem);
      const { errors, restore } = captureErrorToasts();
      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        (dialog as unknown as { _stagedFiles: unknown })._stagedFiles = [
          { path: 'a.ts', status: 'M', staged: true, selected: true },
        ];
        (dialog as unknown as { _commitMessage: string })._commitMessage = 'feat: x';

        await (
          dialog as unknown as {
            _handleCommit: (m: { type: string; message?: string }) => Promise<void>;
          }
        )._handleCommit({ type: 'commit', message: 'feat: x' });

        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Commit failed');
      } finally {
        restore();
        dialog.dispose();
      }
    });

    it('_handleStageFile failure toast sanitizes credentialed URL + home path', async () => {
      const gitService = makeGitService({
        stageImpl: () => Promise.reject(new Error(RAW)),
      });
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService);
      const { errors, restore } = captureErrorToasts();
      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        await (
          dialog as unknown as { _handleStageFile: (p: string) => Promise<void> }
        )._handleStageFile('a.ts');
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to stage file');
      } finally {
        restore();
        dialog.dispose();
      }
    });

    it('_handleUnstageFile failure toast sanitizes credentialed URL + home path', async () => {
      const gitService = makeGitService({
        unstageImpl: () => Promise.reject(new Error(RAW)),
      });
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService);
      const { errors, restore } = captureErrorToasts();
      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        await (
          dialog as unknown as { _handleUnstageFile: (p: string) => Promise<void> }
        )._handleUnstageFile('a.ts');
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to unstage file');
      } finally {
        restore();
        dialog.dispose();
      }
    });

    it('_handleStageHunk failure toast sanitizes credentialed URL + home path', async () => {
      const gitService = makeGitService();
      (gitService as unknown as { stageHunk: unknown }).stageHunk = (): Promise<never> =>
        Promise.reject(new Error(RAW));
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService);
      const { errors, restore } = captureErrorToasts();
      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        (dialog as unknown as { _selectedFilePath: string })._selectedFilePath = 'a.ts';
        (dialog as unknown as { _currentDiff: unknown })._currentDiff = {
          path: 'a.ts',
          status: 'modified',
          binary: false,
          hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [] }],
        };
        await (
          dialog as unknown as { _handleStageHunk: (i: number) => Promise<void> }
        )._handleStageHunk(0);
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to stage hunk');
      } finally {
        restore();
        dialog.dispose();
      }
    });

    it('_handleUnstageHunk failure toast sanitizes credentialed URL + home path', async () => {
      const gitService = makeGitService();
      (gitService as unknown as { unstageHunk: unknown }).unstageHunk = (): Promise<never> =>
        Promise.reject(new Error(RAW));
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService);
      const { errors, restore } = captureErrorToasts();
      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        (dialog as unknown as { _selectedFilePath: string })._selectedFilePath = 'a.ts';
        (dialog as unknown as { _currentDiff: unknown })._currentDiff = {
          path: 'a.ts',
          status: 'modified',
          binary: false,
          hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [] }],
        };
        await (
          dialog as unknown as { _handleUnstageHunk: (i: number) => Promise<void> }
        )._handleUnstageHunk(0);
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to unstage hunk');
      } finally {
        restore();
        dialog.dispose();
      }
    });

    it('_handleStageSelectedLines failure toast sanitizes credentialed URL + home path', async () => {
      const gitService = makeGitService();
      (gitService as unknown as { stageLines: unknown }).stageLines = (): Promise<never> =>
        Promise.reject(new Error(RAW));
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService);
      const { errors, restore } = captureErrorToasts();
      try {
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        (dialog as unknown as { _selectedFilePath: string })._selectedFilePath = 'a.ts';
        (dialog as unknown as { _currentDiff: unknown })._currentDiff = {
          path: 'a.ts',
          status: 'modified',
          binary: false,
          hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [] }],
        };
        // Seed selected line numbers so the handler doesn't short-circuit.
        const selectedLines = new Map<number, Set<number>>();
        selectedLines.set(0, new Set([1, 2]));
        (dialog as unknown as { _selectedLines: Map<number, Set<number>> })._selectedLines =
          selectedLines;

        await (
          dialog as unknown as { _handleStageSelectedLines: (i: number) => Promise<void> }
        )._handleStageSelectedLines(0);
        assert.strictEqual(errors.length, 1, 'expected one error toast');
        assertSanitized(errors[0], 'Failed to stage lines');
      } finally {
        restore();
        dialog.dispose();
      }
    });
  });

  describe('CommitDialog constructor — workspaceState seeding', () => {
    it('restores the --no-verify toggle from workspaceState on construction', () => {
      const mem = new InMemoryMemento();
      void mem.update(LAST_NO_VERIFY_STATE_KEY, true);
      const dialog = new CommitDialog(Uri.file('/tmp/ext'), makeGitService(), mem);
      try {
        assert.strictEqual((dialog as unknown as { _noVerify: boolean })._noVerify, true);
      } finally {
        dialog.dispose();
      }
    });

    it('defaults --no-verify to false when no state is wired', () => {
      const dialog = new CommitDialog(Uri.file('/tmp/ext'), makeGitService());
      try {
        assert.strictEqual((dialog as unknown as { _noVerify: boolean })._noVerify, false);
      } finally {
        dialog.dispose();
      }
    });
  });
});
