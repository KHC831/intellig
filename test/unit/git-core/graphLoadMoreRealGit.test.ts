/**
 * Real-git integration for scroll-to-bottom load-more.
 *
 * Exercises scroll-to-bottom load-more end-to-end against a live repo with MORE
 * than one page of commits, covering the REAL pieces it wires together:
 * `getLog` (windowed fetch), `getLogCount` (rev-list total), the load-more
 * controller, and the provider's render plumbing.
 *
 * Without a subscriber to the load-more emitter, the graph is hard-capped at
 * the first page and `hasMore` stays stuck. Here we assert:
 *   - the first (fresh) load renders exactly one page, with the honest total
 *     and `hasMore` true (the newest page only — the oldest commit is absent);
 *   - firing the controller's load-more grows the window: the older commits
 *     are appended, the total stays honest, and `hasMore` flips off at the
 *     true end;
 *   - the grown render asks the webview to preserve scroll.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { createGitCli } from '../../../src/git-core/gitCli';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { createGraphLoadMoreController } from '../../../src/registration/graphLoadMore';
import { fetchGraphPage } from '../../../src/registration/graphLogPage';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

const PAGE = 500;
const TOTAL = 600;

function makeRealOps(): StashTagHistoryOps {
  const ctx = {
    gitCli: createGitCli(),
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return new StashTagHistoryOps(ctx);
}

describe('Graph load-more — real git, more than one page', function () {
  this.timeout(180000);

  let dir: string;
  const ops = makeRealOps();
  // fetchGraphPage consumes the facade's Promise-returning getLog/getLogCount;
  // the ops now expose a Result channel, so this adapter mirrors the façade's
  // absorb (degrade to []/0) to drive the production fetch path unchanged.
  const gitForGraph = {
    getLog: (r: IRepository, options?: Parameters<typeof ops.getLog>[1]) =>
      ops.getLog(r, options).unwrapOr([]),
    getLogCount: (r: IRepository, options?: Parameters<typeof ops.getLogCount>[1]) =>
      ops.getLogCount(r, options).unwrapOr(0),
    getTrackedPaths: async () => [],
  };
  let provider: GitToolWindowProvider;
  const repo = (): IRepository => ({ rootUri: { fsPath: dir } }) as unknown as IRepository;

  // Drives the PRODUCTION fetch+thread path (fetchGraphPage builds the shared
  // scope and threads getLog→getLogCount→total), mirroring exactly what
  // registerViews' loadLogCommitsForRepo does for the load-more-relevant
  // behavior: window via the controller's limit, push the honest total into the
  // provider, and request a scroll RESET only on a fresh (navigational) load —
  // load-more and other in-place re-renders preserve scroll by default.
  async function load(loadMore?: { limit: number }): Promise<void> {
    let limit: number;
    if (loadMore) {
      limit = loadMore.limit;
    } else {
      controller.noteFreshLoad(repo(), undefined);
      limit = controller.currentLimit();
      provider.markResetScrollOnNextRender();
    }
    const { commits, totalAvailable } = await fetchGraphPage(
      gitForGraph as unknown as Pick<IGitService, 'getLog' | 'getLogCount'>,
      repo(),
      undefined,
      limit
    );
    provider.updateLogState(
      commits,
      undefined,
      undefined,
      undefined,
      undefined,
      await totalAvailable
    );
    // The test has no webview, so the provider's _render is a no-op and never
    // consumes the one-shot reset flag the way production does. Simulate that
    // consuming render so a fresh load's reset doesn't leak into the next
    // load-more's HTML. A single node is enough to reach the flag-consuming code
    // path (an empty list short-circuits to the empty-state markup); the render
    // output itself is discarded.
    provider._getGraphPanelHtml(provider.getExtendedLogState().commitNodes.slice(0, 1));
  }

  const controller = createGraphLoadMoreController<undefined>(PAGE, (_r, _f, opts) => {
    void load(opts);
  });

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loadmore-'));
    const git = (...a: string[]): void => {
      execFileSync('git', a, { cwd: dir });
    };
    git('init', '-q');
    git('config', 'user.email', 't@t.io');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    // 600 empty commits via a single shell process — c1 (oldest) … c600 (newest).
    execFileSync(
      'bash',
      ['-c', `for i in $(seq 1 ${TOTAL}); do git commit --allow-empty -q -m "c$i"; done`],
      {
        cwd: dir,
      }
    );
  });

  after(() => {
    provider.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  it('fresh load renders exactly one page with the honest total and hasMore true', async () => {
    await load();

    const nodes = provider.getExtendedLogState().commitNodes;
    assert.strictEqual(nodes.length, PAGE, 'first load is capped at one page');
    assert.strictEqual(provider.getLogTotalAvailable(), TOTAL, 'total is the rev-list count');

    const messages = new Set(nodes.map((n) => n.commit.message.trim()));
    assert.ok(messages.has('c600'), 'newest commit is on the first page');
    assert.ok(!messages.has('c1'), 'oldest commit is beyond the first page (the cap)');

    const html = provider._getGraphPanelHtml(nodes, undefined, nodes.length, TOTAL);
    assert.ok(html.includes(`data-total-available="${TOTAL}"`));
    assert.ok(html.includes(`(${PAGE} of ${TOTAL})`), 'honest "loaded of total" indicator');
  });

  it('load-more appends the older commits, keeps the total honest, and flips hasMore off at the end', async () => {
    await load(); // first page
    assert.strictEqual(provider.getExtendedLogState().commitNodes.length, PAGE);

    // Drive the SAME path the webview's loadMoreCommits → emitter triggers.
    controller.handleLoadMore();
    // The reload is fire-and-forget (the controller calls `void load(opts)`);
    // poll for it to settle instead of a fixed sleep so the assertion can't race
    // the async git read under CPU contention.
    const deadline = Date.now() + 5000;
    while (provider.getExtendedLogState().commitNodes.length < TOTAL && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const nodes = provider.getExtendedLogState().commitNodes;
    assert.strictEqual(nodes.length, TOTAL, 'window grew to include the older commits');
    const messages = new Set(nodes.map((n) => n.commit.message.trim()));
    assert.ok(messages.has('c1'), 'the previously-capped oldest commit is now loaded');

    // loaded === total ⇒ no more, indicator gone.
    const html = provider._getGraphPanelHtml(
      nodes,
      undefined,
      nodes.length,
      provider.getLogTotalAvailable()
    );
    assert.ok(!html.includes('graph-loading-indicator'), 'hasMore is false at the true end');
    assert.ok(
      html.includes('data-preserve-scroll="true"'),
      'grown load-more render preserves scroll by default'
    );
  });
});
