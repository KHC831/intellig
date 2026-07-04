/**
 * Perform-time HEAD-containment guard for the history-rewriting commit actions.
 *
 * Regression for the "squash/drop/edit/interactive-rebase on another branch's
 * commits silently moves the CHECKED-OUT branch" bug: each handler rebases
 * `oldest^..HEAD`, so a target that isn't reachable from HEAD transplants /
 * fast-forwards the current branch instead of touching the target's branch.
 * Mirrors IntelliJ GitCommitEditingActionBase.checkCommitsCanBeEdited
 * (git4idea backend/src/rebase/log/GitCommitEditingActionBase.kt): refuse when
 * HEAD does not contain the commit.
 *
 * The guard runs BEFORE any stash / rebase, so a blocked action must leave the
 * rebase service untouched (no `startInteractiveRebase`, no editor opened) and
 * surface the "not in the current branch" toast.
 */

import '../../setup';
import * as assert from 'assert';
import { CommitContextMenuCommands } from '../../../src/commits/CommitContextMenuCommands';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import type {
  IRebaseService,
  IRebaseSession,
  IRebaseAction,
  IRebaseResult,
} from '../../../src/git-core/interfaces/IRebaseService';
import type { IMenuStateNode } from '../../../src/git-core/gitToolWindow/multiSelect';
import { Uri, EventEmitter } from '../../mocks/vscode';
import type { GitCli } from '../../../src/git-core/gitCli';
import { writableWindow } from '../../typed/windowStub';
import { okAsync } from 'neverthrow';

// Branch A (checked out, HEAD = A_HEAD): A_HEAD → BASE
// Branch B (other):                      B_NEW → B_OLD → BASE
const A_HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B_NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const B_OLD = 'cccccccccccccccccccccccccccccccccccccccc';
const BASE = 'dddddddddddddddddddddddddddddddddddddddd';

const B_NODES: readonly IMenuStateNode[] = [
  { hash: B_NEW, parentCount: 1, parents: [B_OLD] },
  { hash: B_OLD, parentCount: 1, parents: [BASE] },
];

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: { HEAD: { name: 'branchA', commit: A_HEAD, type: 0 as const } },
    head: { name: 'branchA', commit: A_HEAD },
    inputBox: { value: '' },
    remotes: [],
  } as unknown as IRepository;
}

/**
 * `getMergeBase(oldest, HEAD)` returns the oldest hash only when it is
 * contained in HEAD's history (an ancestor). Branch-B commits merge-base with
 * HEAD at BASE, so the guard reads them as "not in the current branch".
 */
function mergeBaseFor(oldest: string): string {
  return oldest === A_HEAD ? A_HEAD : BASE;
}

interface RebaseTracker {
  startedOnto: string | undefined;
  executeCalls: number;
}

function createMockRebaseService(tracker: RebaseTracker): IRebaseService {
  const emitter = new EventEmitter<undefined>();
  return {
    startInteractiveRebase: async (_repo: IRepository, onto: string) => {
      tracker.startedOnto = onto;
      const session: IRebaseSession = {
        onto,
        originalBranch: 'branchA',
        commits: B_NODES.map((n) => ({ hash: n.hash, message: 'm', action: 'pick' as const })),
        currentStep: 0,
        status: 'planning',
      };
      return session;
    },
    getRebaseSession: () => undefined,
    updateRebasePlan: (_repo: IRepository, _plan: IRebaseAction[]) => {},
    executeRebase: async (): Promise<IRebaseResult> => {
      tracker.executeCalls++;
      return { success: true, status: 'completed' };
    },
    continueRebase: async () => ({ success: true, status: 'completed' as const }),
    abortRebase: async () => {},
    skipCommit: async () => ({ success: true, status: 'completed' as const }),
    provideRewordMessage: async () => ({ success: true, status: 'completed' as const }),
    amendEditCommit: async () => ({ success: true, status: 'completed' as const }),
    onDidChangeRebaseSession: emitter.event,
    dispose: () => {},
  } as unknown as IRebaseService;
}

function createMockGitService(repo: IRepository): IGitService {
  return {
    getRepositories: () => [repo],
    getActiveRepository: () => repo,
    getRepository: async () => repo,
    getCommit: async (_repo: IRepository, hash: string) => ({
      hash,
      shortHash: hash.substring(0, 7),
      message: `subject ${hash.substring(0, 8)}`,
      author: { name: 'a', email: 'a@x' },
      committer: { name: 'a', email: 'a@x' },
      parents: [],
      authorDate: new Date(0),
      commitDate: new Date(0),
    }),
    getMergeBase: async (_repo: IRepository, refA: string, _refB: string) => mergeBaseFor(refA),
    reloadRepository: async () => {},
    dispose: () => {},
  } as unknown as IGitService;
}

function createMockProvider(): GitToolWindowProvider {
  return {
    onDidRequestLogContextAction: () => ({ dispose: () => {} }),
    refresh: () => {},
  } as unknown as GitToolWindowProvider;
}

function createMockGitCli(): GitCli {
  return {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '' }),
    execString: async () => '',
    isAvailable: async () => true,
    getVersion: () => okAsync('2.40.0'),
    isRepository: () => okAsync(true),
    getRepositoryRoot: () => okAsync('/test-repo'),
    dispose: () => {},
    get gitPath() {
      return 'git';
    },
    set gitPath(_v: string) {},
    onCommandExecuted: () => ({ dispose: () => {} }),
  } as unknown as GitCli;
}

interface Messages {
  error: string[];
  info: string[];
  warning: string[];
}

