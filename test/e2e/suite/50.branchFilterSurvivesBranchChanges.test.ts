/**
 * Tier-2 E2E — a branch filter survives branch changes.
 *
 * With the log filtered to a subset of branches, a branch created, checked
 * out, committed on or deleted from git fires the repository watcher, and the
 * reload must reapply the SAME filter: the graph still shows the selected
 * branch's commits, never an empty "No commits match the current filter".
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getGitToolWindowProvider } from '../support/activatedExtension';
import type { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import type { IWebviewLogFilter } from '../../../src/git-core/gitToolWindow/gitToolWindow.wireTypes';

describe('e2e — a branch filter survives branch changes', function () {
  this.timeout(90_000);

  let fix: Fixture;
  let provider: GitToolWindowProvider;
  let deliveries = 0;
  let origUpdateLogState: GitToolWindowProvider['updateLogState'] | undefined;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (provider) {
      if (origUpdateLogState) {
        (provider as { updateLogState: unknown }).updateLogState = origUpdateLogState;
        origUpdateLogState = undefined;
      }
      provider.applyLogFilter(null);
    }
    await clearWorkspace();
    await fix?.cleanup();
  });

  const poll = async (cond: () => boolean, what: () => string): Promise<void> => {
    for (let i = 0; i < 120 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(cond(), `timed out waiting for ${what()}`);
  };

  /**
   * The panel HTML the provider builds for the current log, as the webview
   * would receive it. Building it consumes the one-shot scroll reset, which
   * belongs to the next real render, so it is put back.
   */
  const panelHtml = (): string => {
    const resetWasPending = provider.log.hasPendingScrollReset();
    const html = provider._getGraphPanelHtml(provider.log.state.commitNodes);
    if (resetWasPending) {
      provider.log.markResetScroll();
    }
    return html;
  };

  const describeState = (): string =>
    `${provider.log.state.commitNodes.length} commits, filter ${JSON.stringify(
      provider.log.state.filter
    )}`;

  /**
   * Run a git change, wait for the watcher to reach the graph, then for the
   * graph to settle into `settled`. A load already in flight when git runs can
   * land first with the old branches; the reload the change triggers follows.
   */
  async function change(args: string[], settled: () => boolean, what: string): Promise<void> {
    const before = deliveries;
    await execGit(fix.rootPath, args);
    await poll(
      () => deliveries > before,
      () => `a reload after git ${args.join(' ')}`
    );
    await poll(settled, () => `${what} after git ${args.join(' ')} (${describeState()})`);
  }

  /** Apply a branch filter and wait for the load it starts to land. */
  async function applyBranchFilter(branches: string[]): Promise<void> {
    const before = deliveries;
    provider.applyLogFilter({ branches } as IWebviewLogFilter);
    await poll(
      () =>
        deliveries > before &&
        JSON.stringify(provider.log.state.filter?.branches) === JSON.stringify(branches),
      () => `the branch filter to apply (${describeState()})`
    );
  }

  it('keeps showing the filtered branch through create, checkout, commit and delete', async () => {
    fix = await createFixtureRepo({ commits: 3 });
    await execGit(fix.rootPath, ['branch', 'side']);
    await useFixtureWorkspace(fix.rootPath);
    provider = getGitToolWindowProvider()!;
    assert.ok(provider, 'the tool window provider must be live');
    await poll(
      () => provider.log.state.commitNodes.length >= 3,
      () => `the initial load (${describeState()})`
    );

    origUpdateLogState = provider.updateLogState.bind(provider);
    (provider as { updateLogState: unknown }).updateLogState = (
      ...args: Parameters<GitToolWindowProvider['updateLogState']>
    ): void => {
      deliveries++;
      origUpdateLogState!(...args);
    };

    await applyBranchFilter([fix.defaultBranch]);
    const showsDefault = (): boolean =>
      provider.log.state.commitNodes.length >= 3 &&
      provider.log.state.filter?.branches?.[0] === fix.defaultBranch;

    const steps: string[][] = [
      ['branch', 'created-later'],
      ['checkout', '-q', 'side'],
      ['checkout', '-q', fix.defaultBranch],
      ['branch', '-D', 'created-later'],
    ];
    for (const step of steps) {
      await change(step, showsDefault, 'the filtered branch');
      assert.ok(
        provider.log.state.commitNodes.length >= 3,
        `after git ${step.join(' ')}: ${describeState()}`
      );
      assert.deepStrictEqual(provider.log.state.filter?.branches, [fix.defaultBranch]);
      assert.ok(!provider.log.state.filter?.branchesNone, 'the filter never becomes "none"');
    }

    fs.writeFileSync(path.join(fix.rootPath, 'more.txt'), 'more\n');
    await execGit(fix.rootPath, ['add', 'more.txt']);
    await change(
      ['commit', '-q', '-m', 'more'],
      () => provider.log.state.commitNodes.length >= 4,
      'the new commit'
    );
    assert.ok(provider.log.state.commitNodes.length >= 4, `after a commit: ${describeState()}`);
  });

  it('keeps showing the rest of the filter when a selected branch is deleted or renamed', async () => {
    fix = await createFixtureRepo({ commits: 3 });
    await execGit(fix.rootPath, ['branch', 'doomed']);
    await execGit(fix.rootPath, ['branch', 'renamed-away']);
    await useFixtureWorkspace(fix.rootPath);
    provider = getGitToolWindowProvider()!;
    await poll(
      () => provider.log.state.commitNodes.length >= 3,
      () => `the initial load (${describeState()})`
    );
    origUpdateLogState = provider.updateLogState.bind(provider);
    (provider as { updateLogState: unknown }).updateLogState = (
      ...args: Parameters<GitToolWindowProvider['updateLogState']>
    ): void => {
      deliveries++;
      origUpdateLogState!(...args);
    };
    await applyBranchFilter([fix.defaultBranch, 'doomed', 'renamed-away']);

    await change(
      ['branch', '-D', 'doomed'],
      () =>
        provider.log.state.commitNodes.length >= 3 &&
        !provider.log.state.filter?.branches?.includes('doomed'),
      'the filter without the deleted branch'
    );
    assert.ok(provider.log.state.commitNodes.length >= 3, `after a delete: ${describeState()}`);

    await change(
      ['branch', '-m', 'renamed-away', 'renamed-to'],
      () =>
        provider.log.state.commitNodes.length >= 3 &&
        !provider.log.state.filter?.branches?.includes('renamed-away'),
      'the filter without the renamed branch'
    );
    assert.ok(provider.log.state.commitNodes.length >= 3, `after a rename: ${describeState()}`);
    assert.deepStrictEqual(
      provider.log.state.filter?.branches,
      [fix.defaultBranch],
      'the filter keeps the branches that still exist'
    );
    const html = panelHtml();
    assert.ok(
      html.includes(`data-f-branches="[&quot;${fix.defaultBranch}&quot;]"`),
      'the filter row shows the surviving branch'
    );
    assert.ok(!html.includes('No commits match the current filter'));
  });

  it('falls back to all branches when every selected branch is gone', async () => {
    fix = await createFixtureRepo({ commits: 3 });
    await execGit(fix.rootPath, ['branch', 'only-one']);
    await useFixtureWorkspace(fix.rootPath);
    provider = getGitToolWindowProvider()!;
    await poll(
      () => provider.log.state.commitNodes.length >= 3,
      () => `the initial load (${describeState()})`
    );
    origUpdateLogState = provider.updateLogState.bind(provider);
    (provider as { updateLogState: unknown }).updateLogState = (
      ...args: Parameters<GitToolWindowProvider['updateLogState']>
    ): void => {
      deliveries++;
      origUpdateLogState!(...args);
    };
    await applyBranchFilter(['only-one']);

    await change(
      ['branch', '-D', 'only-one'],
      () => provider.log.state.commitNodes.length >= 3 && provider.log.state.filter === undefined,
      'all branches'
    );
    assert.ok(provider.log.state.commitNodes.length >= 3, `after the delete: ${describeState()}`);
    assert.strictEqual(provider.log.state.filter, undefined, 'no branch criterion is left');
    const html = panelHtml();
    assert.ok(html.includes('data-f-branches="[]"'), 'the filter row shows all branches');
    assert.ok(!html.includes('No commits match the current filter'));
  });
});
