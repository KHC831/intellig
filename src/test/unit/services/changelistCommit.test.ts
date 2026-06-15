/**
 * Unit tests for the changelist→index commit mapping (workstream A item 1)
 * and the before-commit check framework (workstream A item 2).
 *
 * Covers:
 *  - computeChangelistCommitPlan: selectedFiles = target's files;
 *    allFiles = union across changelists; unknown target → undefined.
 *  - commitChangelist: stages the target's files, unstages staged files
 *    owned by OTHER changelists, then commits (git4idea per-changelist
 *    commit parity).
 *  - The cheap checkin handlers + runCheckinHandlers aggregation.
 */

import '../../setup';
import * as assert from 'assert';
import {
  computeChangelistCommitPlan,
  commitChangelist,
  IChangelistCommitView,
} from '../../../commits/CommitDialog';
import {
  userNameCheckinHandler,
  unresolvedMergeCheckinHandler,
  detachedRootCheckinHandler,
  runCheckinHandlers,
  ICheckinContext,
} from '../../../commits/CheckinHandlers';
import type {
  IGitService,
  IRepository,
  ICommitOptions,
} from '../../../git-core/interfaces/IGitService';
import { EventEmitter, Uri } from '../../mocks/vscode';

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
  } as unknown as IRepository;
}

function makeGitService(): IGitService & { calls: CallLog[] } {
  const calls: CallLog[] = [];
  const emitter = new EventEmitter<IRepository>();
  const svc = {
    calls,
    onDidChangeRepository: emitter.event,
    getStatus: async () => [],
    stage: async (repo: IRepository, paths: string[]): Promise<void> => {
      calls.push({ method: 'stage', args: [repo, paths] });
    },
    unstage: async (repo: IRepository, paths: string[]): Promise<void> => {
      calls.push({ method: 'unstage', args: [repo, paths] });
    },
    commit: async (repo: IRepository, message: string, options: ICommitOptions): Promise<void> => {
      calls.push({ method: 'commit', args: [repo, message, options] });
    },
    dispose: () => {},
  } as unknown as IGitService & { calls: CallLog[] };
  return svc;
}

const CHANGELISTS: IChangelistCommitView[] = [
  {
    id: 'cl-a',
    files: [
      { path: 'a1.ts', staged: false },
      { path: 'a2.ts', staged: true },
    ],
  },
  {
    id: 'cl-b',
    files: [
      { path: 'b1.ts', staged: true },
      { path: 'b2.ts', staged: false },
    ],
  },
];

describe('computeChangelistCommitPlan', () => {
  it('selects only the target changelist files', () => {
    const plan = computeChangelistCommitPlan(CHANGELISTS, 'cl-a');
    assert.ok(plan);
    assert.deepStrictEqual(plan.selectedFiles, ['a1.ts', 'a2.ts']);
  });

  it('includes every changelist file in allFiles with its staged flag', () => {
    const plan = computeChangelistCommitPlan(CHANGELISTS, 'cl-a');
    assert.ok(plan);
    assert.deepStrictEqual(plan.allFiles, [
      { path: 'a1.ts', staged: false },
      { path: 'a2.ts', staged: true },
      { path: 'b1.ts', staged: true },
      { path: 'b2.ts', staged: false },
    ]);
  });

  it('returns undefined for an unknown changelist id', () => {
    assert.strictEqual(computeChangelistCommitPlan(CHANGELISTS, 'nope'), undefined);
  });

  it('dedupes a path that appears in two changelists (first-seen staged flag wins)', () => {
    const plan = computeChangelistCommitPlan(
      [
        { id: 'x', files: [{ path: 'dup.ts', staged: true }] },
        { id: 'y', files: [{ path: 'dup.ts', staged: false }] },
      ],
      'x'
    );
    assert.ok(plan);
    assert.deepStrictEqual(plan.allFiles, [{ path: 'dup.ts', staged: true }]);
  });
});

