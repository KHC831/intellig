/**
 * Unit tests for the align-local "Update Selected" planner (workstream D-8).
 *
 * IntelliJ's branch view "Update Selected" fast-forwards each selected local
 * branch to its tracked remote WITHOUT checking it out, using a
 * `<remoteRef>:<localRef>` fetch refspec, and skips branches that have
 * diverged (git refuses a non-fast-forward update into a non-checked-out ref).
 * git4idea reference: GitBranchActionsUtil.updateBranches (the non-current
 * branch path builds `GitFetchSpec(repo, remote, "$remoteBranch:$localBranch")`)
 * and BranchesDashboardActions.UpdateSelectedBranchAction.
 *
 * These tests pin the pure planning step: which selected branches yield an FF
 * fetch refspec, and which are skipped/reported (diverged, no-upstream,
 * checked-out, already-up-to-date).
 */

import '../setup';
import * as assert from 'assert';
import {
  planAlignLocal,
  IAlignLocalBranchInput,
  BranchContextMenuCommands,
} from '../../branches/BranchContextMenuCommands';
import { BranchTreeItem, BranchTreeProvider } from '../../branches/BranchTreeProvider';
import {
  IGitService,
  IRepository,
  IBranch,
  IFetchResult,
  IFetchOptions,
} from '../../git-core/interfaces/IGitService';
import { EventEmitter, Uri } from '../mocks/vscode';
import {
  installInfoMessageTracker,
  installWarningMessageTracker,
  restoreMessageFunctions,
} from '../typed/windowStub';
import { invokePrivateHandler } from '../typed/privateHandler';

describe('Align-local Update Selected — planAlignLocal', () => {
  it('builds an FF fetch refspec for a behind-but-fast-forwardable branch', () => {
    const inputs: IAlignLocalBranchInput[] = [
      {
        name: 'main',
        isCurrent: false,
        upstream: { remote: 'origin', name: 'main' },
        incoming: 3,
        outgoing: 0,
      },
    ];

    const plan = planAlignLocal(inputs);

    assert.strictEqual(plan.fetches.length, 1);
    assert.deepStrictEqual(plan.fetches[0], {
      branch: 'main',
      remote: 'origin',
      refspec: 'main:main',
    });
    assert.strictEqual(plan.skipped.length, 0);
    assert.strictEqual(plan.upToDate.length, 0);
  });

  it('preserves slashed remote/local names in the refspec', () => {
    const inputs: IAlignLocalBranchInput[] = [
      {
        name: 'feature/x',
        isCurrent: false,
        upstream: { remote: 'upstream', name: 'feature/x' },
        incoming: 1,
        outgoing: 0,
      },
    ];

    const plan = planAlignLocal(inputs);

    assert.deepStrictEqual(plan.fetches[0], {
      branch: 'feature/x',
      remote: 'upstream',
      refspec: 'feature/x:feature/x',
    });
  });

  it('skips a diverged branch (FF-only; reports it, no fetch)', () => {
    const inputs: IAlignLocalBranchInput[] = [
      {
        name: 'dev',
        isCurrent: false,
        upstream: { remote: 'origin', name: 'dev' },
        incoming: 2,
        outgoing: 1,
      },
    ];

    const plan = planAlignLocal(inputs);

    assert.strictEqual(plan.fetches.length, 0);
    assert.strictEqual(plan.skipped.length, 1);
    assert.strictEqual(plan.skipped[0].branch, 'dev');
    assert.match(plan.skipped[0].reason, /diverged/i);
  });

  it('skips a branch with no upstream', () => {
    const inputs: IAlignLocalBranchInput[] = [
      { name: 'local-only', isCurrent: false, upstream: undefined, incoming: 0, outgoing: 0 },
    ];

    const plan = planAlignLocal(inputs);

    assert.strictEqual(plan.fetches.length, 0);
    assert.strictEqual(plan.skipped[0].branch, 'local-only');
    assert.match(plan.skipped[0].reason, /upstream/i);
  });

  it('skips the checked-out (current) branch — FF into a checked-out ref is refused', () => {
    const inputs: IAlignLocalBranchInput[] = [
      {
        name: 'main',
        isCurrent: true,
        upstream: { remote: 'origin', name: 'main' },
        incoming: 3,
        outgoing: 0,
      },
    ];

    const plan = planAlignLocal(inputs);

    assert.strictEqual(plan.fetches.length, 0);
    assert.strictEqual(plan.skipped[0].branch, 'main');
    assert.match(plan.skipped[0].reason, /checked out|current|update|pull/i);
  });

  it('reports an already-up-to-date branch without fetching', () => {
    const inputs: IAlignLocalBranchInput[] = [
      {
        name: 'release',
        isCurrent: false,
        upstream: { remote: 'origin', name: 'release' },
        incoming: 0,
        outgoing: 0,
      },
    ];

    const plan = planAlignLocal(inputs);

    assert.strictEqual(plan.fetches.length, 0);
    assert.strictEqual(plan.skipped.length, 0);
    assert.deepStrictEqual(plan.upToDate, ['release']);
  });

  it('classifies a mixed selection into fetch / skip / up-to-date buckets', () => {
    const inputs: IAlignLocalBranchInput[] = [
      {
        name: 'ffable',
        isCurrent: false,
        upstream: { remote: 'origin', name: 'ffable' },
        incoming: 4,
        outgoing: 0,
      },
      {
        name: 'diverged',
        isCurrent: false,
        upstream: { remote: 'origin', name: 'diverged' },
        incoming: 1,
        outgoing: 2,
      },
      {
        name: 'synced',
        isCurrent: false,
        upstream: { remote: 'origin', name: 'synced' },
        incoming: 0,
        outgoing: 0,
      },
    ];

    const plan = planAlignLocal(inputs);

    assert.deepStrictEqual(
      plan.fetches.map((f) => f.branch),
      ['ffable']
    );
    assert.deepStrictEqual(
      plan.skipped.map((s) => s.branch),
      ['diverged']
    );
    assert.deepStrictEqual(plan.upToDate, ['synced']);
  });
});

