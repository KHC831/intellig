/**
 * H3 — cherry-pick and revert with -m mainline for merge commits + revert
 * message editing.
 *
 * When the user selects a merge commit (parents.length > 1) for cherry-pick or
 * revert, CommitContextMenuCommands detects the merge via gitService.getCommit
 * and prompts for which parent line is the mainline, passing the chosen
 * `mainline: <n>` to the operation so git does not error out. Parent 1 is the
 * pre-selected default.
 *
 * For single non-merge reverts, an InputBox pre-filled with the default
 * "Revert \"<subject>\"" message lets the user customise the revert commit
 * message before gitService.revert is called.
 */

import '../../setup';
import { okAsync } from 'neverthrow';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { CommitContextMenuCommands } from '../../../src/commits/CommitContextMenuCommands';
import {
  IGitService,
  IRepository,
  ICherryPickOptions,
  IRevertOptions,
} from '../../../src/git-core/interfaces/IGitService';
import { IRebaseService } from '../../../src/git-core/interfaces/IRebaseService';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { EventEmitter, Uri } from '../../mocks/vscode';
import { writableWindow } from '../../typed/windowStub';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

interface RevertCall {
  hashes: string[];
  options?: IRevertOptions;
}

interface CherryPickCall {
  hashes: string[];
  options?: ICherryPickOptions;
}

function makeGitService(
  repo: IRepository,
  opts: {
    parentsByHash?: Record<string, string[]>;
    subjectByHash?: Record<string, string>;
    cherryPickResult?: { success: boolean };
    revertResult?: { success: boolean };
  } = {}
): IGitService & { revertCalls: RevertCall[]; cherryPickCalls: CherryPickCall[] } {
  const revertCalls: RevertCall[] = [];
  const cherryPickCalls: CherryPickCall[] = [];
  const emitter = new EventEmitter<IRepository>();
  return {
    revertCalls,
    cherryPickCalls,
    onDidChangeRepository: emitter.event,
    getRepositories: () => [repo],
    getRepository: async () => repo,
    reloadRepository: async () => repo,
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
    getCommit: async (_r: IRepository, hash: string) => {
      const parents = opts.parentsByHash?.[hash] ?? ['parent1'];
      const subject = opts.subjectByHash?.[hash] ?? 'feat: example commit';
      return {
        hash,
        shortHash: hash.substring(0, 8),
        message: subject,
        author: { name: '', email: '' },
        committer: { name: '', email: '' },
        parents,
        authorDate: new Date(),
        commitDate: new Date(),
      };
    },
    getFileHistory: async () => [],
    getDiff: async () => ({ path: '', status: 'modified' as const, hunks: [], binary: false }),
    getCommitDiff: async () => [],
    getMultiCommitDiff: async () => [],
    getBlame: async () => [],
    cherryPick: async (_r: IRepository, hashes: string[], pickOpts?: ICherryPickOptions) => {
      cherryPickCalls.push({ hashes, options: pickOpts });
      return opts.cherryPickResult ?? { success: true };
    },
    cherryPickAbort: async () => {},
    cherryPickContinue: async () => ({ success: true }),
    revert: async (_r: IRepository, hashes: string[], revertOpts?: IRevertOptions) => {
      revertCalls.push({ hashes, options: revertOpts });
      return opts.revertResult ?? { success: true };
    },
    revertAbort: async () => {},
    revertContinue: async () => ({ success: true }),
    getStatus: async () => [],
    stage: () => okAsync(undefined),
    unstage: () => okAsync(undefined),
    stageHunk: () => okAsync(undefined),
    stageLines: () => okAsync(undefined),
    unstageHunk: () => okAsync(undefined),
    revertFile: () => okAsync(undefined),
    revertHunk: () => okAsync(undefined),
    dispose: () => {},
  } as unknown as IGitService & { revertCalls: RevertCall[]; cherryPickCalls: CherryPickCall[] };
}