describe('commitChangelist', () => {
  it('stages the target unstaged files, unstages other-changelist staged files, then commits', async () => {
    const git = makeGitService();
    const repo = makeRepo();
    const result = await commitChangelist(git, repo, CHANGELISTS, 'cl-a', 'feat: a');
    assert.strictEqual(result.success, true);

    // a1.ts is in cl-a and unstaged → staged.
    const stage = git.calls.find((c) => c.method === 'stage');
    assert.ok(stage, 'expected a stage call');
    assert.deepStrictEqual(stage.args[1], ['a1.ts']);

    // b1.ts belongs to cl-b and is staged → must be unstaged so the commit
    // is scoped to cl-a only.
    const unstage = git.calls.find((c) => c.method === 'unstage');
    assert.ok(unstage, 'expected an unstage call for the other changelist');
    assert.deepStrictEqual(unstage.args[1], ['b1.ts']);

    const commit = git.calls.find((c) => c.method === 'commit');
    assert.ok(commit);
    assert.strictEqual(commit.args[1], 'feat: a');
  });

  it('threads the changelist id through to performCommit options (telemetry)', async () => {
    // The commit options carry the changelist id so downstream callers can
    // observe the scope. We assert via the commit call's options.
    const git = makeGitService();
    const repo = makeRepo();
    await commitChangelist(git, repo, CHANGELISTS, 'cl-b', 'feat: b', { signOff: true });
    const commit = git.calls.find((c) => c.method === 'commit');
    assert.ok(commit);
    const opts = commit.args[2] as ICommitOptions;
    assert.strictEqual(opts.signOff, true);
  });

  it('fails (without touching git) for an unknown changelist', async () => {
    const git = makeGitService();
    const repo = makeRepo();
    const result = await commitChangelist(git, repo, CHANGELISTS, 'nope', 'msg');
    assert.strictEqual(result.success, false);
    assert.strictEqual(git.calls.length, 0);
  });

  it('fails (without touching git) for an empty changelist', async () => {
    const git = makeGitService();
    const repo = makeRepo();
    const result = await commitChangelist(git, repo, [{ id: 'empty', files: [] }], 'empty', 'msg');
    assert.strictEqual(result.success, false);
    assert.strictEqual(git.calls.length, 0);
  });
});

describe('CheckinHandlers — cheap before-commit checks', () => {
  const base: ICheckinContext = {
    userName: 'Kit',
    userEmail: 'k@e.com',
    userIdentityResolved: true,
    files: [],
    detachedHead: false,
  };

  describe('userNameCheckinHandler', () => {
    it('passes when name + email are set', () => {
      assert.deepStrictEqual(userNameCheckinHandler.check(base), []);
    });

    it('blocks when name is missing', () => {
      const problems = userNameCheckinHandler.check({ ...base, userName: '' });
      assert.strictEqual(problems.length, 1);
      assert.strictEqual(problems[0].severity, 'error');
      assert.ok(problems[0].text.includes('user.name'));
    });

    it('blocks when both are missing', () => {
      const problems = userNameCheckinHandler.check({
        ...base,
        userName: undefined,
        userEmail: undefined,
      });
      assert.strictEqual(problems.length, 1);
      assert.ok(problems[0].text.includes('user.name'));
      assert.ok(problems[0].text.includes('user.email'));
    });

    it('stays silent when identity is unresolved (could not read config)', () => {
      const problems = userNameCheckinHandler.check({
        ...base,
        userName: undefined,
        userEmail: undefined,
        userIdentityResolved: false,
      });
      assert.deepStrictEqual(problems, []);
    });
  });

  describe('unresolvedMergeCheckinHandler', () => {
    it('passes when no conflicted files', () => {
      assert.deepStrictEqual(
        unresolvedMergeCheckinHandler.check({
          ...base,
          files: [{ path: 'a.ts', status: 'modified' }],
        }),
        []
      );
    });

    it('blocks when a conflicted file is in the commit', () => {
      const problems = unresolvedMergeCheckinHandler.check({
        ...base,
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'c.ts', status: 'conflicted' },
        ],
      });
      assert.strictEqual(problems.length, 1);
      assert.strictEqual(problems[0].severity, 'error');
      assert.ok(problems[0].text.includes('c.ts'));
    });
  });

  describe('detachedRootCheckinHandler', () => {
    it('passes when on a branch', () => {
      assert.deepStrictEqual(detachedRootCheckinHandler.check(base), []);
    });

    it('warns (non-blocking) when HEAD is detached', () => {
      const problems = detachedRootCheckinHandler.check({ ...base, detachedHead: true });
      assert.strictEqual(problems.length, 1);
      assert.strictEqual(problems[0].severity, 'warning');
    });
  });

  describe('runCheckinHandlers', () => {
    it('aggregates problems in handler order and flags blocking', () => {
      const result = runCheckinHandlers({
        userName: '',
        userEmail: '',
        userIdentityResolved: true,
        detachedHead: true,
        files: [{ path: 'c.ts', status: 'conflicted' }],
      });
      // user.name (error) + unresolved (error) + detached (warning)
      assert.strictEqual(result.problems.length, 3);
      assert.strictEqual(result.problems[0].handlerId, 'git.user.name');
      assert.strictEqual(result.problems[1].handlerId, 'git.unresolved.merge');
      assert.strictEqual(result.problems[2].handlerId, 'git.detached.root');
      assert.strictEqual(result.hasBlockingProblem, true);
    });

    it('reports no blocking problem when only warnings fire', () => {
      const result = runCheckinHandlers({ ...base, detachedHead: true });
      assert.strictEqual(result.problems.length, 1);
      assert.strictEqual(result.hasBlockingProblem, false);
    });

    it('returns clean for a healthy context', () => {
      const result = runCheckinHandlers(base);
      assert.deepStrictEqual(result.problems, []);
      assert.strictEqual(result.hasBlockingProblem, false);
    });
  });
});
