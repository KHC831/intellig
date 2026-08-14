/**
 * Tier-2 E2E — the BRANCHES tree follows the repository selector's scope.
 *
 * Drives the REAL selector events (`handleRepositorySelection`,
 * `handleVisibleRepositoriesSelection`) over two fixture repos and asserts the
 * activated BranchTreeProvider narrows in lockstep: a dropdown selection shows
 * only that repo's group row, a checked subset shows those repos, and "All
 * Repositories" restores every row. Before the fix the tree ignored the scope
 * event entirely — the wiring recorded a fallback repo but never changed what
 * rendered, so selecting a repo visibly did nothing in the Branches view.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspaces } from '../support/workspaceHelper';
import { getBranchTreeProvider, getGitToolWindowProvider } from '../support/activatedExtension';
import type { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';

describe('e2e — Branches tree follows the repository scope', function () {
  this.timeout(60_000);

  let fixA: Fixture;
  let fixB: Fixture;
  let provider: GitToolWindowProvider;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (provider && provider.repoScope.getAvailableRepositories().length > 0) {
      // Leave the scope in the specific-repo shape later suites inherit.
      provider.repoScope.handleRepositorySelection(0);
    }
    await clearWorkspace();
    if (fixA) {
      await fixA.cleanup();
    }
    if (fixB) {
      await fixB.cleanup();
    }
  });

  const poll = async (cond: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 100 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(cond(), `timed out waiting for ${what}`);
  };

  it('narrows to the selected repo, honors a checked subset, and restores on all', async () => {
    fixA = await createFixtureRepo({ commits: 1 });
    fixB = await createFixtureRepo({ commits: 1 });

    const [repoA, repoB] = await useFixtureWorkspaces([fixA.rootPath, fixB.rootPath]);
    const rootA = repoA.rootUri.fsPath;
    const rootB = repoB.rootUri.fsPath;

    provider = getGitToolWindowProvider()!;
    assert.ok(provider, 'the tool window provider must be live');
    const branchTree = getBranchTreeProvider()!;
    assert.ok(branchTree, 'the branch tree provider must be live');

    await poll(
      () => provider.repoScope.getAvailableRepositories().length === 2,
      'both repositories to reach the selector'
    );

    const rootLabels = async (): Promise<string[]> =>
      (await branchTree.getChildren()).map((n) => String(n.label));
    const labelA = rootA.split('/').filter(Boolean).pop()!;
    const labelB = rootB.split('/').filter(Boolean).pop()!;

    // Merged "All Repositories" scope → both repo group rows.
    provider.repoScope.handleRepositorySelection('all');
    assert.deepStrictEqual(await rootLabels(), [labelA, labelB], 'all scope shows both repos');

    // Dropdown selection → only that repo's row remains (repo context kept).
    provider.repoScope.handleRepositorySelection(1);
    assert.deepStrictEqual(await rootLabels(), [labelB], 'selection hides the non-selected repo');
    const [repoRow] = await branchTree.getChildren();
    assert.strictEqual(repoRow.itemType, 'repository', 'the selected repo keeps its group row');
    const icon = repoRow.iconPath as { id?: string; color?: { id?: string } };
    assert.strictEqual(icon.color?.id, 'charts.green', 'repo row icon renders the single green');

    // Checked subset through the Repository filter → exactly those repos.
    provider.repoScope.handleVisibleRepositoriesSelection([rootA, rootB]);
    assert.deepStrictEqual(await rootLabels(), [labelA, labelB], 'full subset shows both');
    provider.repoScope.handleVisibleRepositoriesSelection([rootA]);
    assert.deepStrictEqual(await rootLabels(), [labelA], 'single-checked collapses to that repo');

    // Back to all → every row returns.
    provider.repoScope.handleRepositorySelection('all');
    assert.deepStrictEqual(await rootLabels(), [labelA, labelB], 'all scope restores both rows');
  });
});
