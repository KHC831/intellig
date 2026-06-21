/**
 * Unit tests for the Incoming tab (Workstream C, Item 4).
 *
 * Covers:
 *   - Pure helpers (`selectIncomingCommits`, `headHashSet`).
 *   - `IncomingTab` class behaviour: refresh with upstream / no upstream /
 *     in-sync / diverged, selection, jump-to-commit routing, error capture,
 *     and the `onStateChange` emission contract the provider attaches to.
 */

import '../../../setup';
import * as assert from 'assert';
import type {
  ICommit,
  ILogOptions,
  IRepository,
} from '../../../../src/git-core/interfaces/IGitService';
import type { IIncomingOutgoing } from '../../../../src/git-core/ops/IncomingOutgoingOps';
import {
  IncomingTab,
  createInitialIncomingTabState,
  headHashSet,
  selectIncomingCommits,
  type IIncomingDataSource,
  type IIncomingTabState,
} from '../../../../src/git-core/gitToolWindow/tabs/IncomingTab';
import type { IWebviewTabMessage } from '../../../../src/git-core/gitToolWindow/tabRouter';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function commit(hash: string, message = `msg ${hash}`): ICommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message,
    author: { name: 'A', email: 'a@example.com' },
    committer: { name: 'A', email: 'a@example.com' },
    parents: [],
    authorDate: new Date('2026-06-15T00:00:00Z'),
    commitDate: new Date('2026-06-15T00:00:00Z'),
  };
}

const REPO = { rootUri: { fsPath: '/repo' } } as unknown as IRepository;

interface IStubCalls {
  io: IIncomingOutgoing;
  logs: Map<string | undefined, ICommit[]>;
  logCalls: ILogOptions[];
}

