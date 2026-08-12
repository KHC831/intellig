/**
 * Tier-2 E2E — the active log filter survives a repository-scope reload.
 *
 * Drives the REAL provider + the production `wireRepositorySelection` wiring:
 * apply a search filter (the log narrows to the matching commit), then fire a
 * repository-selection scope event — the same event the selector dropdown and
 * the repository filter emit. The scope reload must reapply the active filter;
 * an unfiltered reload silently widens the log back to all commits while the
 * filter row still shows its values.
 *
 * `updateLogState` calls are counted through an instance wrapper so the test
 * distinguishes "the reload ran and stayed filtered" from "no reload ran at
 * all" (the fingerprint gate can skip identical repaints downstream, but the
 * loader always calls updateLogState with what it fetched).
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getGitToolWindowProvider, getServices } from '../support/activatedExtension';
import type { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import type { IWebviewLogFilter } from '../../../src/git-core/gitToolWindow/gitToolWindow.wireTypes';

const NEEDLE = 'needle-e2e-marker';

describe('e2e — log filter survives repository-scope reloads', function () {
  this.timeout(45_000);

  let fix: Fixture;
  let provider: GitToolWindowProvider;
  let origUpdateLogState: GitToolWindowProvider['updateLogState'] | undefined;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (provider) {
      if (origUpdateLogState) {
        (provider as { updateLogState: unknown }).updateLogState = origUpdateLogState;
        origUpdateLogState = undefined;
      }
      // Clear the filter so later suites see the default unfiltered state.
      provider.applyLogFilter(null);
    }
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  const poll = async (cond: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 80 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(cond(), `timed out waiting for ${what}`);
  };

  it('scope-selection reload keeps the active search filter applied', async () => {
    fix = await createFixtureRepo({ commits: 2 });
    fs.writeFileSync(path.join(fix.rootPath, 'marker.txt'), 'marked\n');
    await execGit(fix.rootPath, ['add', 'marker.txt']);
    await execGit(fix.rootPath, ['commit', '-m', `add marker (${NEEDLE})`]);
    await useFixtureWorkspace(fix.rootPath);
    assert.strictEqual(getServices()!.gitService.getRepositories().length, 1);

    provider = getGitToolWindowProvider()!;
    assert.ok(provider, 'the tool window provider must be live');

    // Initial (unfiltered) load: all three commits present.
    await poll(() => provider.log.state.commitNodes.length >= 3, 'the initial unfiltered load');

    // Apply the search filter through the production message path.
    provider.applyLogFilter({ searchText: NEEDLE } as IWebviewLogFilter);
    await poll(
      () => provider.log.state.commitNodes.length === 1,
      `the filtered load (got ${provider.log.state.commitNodes.length} commits)`
    );

    // Count loader deliveries so the scope reload below is provably OBSERVED —
    // an unchanged list alone can't distinguish "stayed filtered" from "the
    // reload never happened".
    let deliveries = 0;
    origUpdateLogState = provider.updateLogState.bind(provider);
    (provider as { updateLogState: unknown }).updateLogState = (
      ...args: Parameters<GitToolWindowProvider['updateLogState']>
    ): void => {
      deliveries++;
      origUpdateLogState!(...args);
    };

    // The selector dropdown's scope event — the production
    // wireRepositorySelection listener reloads the log for that scope.
    provider.repoScope.handleRepositorySelection(0);

    await poll(() => deliveries >= 1, 'the scope-triggered reload to deliver');
    // Let any trailing coalesced deliveries land before judging the outcome.
    await new Promise((r) => setTimeout(r, 500));

    const nodes = provider.log.state.commitNodes;
    assert.strictEqual(
      nodes.length,
      1,
      `the scope reload must reapply the active filter (got ${nodes.length} commits: ` +
        `${JSON.stringify(nodes.map((n) => n.commit.message))})`
    );
    assert.ok(
      nodes[0].commit.message.includes(NEEDLE),
      `the surviving commit must be the filtered one; got "${nodes[0].commit.message}"`
    );
    assert.ok(
      provider.log.state.filter?.searchText === NEEDLE,
      'the filter state itself must still be active'
    );
  });
});
