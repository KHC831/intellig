/**
 * Real-git integration for the Incoming tab's data path.
 *
 * Drives the production pieces — `IncomingOutgoingOps.getForCurrentBranch`
 * (`git rev-parse @{upstream}` + `git rev-list --left-right --count`) and
 * `StashTagHistoryOps.getLog` (the upstream/HEAD set-difference) — through the
 * real `IncomingTab.refresh()` against a live repo whose branch is genuinely
 * behind its upstream. This is the end-to-end proof that the tab surfaces an
 * incoming commit; mock unit tests can't catch a wrong git invocation here.
 *
 * The upstream-behind state is built without a network: stage the incoming
 * commit, point `refs/remotes/origin/main` at it, then reset the local branch
 * back one — so `main` is one commit behind `origin/main`.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { IncomingOutgoingOps } from '../../../src/git-core/ops/IncomingOutgoingOps';
import { StashTagHistoryOps } from '../../../src/git-core/ops/StashTagHistoryOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { createGitCli } from '../../../src/git-core/gitCli';
import { IncomingTab } from '../../../src/git-core/gitToolWindow/tabs/IncomingTab';
import type { IIncomingDataSource } from '../../../src/git-core/gitToolWindow/tabs/IncomingTab';
import type { IIncomingOutgoing } from '../../../src/git-core/ops/IncomingOutgoingOps';
import type { ILogOptions, IRepository } from '../../../src/git-core/interfaces/IGitService';

const NO_UPSTREAM: IIncomingOutgoing = {
  branch: 'HEAD',
  incoming: 0,
  outgoing: 0,
  noUpstream: true,
};

describe('Incoming tab — real git (data path end-to-end)', function () {
  this.timeout(120000);

  let dir: string;
  const repo = (): IRepository => ({ rootUri: { fsPath: dir } }) as unknown as IRepository;

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  }
  function commitFile(name: string, content: string, message: string): string {
    fs.writeFileSync(path.join(dir, name), content);
    git('add', '--', name);
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  }

  function makeTab(): IncomingTab {
    const ctx = {
      gitCli: createGitCli(),
      invalidateCache: () => undefined,
      fireDidFetch: () => undefined,
    } as unknown as IGitOpsContext;
    const io = new IncomingOutgoingOps(ctx);
    const log = new StashTagHistoryOps(ctx);
    const data: IIncomingDataSource = {
      getIncomingOutgoing: (r: IRepository) => io.getForCurrentBranch(r).unwrapOr(NO_UPSTREAM),
      getLog: (r: IRepository, options?: ILogOptions) => log.getLog(r, options).unwrapOr([]),
    };
    return new IncomingTab(data, { getRepo: () => repo() });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intellig-incoming-'));
    git('init', '-q');
    git('symbolic-ref', 'HEAD', 'refs/heads/main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    // A fake remote: only its config (fetch refspec) is needed so @{upstream}
    // resolves refs/heads/main → refs/remotes/origin/main. No network happens.
    git('remote', 'add', 'origin', path.join(dir, '.git'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the incoming commit when the branch is behind its upstream', async () => {
    commitFile('base.txt', 'base\n', 'base commit');
    const incomingHash = commitFile('incoming.txt', 'new\n', 'incoming commit');
    // origin/main = base+incoming; local main reset back to base → behind by 1.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('reset', '--hard', 'HEAD~1');
    git('branch', '--set-upstream-to=origin/main', 'main');

    const tab = makeTab();
    await tab.refresh();
    const state = tab.getState();

    assert.strictEqual(state.noUpstream, false, 'upstream is configured');
    assert.strictEqual(state.upstream, 'origin/main', 'upstream resolved (not the placeholder)');
    assert.strictEqual(state.incomingCount, 1, 'one incoming commit counted');
    assert.deepStrictEqual(
      state.commits.map((c) => c.hash),
      [incomingHash],
      'the incoming commit is listed'
    );
    assert.strictEqual(state.error, undefined);
  });

  it('reports up-to-date (no commits) but keeps the resolved upstream when level', async () => {
    commitFile('base.txt', 'base\n', 'base commit');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD'); // level
    git('branch', '--set-upstream-to=origin/main', 'main');

    const tab = makeTab();
    await tab.refresh();
    const state = tab.getState();

    assert.strictEqual(state.noUpstream, false);
    assert.strictEqual(
      state.upstream,
      'origin/main',
      'resolved upstream, not the literal placeholder'
    );
    assert.strictEqual(state.incomingCount, 0);
    assert.deepStrictEqual(state.commits, []);
  });

  it('reports no-upstream for a branch with no tracking ref', async () => {
    commitFile('base.txt', 'base\n', 'base commit');
    git('checkout', '-q', '-b', 'local-only');

    const tab = makeTab();
    await tab.refresh();
    const state = tab.getState();

    assert.strictEqual(state.noUpstream, true, 'no upstream configured → noUpstream');
    assert.deepStrictEqual(state.commits, []);
  });
});