// ─── Handler wiring ───────────────────────────────────────────────────────────

interface IoCounts {
  incoming: number;
  outgoing: number;
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

/**
 * Minimal GitService stub exposing only what the align-local handler touches:
 * the duck-typed `getIncomingOutgoingForBranch`, `fetch`, and
 * `reloadRepository`. Captures fetch options so tests can assert the FF refspec.
 */
function makeStub(io: IoCounts, fetchImpl?: (options: IFetchOptions) => void) {
  const fetchCalls: IFetchOptions[] = [];
  const service = {
    onDidChangeRepository: new EventEmitter<IRepository>().event,
    getIncomingOutgoingForBranch: async (_repo: IRepository, branch: string) => ({
      branch,
      upstream: 'origin/main',
      incoming: io.incoming,
      outgoing: io.outgoing,
      noUpstream: false,
    }),
    fetch: async (_repo: IRepository, options?: IFetchOptions | string): Promise<IFetchResult> => {
      const opts = typeof options === 'string' ? { remote: options } : (options ?? {});
      fetchCalls.push(opts);
      fetchImpl?.(opts);
      return { updatedRefs: [], ahead: 0, behind: 0, errors: [] };
    },
    reloadRepository: async (repo: IRepository) => repo,
  } as unknown as IGitService;
  return { service, fetchCalls };
}

function makeProvider(service: IGitService): BranchTreeProvider {
  const provider = new BranchTreeProvider(service);
  provider.getRepository = () => makeRepo();
  provider.refresh = () => {};
  return provider;
}

function localBranchItem(name: string, isHead: boolean): BranchTreeItem {
  const branch: IBranch = {
    name,
    type: 'local',
    commit: 'abc1234',
    isHead,
    upstream: { remote: 'origin', name },
  };
  return new BranchTreeItem(name, 0, 'local-branch', branch, undefined, false);
}

describe('Align-local Update Selected — handler', () => {
  afterEach(() => restoreMessageFunctions());

  it('fast-forwards a behind-but-FF-able branch via a <remoteRef>:<localRef> refspec', async () => {
    const { service, fetchCalls } = makeStub({ incoming: 2, outgoing: 0 });
    const info = installInfoMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(service));

    await invokePrivateHandler(cmds, '_handleUpdateSelected', localBranchItem('feature', false));

    assert.strictEqual(fetchCalls.length, 1);
    assert.strictEqual(fetchCalls[0].remote, 'origin');
    assert.strictEqual(fetchCalls[0].refspec, 'feature:feature');
    assert.strictEqual(info.calls.length, 1, 'a clean FF reports an info toast');
  });

  it('skips a diverged branch with a warning and no fetch', async () => {
    const { service, fetchCalls } = makeStub({ incoming: 1, outgoing: 3 });
    const warn = installWarningMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(service));

    await invokePrivateHandler(cmds, '_handleUpdateSelected', localBranchItem('feature', false));

    assert.strictEqual(fetchCalls.length, 0, 'no fetch for a diverged branch');
    assert.strictEqual(warn.calls.length, 1);
    assert.match(warn.calls[0].message, /diverged/i);
  });

  it('reports a fetch-time non-FF rejection as a skip rather than throwing', async () => {
    const { service, fetchCalls } = makeStub({ incoming: 2, outgoing: 0 }, () => {
      throw new Error('! [rejected] feature -> feature (non-fast-forward)');
    });
    const warn = installWarningMessageTracker();
    const cmds = new BranchContextMenuCommands(service, makeProvider(service));

    await invokePrivateHandler(cmds, '_handleUpdateSelected', localBranchItem('feature', false));

    assert.strictEqual(fetchCalls.length, 1, 'the FF fetch was attempted');
    assert.strictEqual(warn.calls.length, 1);
    assert.match(warn.calls[0].message, /fast-forward failed/i);
  });
});
