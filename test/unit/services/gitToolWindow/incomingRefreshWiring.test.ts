/**
 * Wiring coverage for the Incoming tab's refresh triggers.
 *
 * The tab computes its data only in `IncomingTab.refresh()`. Nothing in the
 * provider ever called it, so the tab was frozen on its empty initial state
 * ("Up to date with upstream. No incoming commits.") regardless of the real
 * incoming count. These tests pin the production triggers:
 *   - activating the Incoming tab refreshes it,
 *   - a fetch while the Incoming tab is visible refreshes it,
 *   - double-clicking a row routes to that commit in the Log tab.
 */

import '../../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import { IncomingTab } from '../../../../src/git-core/gitToolWindow/tabs/IncomingTab';
import { createMockGitService } from '../../../mocks/mockGitService';
import { Uri } from '../../../mocks/vscode';
import type {
  ICommit,
  IGitService,
  IRepository,
} from '../../../../src/git-core/interfaces/IGitService';

const REPO = {
  rootUri: Uri.file('/repo'),
  state: 'idle',
  remotes: [],
  submodules: [],
} as unknown as IRepository;

function commit(hash: string, message: string): ICommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message,
    body: '',
    author: { name: 'A', email: 'a@e.com' },
    committer: { name: 'A', email: 'a@e.com' },
    parents: [],
    authorDate: new Date('2024-01-01T00:00:00Z'),
    commitDate: new Date('2024-01-01T00:00:00Z'),
  } as unknown as ICommit;
}

const INCOMING = commit('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'incoming commit');
const BASE = commit('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'base commit');

interface FetchCb {
  (payload: { repo: IRepository; result: unknown }): void;
}

function makeProvider(): {
  provider: GitToolWindowProvider;
  ioCalls: () => number;
  fireFetch: FetchCb;
  tab: () => IncomingTab;
} {
  let ioCalls = 0;
  let fetchCb: FetchCb | undefined;
  const gitService = createMockGitService(REPO, {
    onDidFetch: (cb: FetchCb) => {
      fetchCb = cb;
      return { dispose: () => {} };
    },
    getIncomingOutgoing: async () => {
      ioCalls++;
      return {
        branch: 'main',
        upstream: 'origin/main',
        incoming: 1,
        outgoing: 0,
        noUpstream: false,
      };
    },
    // Upstream log carries INCOMING + BASE; HEAD log carries only BASE.
    getLog: async (_repo: IRepository, options?: { ref?: string }) =>
      options?.ref ? [INCOMING, BASE] : [BASE],
  } as unknown as Partial<IGitService>);

  const provider = new GitToolWindowProvider(Uri.file('/ext'));
  provider.setAvailableRepositories([REPO] as Parameters<
    typeof provider.setAvailableRepositories
  >[0]);
  provider.attachGitService(gitService);

  return {
    provider,
    ioCalls: () => ioCalls,
    fireFetch: (payload) => fetchCb?.(payload),
    tab: () => (provider as unknown as { _incomingTab: IncomingTab })._incomingTab,
  };
}

// A couple of macrotask flushes so the async refresh (getIncomingOutgoing →
// getLog → set-difference) settles before assertions.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('Incoming tab — refresh wiring', () => {
  it('refreshes when the Incoming tab is activated (was: frozen empty state)', async () => {
    const h = makeProvider();
    assert.strictEqual(h.ioCalls(), 0, 'no refresh before the tab is opened');

    await h.provider.focusTab('incoming');
    await flush();

    assert.ok(h.ioCalls() >= 1, 'activating the tab must call getIncomingOutgoing');
    const state = h.tab().getState();
    assert.strictEqual(state.upstream, 'origin/main', 'upstream resolved (not the placeholder)');
    assert.strictEqual(state.incomingCount, 1);
    assert.deepStrictEqual(
      state.commits.map((c) => c.hash),
      [INCOMING.hash],
      'the incoming commit is in the list'
    );
  });

  it('refreshes on fetch while the Incoming tab is visible', async () => {
    const h = makeProvider();
    await h.provider.focusTab('incoming');
    await flush();
    const before = h.ioCalls();

    h.fireFetch({ repo: REPO, result: {} });
    await flush();

    assert.ok(h.ioCalls() > before, 'a fetch must re-refresh the visible Incoming tab');
  });

  it('does not run incoming work on fetch when another tab is active', async () => {
    const h = makeProvider();
    // Active tab defaults to 'log'; never activated incoming.
    h.fireFetch({ repo: REPO, result: {} });
    await flush();
    assert.strictEqual(h.ioCalls(), 0, 'no incoming compute when the tab is not visible');
  });

  it('double-clicking a row jumps to that commit in the Log tab', async () => {
    // The tab calls its optional jumpToCommit hook; the provider must supply
    // one, as it does for the Update Info tab, or the gesture is a no-op.
    const h = makeProvider();
    await h.provider.focusTab('incoming');
    await flush();

    const focused: string[] = [];
    const scrolled: string[] = [];
    const p = h.provider as unknown as {
      focusTab: (tab: string) => Promise<void>;
      scrollToCommit: (hash: string) => void;
    };
    p.focusTab = async (tab: string): Promise<void> => {
      focused.push(tab);
    };
    p.scrollToCommit = (hash: string): void => {
      scrolled.push(hash);
    };

    await h.tab().handleMessage({
      type: 'incoming.jumpToCommit',
      hash: INCOMING.hash,
    } as never);
    await flush();

    assert.deepStrictEqual(focused, ['log'], 'the jump must focus the Log tab');
    assert.deepStrictEqual(scrolled, [INCOMING.hash], 'and scroll it to the commit');
  });
});