function captureMessages(): Messages {
  const m: Messages = { error: [], info: [], warning: [] };
  const w = writableWindow();
  w.showErrorMessage = ((msg: string) => {
    m.error.push(msg);
    return Promise.resolve(undefined);
  }) as unknown as typeof w.showErrorMessage;
  w.showInformationMessage = ((msg: string) => {
    m.info.push(msg);
    return Promise.resolve(undefined);
  }) as unknown as typeof w.showInformationMessage;
  // Auto-accept every destructive-op confirm so a NON-blocked op would proceed
  // to the rebase — this is what makes the block assertions meaningful.
  w.showWarningMessage = ((msg: string, ..._items: unknown[]) => {
    m.warning.push(msg);
    return Promise.resolve('Drop');
  }) as unknown as typeof w.showWarningMessage;
  return m;
}

function restoreMessages(): void {
  const w = writableWindow();
  w.showErrorMessage = () => Promise.resolve(undefined);
  w.showInformationMessage = () => Promise.resolve(undefined);
  w.showWarningMessage = () => Promise.resolve(undefined);
}

interface Internal {
  _handleAction(
    action: string,
    hashes: string[],
    commitNodes?: readonly IMenuStateNode[]
  ): Promise<void>;
  setRebaseEditorOpener(
    opener: (repo: IRepository, onto: string) => Promise<{ executed: boolean }>
  ): void;
}

function makeCommands(repo: IRepository, rebaseTracker: RebaseTracker): CommitContextMenuCommands {
  return new CommitContextMenuCommands(
    createMockGitService(repo),
    createMockRebaseService(rebaseTracker),
    createMockProvider(),
    createMockGitCli()
  );
}

describe('perform-time HEAD-containment guard', () => {
  let repo: IRepository;

  beforeEach(() => {
    repo = createMockRepo();
  });

  afterEach(() => restoreMessages());

  const NOT_IN_BRANCH = /not in the current branch/i;

  it("refuses to squash another branch's commits and does not start a rebase", async () => {
    const tracker: RebaseTracker = { startedOnto: undefined, executeCalls: 0 };
    const cmds = makeCommands(repo, tracker) as unknown as Internal;
    const msgs = captureMessages();

    await cmds._handleAction('squashCommits', [B_NEW, B_OLD], B_NODES);

    assert.strictEqual(
      tracker.startedOnto,
      undefined,
      'rebase must NOT start for an off-branch squash'
    );
    assert.strictEqual(tracker.executeCalls, 0);
    assert.ok(
      msgs.error.some((e) => NOT_IN_BRANCH.test(e)),
      `expected a "not in the current branch" toast; got ${JSON.stringify(msgs.error)}`
    );
  });

  it('refuses to drop a single off-branch commit', async () => {
    const tracker: RebaseTracker = { startedOnto: undefined, executeCalls: 0 };
    const cmds = makeCommands(repo, tracker) as unknown as Internal;
    const msgs = captureMessages();

    await cmds._handleAction('dropCommit', [B_NEW], [B_NODES[0]]);

    assert.strictEqual(
      tracker.startedOnto,
      undefined,
      'rebase must NOT start for an off-branch drop'
    );
    assert.ok(
      msgs.error.some((e) => NOT_IN_BRANCH.test(e)),
      JSON.stringify(msgs.error)
    );
  });

  it('refuses to drop multiple off-branch commits', async () => {
    const tracker: RebaseTracker = { startedOnto: undefined, executeCalls: 0 };
    const cmds = makeCommands(repo, tracker) as unknown as Internal;
    const msgs = captureMessages();

    await cmds._handleAction('dropCommit', [B_NEW, B_OLD], B_NODES);

    assert.strictEqual(tracker.startedOnto, undefined);
    assert.ok(
      msgs.error.some((e) => NOT_IN_BRANCH.test(e)),
      JSON.stringify(msgs.error)
    );
  });

  it('refuses to edit an off-branch commit message', async () => {
    const tracker: RebaseTracker = { startedOnto: undefined, executeCalls: 0 };
    const cmds = makeCommands(repo, tracker) as unknown as Internal;
    const msgs = captureMessages();

    await cmds._handleAction('editCommitMessage', [B_NEW], [B_NODES[0]]);

    assert.strictEqual(
      tracker.startedOnto,
      undefined,
      'rebase must NOT start for an off-branch reword'
    );
    assert.ok(
      msgs.error.some((e) => NOT_IN_BRANCH.test(e)),
      JSON.stringify(msgs.error)
    );
  });

  it('refuses to interactively rebase from an off-branch commit and never opens the editor', async () => {
    const tracker: RebaseTracker = { startedOnto: undefined, executeCalls: 0 };
    const cmds = makeCommands(repo, tracker) as unknown as Internal;
    let editorOpened = false;
    cmds.setRebaseEditorOpener(async () => {
      editorOpened = true;
      return { executed: false };
    });
    const msgs = captureMessages();

    await cmds._handleAction('interactiveRebase', [B_NEW], [B_NODES[0]]);

    assert.strictEqual(
      editorOpened,
      false,
      'the rebase editor must NOT open for an off-branch target'
    );
    assert.ok(
      msgs.error.some((e) => NOT_IN_BRANCH.test(e)),
      JSON.stringify(msgs.error)
    );
  });

  it('allows dropping a commit that IS in the current branch (no false block)', async () => {
    const tracker: RebaseTracker = { startedOnto: undefined, executeCalls: 0 };
    const cmds = makeCommands(repo, tracker) as unknown as Internal;
    captureMessages();

    // A_HEAD is the current branch tip → contained → the drop proceeds to rebase.
    await cmds._handleAction(
      'dropCommit',
      [A_HEAD],
      [{ hash: A_HEAD, parentCount: 1, parents: [BASE] }]
    );

    assert.strictEqual(tracker.startedOnto, `${A_HEAD}~1`, 'in-branch drop must start the rebase');
  });
});
