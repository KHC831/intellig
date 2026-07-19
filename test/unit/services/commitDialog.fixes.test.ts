/**
 * Unit tests for CommitDialog polish:
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

import '../../setup';
import { okAsync, errAsync, ResultAsync } from 'neverthrow';
import { SpawnFailedError } from '../../../src/git-core/errors';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  performCommit,
  isValidAuthorFormat,
  AUTHOR_FORMAT_REGEX,
  buildGearMenuItems,
  LAST_NO_VERIFY_STATE_KEY,
  LAST_NO_VERIFY_SLOT,
  CommitDialog,
  createCommitDialog,
} from '../../../src/commits/CommitDialog';
import { savePersisted } from '../../../src/utils/persistedState';
import {
  RECENT_MESSAGES_STATE_KEY,
  RECENT_MESSAGES_MAX,
  updateRecentMessagesLru,
} from '../../../src/commits/CommitToolWindow';
import type {
  IGitService,
  IRepository,
  ICommitOptions,
  ICommit,
} from '../../../src/git-core/interfaces/IGitService';
import { EventEmitter, Uri } from '../../mocks/vscode';
import { bootWebviewEntry } from '../../helpers/bootWebviewEntry';
import { initIslandHtml } from '../../../src/utils/webviewInit';

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
    commit: (repo: IRepository, message: string, options: ICommitOptions) => {
      calls.push({ method: 'commit', args: [repo, message, options] });
      return ResultAsync.fromPromise(
        overrides?.commitImpl ? overrides.commitImpl(repo, message, options) : Promise.resolve(),
        (e) => new SpawnFailedError(e instanceof Error ? e.message : String(e))
      );
    },
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
    onDidFetch: () => ({ dispose: () => {} }),
    resetToCommit: () => okAsync(undefined),
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
    stage: (repo: IRepository, paths: string[]) => {
      calls.push({ method: 'stage', args: [repo, paths] });
      return ResultAsync.fromPromise(
        overrides?.stageImpl ? overrides.stageImpl(repo, paths) : Promise.resolve(),
        (e) => new SpawnFailedError(e instanceof Error ? e.message : String(e))
      );
    },
    unstage: (repo: IRepository, paths: string[]) => {
      calls.push({ method: 'unstage', args: [repo, paths] });
      return ResultAsync.fromPromise(
        overrides?.unstageImpl ? overrides.unstageImpl(repo, paths) : Promise.resolve(),
        (e) => new SpawnFailedError(e instanceof Error ? e.message : String(e))
      );
    },
    stageHunk: () => okAsync(undefined),
    stageLines: () => okAsync(undefined),
    unstageHunk: () => okAsync(undefined),
    revertFile: () => okAsync(undefined),
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

describe('CommitDialog — recent messages + author + gear', () => {
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
      // Control chars in the name can smuggle a second header line — reject.
      'Bad\nName <a@b.co>',
      'Bad\rName <a@b.co>',
      'Bad\tName <a@b.co>',
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
    it('allows a message-only amend with NO files selected', async () => {
      // git4idea's amend checkbox works with an empty change selection
      // (fix just the last commit's message). performCommit rejected an empty
      // selection before consulting the amend flag, dead-ending the flow.
      const gitService = makeGitService();
      const repo = makeRepo();
      const result = await performCommit(gitService, repo, {
        message: 'reword: fix subject',
        selectedFiles: [],
        allFiles: [{ path: 'a.ts', staged: false }],
        amend: true,
      });
      assert.strictEqual(result.success, true, JSON.stringify(result));
      const commitCall = gitService.calls.find((c) => c.method === 'commit');
      assert.ok(commitCall, 'commit --amend must still run');
      assert.strictEqual((commitCall.args[2] as ICommitOptions).amend, true);
      assert.ok(!gitService.calls.some((c) => c.method === 'stage' || c.method === 'unstage'));
    });

    it('still rejects an empty selection when NOT amending', async () => {
      const gitService = makeGitService();
      const result = await performCommit(gitService, makeRepo(), {
        message: 'feat: thing',
        selectedFiles: [],
        allFiles: [{ path: 'a.ts', staged: false }],
      });
      assert.strictEqual(result.success, false);
      assert.match(result.error ?? '', /No files selected/);
    });

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
      // CommitToolWindow calls performCommit with only the original
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

  describe('performCommit — staging restore on failure (K3)', () => {
    it('restores the pre-dialog staging split when the commit itself fails', async () => {
      // The dialog stages a.ts (selected, unstaged) and unstages b.ts (staged,
      // unselected) before committing. When the commit is rejected (hook), the
      // user's pre-dialog index split must come back — not stay silently
      // replaced by the dialog's selection.
      const svc = makeGitService({
        commitImpl: async () => {
          throw new Error('pre-commit hook rejected');
        },
      });
      const repo = makeRepo();
      const result = await performCommit(svc, repo, {
        message: 'x',
        selectedFiles: ['a.ts'],
        allFiles: [
          { path: 'a.ts', staged: false },
          { path: 'b.ts', staged: true },
        ],
      });
      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(
        svc.calls.map((c) => c.method),
        ['stage', 'unstage', 'commit', 'unstage', 'stage'],
        'the applied deltas are reversed after the failed commit'
      );
      assert.deepStrictEqual(svc.calls[3].args[1], ['a.ts'], 'the staged delta is unstaged back');
      assert.deepStrictEqual(svc.calls[4].args[1], ['b.ts'], 'the unstaged delta is re-staged');
    });

    it('reverses only the delta that was actually applied when unstaging fails mid-way', async () => {
      const svc = makeGitService({
        unstageImpl: async (_repo, paths) => {
          if (paths.includes('b.ts')) {
            // Fail the DELTA unstage; the restore unstage (a.ts) succeeds.
            throw new Error('index.lock held');
          }
        },
      });
      const repo = makeRepo();
      const result = await performCommit(svc, repo, {
        message: 'x',
        selectedFiles: ['a.ts'],
        allFiles: [
          { path: 'a.ts', staged: false },
          { path: 'b.ts', staged: true },
        ],
      });
      assert.strictEqual(result.success, false);
      assert.deepStrictEqual(
        svc.calls.map((c) => c.method),
        ['stage', 'unstage', 'unstage'],
        'no commit runs; only the stage that succeeded is reversed'
      );
      assert.deepStrictEqual(svc.calls[2].args[1], ['a.ts']);
    });

    it('re-stages excluded staged files after a successful commit (bystander split preserved)', async () => {
      // b.ts was staged before the dialog opened and merely excluded from
      // this commit — afterwards it must STILL be staged (reference:
      // GitResetAddStagingAreaStateManager.restoreExcluded re-stages the
      // excluded staged changes after the commit).
      const svc = makeGitService();
      const repo = makeRepo();
      const result = await performCommit(svc, repo, {
        message: 'x',
        selectedFiles: ['a.ts'],
        allFiles: [
          { path: 'a.ts', staged: false },
          { path: 'b.ts', staged: true },
        ],
      });
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(
        svc.calls.map((c) => c.method),
        ['stage', 'unstage', 'commit', 'stage'],
        'the excluded staged delta is re-staged after the successful commit'
      );
      assert.deepStrictEqual(svc.calls[3].args[1], ['b.ts'], 'only the excluded file is re-staged');
    });

    it('runs no restore when nothing was excluded (all selected files committed)', async () => {
      const svc = makeGitService();
      const repo = makeRepo();
      const result = await performCommit(svc, repo, {
        message: 'x',
        selectedFiles: ['a.ts'],
        allFiles: [{ path: 'a.ts', staged: false }],
      });
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(
        svc.calls.map((c) => c.method),
        ['stage', 'commit'],
        'no re-stage call when no staged file was excluded'
      );
    });

    it('surfaces a warning when the post-success re-stage fails', async () => {
      let commitDone = false;
      const svc = makeGitService({
        commitImpl: async () => {
          commitDone = true;
        },
        stageImpl: async (_repo, paths) => {
          if (commitDone && paths.includes('b.ts')) {
            throw new Error('index.lock held');
          }
        },
      });
      const repo = makeRepo();
      const result = await performCommit(svc, repo, {
        message: 'x',
        selectedFiles: ['a.ts'],
        allFiles: [
          { path: 'a.ts', staged: false },
          { path: 'b.ts', staged: true },
        ],
      });
      assert.strictEqual(result.success, true, 'the commit itself still succeeded');
      assert.ok(
        result.restoreWarning && /staged/i.test(result.restoreWarning),
        'a failed re-stage must be reported, not swallowed'
      );
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

        const lru = mem.get(RECENT_MESSAGES_STATE_KEY);
        assert.deepStrictEqual(lru, { v: 1, data: ['feat: hello'] });
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
    it('renders two items: the before-commit-checks entry and the --no-verify toggle', () => {
      const items = buildGearMenuItems(false);
      assert.strictEqual(items.length, 2);
      assert.strictEqual(items[0].id, 'beforeCommit');
      // The entry is now functional (no longer a "coming soon" stub) — its
      // description advertises the cheap checks it previews.
      assert.ok(
        items[0].description && !items[0].description.toLowerCase().includes('coming soon'),
        `beforeCommit entry should no longer be a "Coming soon" stub, got: "${items[0].description}"`
      );
      assert.ok(
        items[0].label.toLowerCase().includes('before-commit'),
        `beforeCommit label should mention before-commit checks, got: "${items[0].label}"`
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
          assert.deepStrictEqual(mem.get(LAST_NO_VERIFY_STATE_KEY), { v: 1, data: true });

          // Toggle again → off.
          await (
            dialog as unknown as { _handleOpenGearMenu: () => Promise<void> }
          )._handleOpenGearMenu();
          assert.deepStrictEqual(mem.get(LAST_NO_VERIFY_STATE_KEY), { v: 1, data: false });
        } finally {
          (vscode.window as unknown as { showQuickPick: unknown }).showQuickPick = originalPick;
        }
      } finally {
        dialog.dispose();
      }
    });

    it('selecting "Run before-commit checks" runs the preview and does not change the --no-verify state', async () => {
      const mem = new InMemoryMemento();
      await mem.update(LAST_NO_VERIFY_STATE_KEY, false);
      const gitService = makeGitService();
      const dialog = createCommitDialog(Uri.file('/tmp/ext'), gitService, mem);
      try {
        // Prime a repo + a clean (no-conflict) selected file so the preview
        // can gather context. The gitService stub exposes no `gitCli`, so
        // the identity check is treated as unresolved (not a false positive)
        // and the preview reports "checks passed".
        (dialog as unknown as { _repository: IRepository })._repository = makeRepo();
        (dialog as unknown as { _stagedFiles: unknown })._stagedFiles = [
          { path: 'a.ts', status: 'M', staged: true, selected: true },
        ];

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
            infoMessages[0].toLowerCase().includes('passed'),
            `preview should report checks passed for a clean selection, got: "${infoMessages[0]}"`
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

        const lru = mem.get(RECENT_MESSAGES_STATE_KEY);
        assert.deepStrictEqual(lru, { v: 1, data: ['feat: wire'] });
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

  // Every CommitDialog action-path catch block must run the raw git stderr
  // through `sanitizeGitError` before pushing it into the showErrorMessage
  // toast. Six call-sites in CommitDialog.ts (commit failure +
  // stage/unstage/stage-hunk/unstage-hunk/stage-lines failures) surface git
  // stderr that can carry credentialed remote URLs and POSIX home paths, so
  // each must be sanitised to keep them out of the user's notification
  // history. Each spec drives the corresponding private handler directly
  // through the dialog instance and asserts the sanitised toast surface.
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
      (gitService as unknown as { stageHunk: unknown }).stageHunk = () =>
        errAsync(new SpawnFailedError(RAW));
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
      (gitService as unknown as { unstageHunk: unknown }).unstageHunk = () =>
        errAsync(new SpawnFailedError(RAW));
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
      (gitService as unknown as { stageLines: unknown }).stageLines = () =>
        errAsync(new SpawnFailedError(RAW));
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
        const selectedLines = new Map<
          number,
          { addLines: Set<number>; deleteLines: Set<number> }
        >();
        selectedLines.set(0, { addLines: new Set([1, 2]), deleteLines: new Set() });
        (
          dialog as unknown as {
            _selectedLines: Map<number, { addLines: Set<number>; deleteLines: Set<number> }>;
          }
        )._selectedLines = selectedLines;

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

  describe('CSP-safe event wiring (no inline handlers)', () => {
    // Host HTML: body + init island + external nonced bundle tag (no inline
    // script). asWebviewUri is stubbed identity so the bundle src resolves.
    function renderHtml(dialog: CommitDialog): string {
      const webviewStub = {
        cspSource: 'vscode-resource:',
        asWebviewUri: (u: vscode.Uri) => u,
      } as unknown as vscode.Webview;
      return (dialog as unknown as { _getHtmlContent(w: vscode.Webview): string })._getHtmlContent(
        webviewStub
      );
    }

    // The interactive wiring lives in the bundled entry now, not the host string.
    function entrySource(): string {
      return fs.readFileSync(
        path.join(__dirname, '../../../src/commits/webview/commitDialog.ts'),
        'utf-8'
      );
    }

    it('emits NO inline on*= handlers (they are dead under the nonce-only CSP)', () => {
      const dialog = new CommitDialog(Uri.file('/tmp/ext'), makeGitService());
      try {
        const html = renderHtml(dialog);
        const inlineHandler = html.match(/\son(click|input|change|submit|keydown|keyup)\s*=/i);
        assert.strictEqual(
          inlineHandler,
          null,
          `inline event handlers are blocked by the nonce-only CSP; found: ${inlineHandler?.[0]}`
        );
      } finally {
        dialog.dispose();
      }
    });

    it('wires the Commit/Cancel buttons + gear/recent/refresh via data-action delegation', () => {
      const dialog = new CommitDialog(Uri.file('/tmp/ext'), makeGitService());
      const init = (dialog as unknown as { _getInit(): unknown })._getInit();
      dialog.dispose();
      // Boot the bundled entry against the init island and assert the
      // [data-action] elements exist on the built DOM.
      const h = bootWebviewEntry('commits/webview/commitDialog', {
        bodyHtml: '<div class="commit-dialog" id="root"></div>' + initIslandHtml(init),
      });
      try {
        for (const action of [
          'commit',
          'cancel',
          'openGearMenu',
          'openRecentMessages',
          'refresh',
        ]) {
          assert.ok(
            h.document.querySelector(`[data-action="${action}"]`),
            `${action} must be wired via data-action delegation`
          );
        }
      } finally {
        h.dispose();
      }
    });

    it('wires the message/author inputs + amend/sign-off checkboxes via addEventListener', () => {
      const source = entrySource();
      assert.ok(
        /getElementById\('commit-message'\)[\s\S]*addEventListener\('input'/.test(source),
        'commit-message must wire input via addEventListener'
      );
      assert.ok(
        /getElementById\('commit-author'\)[\s\S]*addEventListener\('input'/.test(source),
        'commit-author must wire input via addEventListener'
      );
      assert.ok(
        /getElementById\('amend-checkbox'\)[\s\S]*addEventListener\('change'/.test(source),
        'amend-checkbox must wire change via addEventListener'
      );
      assert.ok(
        /getElementById\('signoff-checkbox'\)[\s\S]*addEventListener\('change'/.test(source),
        'signoff-checkbox must wire change via addEventListener'
      );
    });
  });
});

describe('CommitDialog — amend toggle (shared amendMessage helper)', () => {
  interface DialogAmendSurface {
    _repository?: IRepository;
    _commitMessage: string;
    _handleAmendToggle(amend: boolean): Promise<void>;
  }

  function makeDialog(headMessage: string): { dialog: CommitDialog; s: DialogAmendSurface } {
    const git = makeGitService();
    (git as { getLog: unknown }).getLog = async (): Promise<ICommit[]> => [
      { message: headMessage, body: '' } as ICommit,
    ];
    const dialog = new CommitDialog(Uri.file('/ext'), git);
    const s = dialog as unknown as DialogAmendSurface;
    s._repository = makeRepo();
    return { dialog, s };
  }

  it("replaces a non-empty draft with HEAD's message and restores it on toggle-off", async () => {
    const { dialog, s } = makeDialog('HEAD subject');
    s._commitMessage = 'my draft';
    await s._handleAmendToggle(true);
    assert.strictEqual(s._commitMessage, 'HEAD subject');
    await s._handleAmendToggle(false);
    assert.strictEqual(s._commitMessage, 'my draft');
    dialog.dispose();
  });

  it('keeps a user-edited amend message on toggle-off', async () => {
    const { dialog, s } = makeDialog('HEAD subject');
    s._commitMessage = 'my draft';
    await s._handleAmendToggle(true);
    s._commitMessage = 'edited amend';
    await s._handleAmendToggle(false);
    assert.strictEqual(s._commitMessage, 'edited amend');
    dialog.dispose();
  });
});

/**
 * The dialog is a cached singleton and the Commit Tool Window's gear writes
 * the SAME workspace-state slot. A value read once in the constructor goes
 * stale the moment the other surface toggles it — the dialog would then run
 * hooks the user turned off, and render its own gear in the wrong state.
 */
describe('CommitDialog re-reads the shared no-verify flag', () => {
  function makeMemento(): vscode.Memento {
    const store = new Map<string, unknown>();
    return {
      get: <T>(key: string, fallback?: T): T | undefined =>
        (store.has(key) ? store.get(key) : fallback) as T | undefined,
      update: (key: string, value: unknown): Thenable<void> => {
        store.set(key, value);
        return Promise.resolve();
      },
      keys: () => Array.from(store.keys()),
    } as unknown as vscode.Memento;
  }

  it('picks up a slot write made after construction', async () => {
    const memento = makeMemento();
    const dialog = new CommitDialog(Uri.file('/tmp/ext'), {} as IGitService, memento);
    const internals = dialog as unknown as { _noVerify: boolean };
    assert.strictEqual(internals._noVerify, false, 'sanity: starts off');

    // The Commit Tool Window's gear flips the shared slot.
    await savePersisted(memento, LAST_NO_VERIFY_SLOT, true);
    // Re-opening the cached dialog must observe it.
    dialog.refreshNoVerifyFromState();

    assert.strictEqual(internals._noVerify, true, 'the dialog honors the newer value');
    dialog.dispose();
  });
});
