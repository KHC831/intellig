/**
 * Multi-drop with an abbreviated selection: the rebase session's commits
 * carry full 40-char SHAs (`git log --format=%H`) while a log-surface
 * dispatch can carry abbreviated hashes. The drop plan must match them by
 * the same tolerant prefix rule the single-drop path uses; exact set
 * membership marks zero drops and the flow silently aborts with the
 * stale-selection toast.
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

// Current branch: HEAD -> N2 -> N1 -> BASE; user drops N1+N2 by 7-char hash.
const HEAD_FULL = 'a'.repeat(40);
const N2_FULL = 'b'.repeat(40);
const N1_FULL = 'c'.repeat(40);
const BASE_FULL = 'd'.repeat(40);

const ABBREV_NODES: readonly IMenuStateNode[] = [
  { hash: HEAD_FULL.substring(0, 7), parentCount: 1, parents: [N2_FULL.substring(0, 7)] },
  { hash: N2_FULL.substring(0, 7), parentCount: 1, parents: [N1_FULL.substring(0, 7)] },
  { hash: N1_FULL.substring(0, 7), parentCount: 1, parents: [BASE_FULL.substring(0, 7)] },
];

function createMockRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: { HEAD: { name: 'main', commit: HEAD_FULL, type: 0 as const } },
    head: { name: 'main', commit: HEAD_FULL },
    inputBox: { value: '' },
    remotes: [],
  } as unknown as IRepository;
}

interface Tracker {
  executeCalls: number;
  lastPlan: IRebaseAction[] | undefined;
}

function createMockRebaseService(tracker: Tracker): IRebaseService {
  const emitter = new EventEmitter<undefined>();
  let plan: IRebaseAction[] | undefined;
  return {
    startInteractiveRebase: async (_repo: IRepository, onto: string): Promise<IRebaseSession> => ({
      onto,
      originalBranch: 'main',
      // Real git: the session window carries FULL SHAs.
      commits: [
        { hash: N1_FULL, message: 'n1', action: 'pick' as const },
        { hash: N2_FULL, message: 'n2', action: 'pick' as const },
        { hash: HEAD_FULL, message: 'head', action: 'pick' as const },
      ],
      currentStep: 0,
      status: 'planning',
    }),
    getRebaseSession: () => undefined,
    clearSession: () => {},
    updateRebasePlan: (_repo: IRepository, p: IRebaseAction[]) => {
      plan = p;
    },
    executeRebase: async (): Promise<IRebaseResult> => {
      tracker.executeCalls++;
      tracker.lastPlan = plan;
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
  const fullByPrefix = (ref: string): string =>
    [HEAD_FULL, N2_FULL, N1_FULL, BASE_FULL].find((f) => f.startsWith(ref)) ?? ref;
  return {
    getRepositories: () => [repo],
    getActiveRepository: () => repo,
    getRepository: async () => repo,
    getCommit: async (_repo: IRepository, hash: string) => ({
      hash: fullByPrefix(hash),
      shortHash: hash.substring(0, 7),
      message: `subject ${hash.substring(0, 7)}`,
      author: { name: 'a', email: 'a@x' },
      committer: { name: 'a', email: 'a@x' },
      parents: [],
      authorDate: new Date(0),
      commitDate: new Date(0),
    }),
    // Real git prints the FULL merge-base SHA whatever form the ref took.
    getMergeBase: async (_repo: IRepository, refA: string) => fullByPrefix(refA),
    reloadRepository: async () => {},
    dispose: () => {},
  } as unknown as IGitService;
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

interface Internal {
  _handleAction(
    action: string,
    hashes: string[],
    commitNodes?: readonly IMenuStateNode[]
  ): Promise<void>;
}

describe('multi-drop with abbreviated selection hashes', () => {
  afterEach(() => {
    const w = writableWindow();
    w.showErrorMessage = () => Promise.resolve(undefined);
    w.showInformationMessage = () => Promise.resolve(undefined);
    w.showWarningMessage = () => Promise.resolve(undefined);
  });

  it('marks the selected commits as drops against the full-SHA session', async () => {
    const tracker: Tracker = { executeCalls: 0, lastPlan: undefined };
    const repo = createMockRepo();
    const cmds = new CommitContextMenuCommands(
      createMockGitService(repo),
      createMockRebaseService(tracker),
      {
        onDidRequestLogContextAction: () => ({ dispose: () => {} }),
        refresh: () => {},
      } as unknown as GitToolWindowProvider,
      createMockGitCli()
    ) as unknown as Internal;
    const w = writableWindow();
    w.showInformationMessage = (() => Promise.resolve(undefined)) as never;
    // Auto-accept the destructive-op confirm so the flow reaches the plan.
    w.showWarningMessage = ((..._a: unknown[]) => Promise.resolve('Drop')) as never;

    await cmds._handleAction(
      'dropCommit',
      [N2_FULL.substring(0, 7), N1_FULL.substring(0, 7)],
      ABBREV_NODES
    );

    assert.strictEqual(
      tracker.executeCalls,
      1,
      'the drop must execute — an abbreviated selection is not a stale one'
    );
    const drops = (tracker.lastPlan ?? []).filter((p) => p.action === 'drop').map((p) => p.hash);
    assert.deepStrictEqual(
      drops.sort(),
      [N1_FULL, N2_FULL].sort(),
      'both selected commits must be marked drop in the full-SHA plan'
    );
  });
});
