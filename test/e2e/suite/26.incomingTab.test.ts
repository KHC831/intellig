/**
 * Tier-2 E2E — the Incoming tab refreshes when activated (real host + real git).
 *
 * Regression guard for the bug where the Incoming tab showed "Up to date with
 * upstream. No incoming commits." regardless of the real state, because nothing
 * ever called `IncomingTab.refresh()`. Here we put the CURRENT branch genuinely
 * one commit behind its upstream (advance the bare remote via a throwaway clone,
 * then fetch), focus the Incoming tab through the real provider, and assert the
 * tab surfaces the incoming commit. Driving `provider.focusTab('incoming')`
 * exercises the production `onActiveTabChanged → refresh` wiring in the host.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getServices, getGitToolWindowProvider } from '../support/activatedExtension';

interface IncomingStateSurface {
  upstream?: string;
  incomingCount: number;
  noUpstream: boolean;
  commits: { hash: string }[];
}
interface ProviderIncomingSurface {
  focusTab(tab: string): Promise<void>;
  _incomingTab?: { getState(): IncomingStateSurface };
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('e2e — Incoming tab refreshes on activation (real git state)', function () {
  this.timeout(45_000);

  let fix: Fixture;

  afterEach(async () => {
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  it('surfaces the incoming commit after the tab is focused', async () => {
    fix = await createFixtureRepo({ commits: 2, withRemote: true });
    assert.ok(fix.remotePath, 'fixture: expected a remote');

    // Current branch (main) tracks origin/main.
    await execGit(fix.rootPath, ['push', '-u', 'origin', fix.defaultBranch]);

    // Advance origin/<main> by one commit via a throwaway clone.
    const helper = path.join(path.dirname(fix.remotePath), `helper-${Date.now()}`);
    await execGit(fix.rootPath, ['clone', `file://${fix.remotePath}`, helper]);
    await execGit(helper, ['config', 'user.name', 'IntelliG E2E']);
    await execGit(helper, ['config', 'user.email', 'e2e@intellig.test']);
    fs.writeFileSync(path.join(helper, 'incoming.txt'), 'remote\n');
    await execGit(helper, ['add', 'incoming.txt']);
    await execGit(helper, ['commit', '-m', 'incoming commit']);
    await execGit(helper, ['push', 'origin', fix.defaultBranch]);
    const incomingHash = (await execGit(helper, ['rev-parse', 'HEAD'])).stdout.trim();
    fs.rmSync(helper, { recursive: true, force: true });

    await execGit(fix.rootPath, ['fetch', 'origin']); // local main now behind by 1

    // Precondition via raw git, so a setup error is distinct from a tab bug.
    const behind = (
      await execGit(fix.rootPath, [
        'rev-list',
        '--count',
        `${fix.defaultBranch}..origin/${fix.defaultBranch}`,
      ])
    ).stdout.trim();
    assert.strictEqual(behind, '1', 'precondition: local branch is exactly 1 behind upstream');

    const repo = await useFixtureWorkspace(fix.rootPath);
    await getServices()!.gitService.reloadRepository(repo);

    const provider = getGitToolWindowProvider() as unknown as ProviderIncomingSurface;
    assert.ok(provider, 'tool-window provider available');

    await provider.focusTab('incoming');
    await waitFor(() => (provider._incomingTab?.getState().incomingCount ?? 0) === 1);

    const state = provider._incomingTab!.getState();
    assert.strictEqual(state.noUpstream, false, 'upstream is configured');
    assert.strictEqual(
      state.upstream,
      `origin/${fix.defaultBranch}`,
      'upstream resolved (not the literal placeholder)'
    );
    assert.strictEqual(state.incomingCount, 1, 'one incoming commit counted');
    assert.deepStrictEqual(
      state.commits.map((c) => c.hash),
      [incomingHash],
      'the incoming commit is surfaced in the tab'
    );
  });
});