function makeDataSource(calls: IStubCalls): IIncomingDataSource {
  return {
    getIncomingOutgoing: async (): Promise<IIncomingOutgoing> => calls.io,
    getLog: async (_repo: IRepository, options?: ILogOptions): Promise<ICommit[]> => {
      calls.logCalls.push(options ?? {});
      return calls.logs.get(options?.ref) ?? [];
    },
  };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('IncomingTab — pure helpers', () => {
  describe('selectIncomingCommits', () => {
    it('returns upstream commits absent from HEAD, preserving order', () => {
      const upstream = [commit('u3'), commit('u2'), commit('shared1')];
      const head = headHashSet([commit('shared1'), commit('h0')]);
      const result = selectIncomingCommits(upstream, head);
      assert.deepStrictEqual(
        result.map((c) => c.hash),
        ['u3', 'u2']
      );
    });

    it('is empty when upstream is fully contained in HEAD (in sync / behind nothing)', () => {
      const upstream = [commit('s2'), commit('s1')];
      const head = headHashSet([commit('s2'), commit('s1'), commit('local')]);
      assert.deepStrictEqual(selectIncomingCommits(upstream, head), []);
    });

    it('handles diverged history (upstream-only commits past a fork point)', () => {
      // shared base + divergent tips: upstream has u-commits, head has local.
      const upstream = [commit('u2'), commit('u1'), commit('base')];
      const head = headHashSet([commit('local2'), commit('local1'), commit('base')]);
      assert.deepStrictEqual(
        selectIncomingCommits(upstream, head).map((c) => c.hash),
        ['u2', 'u1']
      );
    });
  });

  describe('headHashSet', () => {
    it('builds a hash set from a HEAD log slice', () => {
      const set = headHashSet([commit('a'), commit('b')]);
      assert.ok(set.has('a'));
      assert.ok(set.has('b'));
      assert.strictEqual(set.size, 2);
    });
  });
});

// ─── IncomingTab class ───────────────────────────────────────────────────────

describe('IncomingTab — refresh', () => {
  it('reports no-upstream cleanly without fetching logs', async () => {
    const calls: IStubCalls = {
      io: { branch: 'feature', incoming: 0, outgoing: 0, noUpstream: true },
      logs: new Map(),
      logCalls: [],
    };
    const states: IIncomingTabState[] = [];
    const tab = new IncomingTab(makeDataSource(calls), {
      getRepo: () => REPO,
      onStateChange: (s) => states.push({ ...s }),
    });

    await tab.refresh();

    const final = tab.getState();
    assert.strictEqual(final.noUpstream, true);
    assert.strictEqual(final.branch, 'feature');
    assert.strictEqual(final.commits.length, 0);
    assert.strictEqual(calls.logCalls.length, 0, 'no log calls when there is no upstream');
  });

  it('reports in-sync (incoming=0) without fetching logs', async () => {
    const calls: IStubCalls = {
      io: { branch: 'main', upstream: 'origin/main', incoming: 0, outgoing: 2, noUpstream: false },
      logs: new Map(),
      logCalls: [],
    };
    const tab = new IncomingTab(makeDataSource(calls), { getRepo: () => REPO });

    await tab.refresh();

    const final = tab.getState();
    assert.strictEqual(final.incomingCount, 0);
    assert.strictEqual(final.outgoingCount, 2);
    assert.strictEqual(final.commits.length, 0);
    assert.strictEqual(calls.logCalls.length, 0, 'no log calls when incoming is 0');
  });

  it('computes the incoming commit list via upstream-minus-HEAD set difference', async () => {
    const calls: IStubCalls = {
      io: { branch: 'main', upstream: 'origin/main', incoming: 2, outgoing: 0, noUpstream: false },
      logs: new Map<string | undefined, ICommit[]>([
        ['origin/main', [commit('u2'), commit('u1'), commit('base')]],
        [undefined, [commit('base'), commit('older')]],
      ]),
      logCalls: [],
    };
    const tab = new IncomingTab(makeDataSource(calls), { getRepo: () => REPO });

    await tab.refresh();

    const final = tab.getState();
    assert.strictEqual(final.incomingCount, 2);
    assert.deepStrictEqual(
      final.commits.map((c) => c.hash),
      ['u2', 'u1']
    );
    // Fetched both the upstream ref log and HEAD log.
    assert.ok(calls.logCalls.some((o) => o.ref === 'origin/main'));
    assert.ok(calls.logCalls.some((o) => o.ref === undefined));
  });

  it('captures an error into state.error rather than throwing', async () => {
    const data: IIncomingDataSource = {
      getIncomingOutgoing: async () => {
        throw new Error('fatal: boom');
      },
      getLog: async () => [],
    };
    const tab = new IncomingTab(data, { getRepo: () => REPO });

    await tab.refresh();

    const final = tab.getState();
    assert.ok(final.error && final.error.length > 0, 'error captured');
    assert.strictEqual(final.loading, false);
  });

  it('reports an error when no repository is selected', async () => {
    const calls: IStubCalls = {
      io: { branch: 'main', incoming: 0, outgoing: 0, noUpstream: true },
      logs: new Map(),
      logCalls: [],
    };
    const tab = new IncomingTab(makeDataSource(calls), { getRepo: () => undefined });

    await tab.refresh();

    assert.strictEqual(tab.getState().error, 'No repository selected.');
  });

  it('emits a loading state then a settled state through onStateChange', async () => {
    const calls: IStubCalls = {
      io: { branch: 'main', upstream: 'origin/main', incoming: 0, outgoing: 0, noUpstream: false },
      logs: new Map(),
      logCalls: [],
    };
    const states: IIncomingTabState[] = [];
    const tab = new IncomingTab(makeDataSource(calls), {
      getRepo: () => REPO,
      onStateChange: (s) => states.push({ ...s }),
    });

    await tab.refresh();

    assert.ok(states.length >= 2, 'at least loading + settled');
    assert.strictEqual(states[0].loading, true, 'first emission is the loading state');
    assert.strictEqual(states[states.length - 1].loading, false, 'final emission settled');
  });
});

describe('IncomingTab — message handling', () => {
  function makeTab(jump?: (hash: string) => void): {
    tab: IncomingTab;
    states: IIncomingTabState[];
  } {
    const calls: IStubCalls = {
      io: { branch: 'main', upstream: 'origin/main', incoming: 1, outgoing: 0, noUpstream: false },
      logs: new Map<string | undefined, ICommit[]>([
        ['origin/main', [commit('u1'), commit('base')]],
        [undefined, [commit('base')]],
      ]),
      logCalls: [],
    };
    const states: IIncomingTabState[] = [];
    const tab = new IncomingTab(makeDataSource(calls), {
      getRepo: () => REPO,
      onStateChange: (s) => states.push({ ...s }),
      jumpToCommit: jump,
    });
    return { tab, states };
  }

  it('incoming.refresh recomputes state', async () => {
    const { tab } = makeTab();
    await tab.asTabHandler()({ type: 'incoming.refresh' } as IWebviewTabMessage);
    assert.strictEqual(tab.getState().incomingCount, 1);
    assert.deepStrictEqual(
      tab.getState().commits.map((c) => c.hash),
      ['u1']
    );
  });

  it('incoming.selectCommit records the selection', async () => {
    const { tab } = makeTab();
    await tab.handleMessage({ type: 'incoming.selectCommit', hash: 'u1' } as IWebviewTabMessage);
    assert.strictEqual(tab.getState().selectedCommit, 'u1');
  });

  it('incoming.jumpToCommit routes through the jumpToCommit hook', async () => {
    const jumped: string[] = [];
    const { tab } = makeTab((h) => jumped.push(h));
    await tab.handleMessage({ type: 'incoming.jumpToCommit', hash: 'u1' } as IWebviewTabMessage);
    assert.deepStrictEqual(jumped, ['u1']);
  });

  it('ignores malformed messages', async () => {
    const { tab, states } = makeTab();
    await tab.handleMessage({} as IWebviewTabMessage);
    await tab.handleMessage({ type: 'incoming.unknown' } as IWebviewTabMessage);
    assert.strictEqual(states.length, 0, 'no state changes for malformed/unknown messages');
  });
});

describe('createInitialIncomingTabState', () => {
  it('starts empty and not loading', () => {
    const s = createInitialIncomingTabState();
    assert.strictEqual(s.incomingCount, 0);
    assert.strictEqual(s.outgoingCount, 0);
    assert.strictEqual(s.noUpstream, false);
    assert.strictEqual(s.commits.length, 0);
    assert.strictEqual(s.loading, false);
    assert.strictEqual(s.error, undefined);
  });
});