function makeRebase(): IRebaseService {
  const emitter = new EventEmitter<undefined>();
  return {
    startInteractiveRebase: async () => ({
      onto: '',
      originalBranch: '',
      commits: [],
      currentStep: 0,
      status: 'planning',
    }),
    getRebaseSession: () => undefined,
    updateRebasePlan: () => {},
    executeRebase: async () => ({ success: true, status: 'completed' as const }),
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async () => {},
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    provideSquashMessage: async () => ({ success: true, status: 'completed' as const }),
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: emitter.event,
    dispose: () => {},
  } as unknown as IRebaseService;
}

function makeProvider(): GitToolWindowProvider {
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refresh: () => {},
  } as unknown as GitToolWindowProvider;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CommitContextMenuCommands — merge commit detection (H3)', () => {
  // Valid hex hashes — the dispatch boundary validates commit hashes as hex
  // (HASH_RE), matching real git output.
  const MERGE_HASH = 'ee11ee11ee11ee11';
  const REGULAR_HASH = 'cc22cc22cc22cc22';

  afterEach(() => {
    // Restore showInputBox to accept-default after each test.
    writableWindow().showInputBox = async (opts?: import('vscode').InputBoxOptions) =>
      Promise.resolve(opts?.value);
    writableWindow().showInformationMessage = async () => undefined;
    writableWindow().showErrorMessage = async () => undefined;
    writableWindow().showQuickPick = async () => undefined;
  });

  // Stub the mainline-parent QuickPick to choose Parent 1 (the default).
  function pickMainlineParent1(): void {
    writableWindow().showQuickPick = async (items: unknown[]) => {
      const arr = (await Promise.resolve(items)) as { mainline: number }[];
      return arr.find((i) => i.mainline === 1);
    };
  }

  describe('cherry-pick', () => {
    it('prompts and passes the chosen mainline parent for a merge commit', async () => {
      const repo = makeRepo();
      const gitService = makeGitService(repo, {
        parentsByHash: { [MERGE_HASH]: ['p1', 'p2'] },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());
      writableWindow().showInformationMessage = async () => undefined;
      pickMainlineParent1();

      await commands._handleAction('cherryPick', [MERGE_HASH]);

      assert.strictEqual(gitService.cherryPickCalls.length, 1);
      assert.strictEqual(gitService.cherryPickCalls[0].options?.mainline, 1);
    });

    it('does not pass mainline when the commit is not a merge', async () => {
      const repo = makeRepo();
      const gitService = makeGitService(repo, {
        parentsByHash: { [REGULAR_HASH]: ['parent1'] },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());
      writableWindow().showInformationMessage = async () => undefined;

      await commands._handleAction('cherryPick', [REGULAR_HASH]);

      assert.strictEqual(gitService.cherryPickCalls.length, 1);
      assert.ok(
        !gitService.cherryPickCalls[0].options?.mainline,
        'should not set mainline for non-merge'
      );
    });

    it('passes mainline: 1 when ANY commit in a multi-commit pick is a merge', async () => {
      const repo = makeRepo();
      const gitService = makeGitService(repo, {
        parentsByHash: {
          [MERGE_HASH]: ['p1', 'p2'],
          [REGULAR_HASH]: ['p1'],
        },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());
      writableWindow().showInformationMessage = async () => undefined;

      await commands._handleAction('cherryPick', [REGULAR_HASH, MERGE_HASH]);

      assert.strictEqual(gitService.cherryPickCalls.length, 1);
      assert.strictEqual(gitService.cherryPickCalls[0].options?.mainline, 1);
    });
  });

  describe('revert', () => {
    it('prompts and passes the chosen mainline parent for a merge commit', async () => {
      const repo = makeRepo();
      const gitService = makeGitService(repo, {
        parentsByHash: { [MERGE_HASH]: ['p1', 'p2'] },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());
      writableWindow().showInformationMessage = async () => undefined;
      pickMainlineParent1();

      await commands._handleAction('revert', [MERGE_HASH]);

      assert.strictEqual(gitService.revertCalls.length, 1);
      assert.strictEqual(gitService.revertCalls[0].options?.mainline, 1);
    });

    it('does not pass mainline when the commit is not a merge', async () => {
      const repo = makeRepo();
      const gitService = makeGitService(repo, {
        parentsByHash: { [REGULAR_HASH]: ['parent1'] },
        subjectByHash: { [REGULAR_HASH]: 'feat: regular' },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());
      // Accept default message from InputBox.
      writableWindow().showInputBox = async () => 'Revert "feat: regular"';
      writableWindow().showInformationMessage = async () => undefined;

      await commands._handleAction('revert', [REGULAR_HASH]);

      assert.strictEqual(gitService.revertCalls.length, 1);
      assert.ok(
        !gitService.revertCalls[0].options?.mainline,
        'should not set mainline for non-merge'
      );
    });

    it('shows InputBox pre-filled with Revert "<subject>" for single non-merge commit', async () => {
      const repo = makeRepo();
      const SUBJECT = 'feat: my feature';
      const gitService = makeGitService(repo, {
        parentsByHash: { [REGULAR_HASH]: ['parent1'] },
        subjectByHash: { [REGULAR_HASH]: SUBJECT },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());

      let capturedInputOpts: vscode.InputBoxOptions | undefined;
      writableWindow().showInputBox = async (opts?: vscode.InputBoxOptions) => {
        capturedInputOpts = opts;
        return opts?.value; // return the pre-filled value unchanged
      };
      writableWindow().showInformationMessage = async () => undefined;

      await commands._handleAction('revert', [REGULAR_HASH]);

      assert.ok(capturedInputOpts, 'InputBox should have been shown');
      assert.strictEqual(capturedInputOpts.value, `Revert "${SUBJECT}"`);
      assert.strictEqual(gitService.revertCalls.length, 1);
      assert.strictEqual(gitService.revertCalls[0].options?.message, `Revert "${SUBJECT}"`);
    });

    it('cancels revert when InputBox is dismissed', async () => {
      const repo = makeRepo();
      const gitService = makeGitService(repo, {
        parentsByHash: { [REGULAR_HASH]: ['parent1'] },
        subjectByHash: { [REGULAR_HASH]: 'feat: something' },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());
      writableWindow().showInputBox = async () => undefined; // user pressed Esc

      await commands._handleAction('revert', [REGULAR_HASH]);

      assert.strictEqual(gitService.revertCalls.length, 0, 'revert should not be called');
    });

    it('passes user-edited message to revert', async () => {
      const repo = makeRepo();
      const gitService = makeGitService(repo, {
        parentsByHash: { [REGULAR_HASH]: ['parent1'] },
        subjectByHash: { [REGULAR_HASH]: 'feat: something' },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());
      const CUSTOM_MSG = 'My custom revert message';
      writableWindow().showInputBox = async () => CUSTOM_MSG;
      writableWindow().showInformationMessage = async () => undefined;

      await commands._handleAction('revert', [REGULAR_HASH]);

      assert.strictEqual(gitService.revertCalls.length, 1);
      assert.strictEqual(gitService.revertCalls[0].options?.message, CUSTOM_MSG);
    });

    it('skips InputBox for multi-commit revert', async () => {
      const repo = makeRepo();
      const HASH_A = 'aaaaaaaaaaaaaaaa';
      const HASH_B = 'bbbbbbbbbbbbbbbb';
      const gitService = makeGitService(repo, {
        parentsByHash: {
          [HASH_A]: ['parent1'],
          [HASH_B]: ['parent1'],
        },
      });
      const commands = new CommitContextMenuCommands(gitService, makeRebase(), makeProvider());
      let inputBoxCalled = false;
      writableWindow().showInputBox = async () => {
        inputBoxCalled = true;
        return undefined;
      };
      writableWindow().showInformationMessage = async () => undefined;

      await commands._handleAction('revert', [HASH_A, HASH_B]);

      assert.ok(!inputBoxCalled, 'InputBox should not appear for multi-commit revert');
      assert.strictEqual(gitService.revertCalls.length, 1);
    });
  });
});
