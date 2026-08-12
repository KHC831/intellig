/**
 * Tier-2 E2E — BRANCHES-tree branch selection jumps the merged multi-root log.
 *
 * Drives the REAL merged loader (`loadAllRootsLog`) over two fixture repos:
 * its branch map is keyed by graphRowKey(hash, root) — `hash\0root` — and the
 * branch-click tip resolution must decompose that composite key back to the
 * bare commit hash. Before the fix the composite key flowed into
 * selectCommit/scrollToCommit, matched no commit node and no webview row, and
 * the click died silently ("selecting a branch does not jump to the commit").
 *
 * Also pins the repo-root preference: a same-named branch in several roots
 * must land on the CLICKED row's repo, not whichever root the map yields
 * first.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, execGit, revParse } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspaces } from '../support/workspaceHelper';
import { getGitToolWindowProvider } from '../support/activatedExtension';
import { graphRowKey } from '../../../src/git-core/graphRowKey';
import type { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';

describe('e2e — branch jump in the merged multi-root log', function () {
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

  it('resolves composite row keys to bare hashes and honors the clicked repo', async () => {
    fixA = await createFixtureRepo({ commits: 1 });
    fixB = await createFixtureRepo({ commits: 1 });

    // Distinct content per repo so no hash can collide across roots.
    fs.writeFileSync(path.join(fixA.rootPath, 'alpha.txt'), 'alpha\n');
    await execGit(fixA.rootPath, ['add', 'alpha.txt']);
    await execGit(fixA.rootPath, ['commit', '-m', 'alpha main tip']);

    fs.writeFileSync(path.join(fixB.rootPath, 'beta.txt'), 'beta\n');
    await execGit(fixB.rootPath, ['add', 'beta.txt']);
    await execGit(fixB.rootPath, ['commit', '-m', 'beta main tip']);
    // A branch that exists ONLY in repo B, with its own tip commit.
    await execGit(fixB.rootPath, ['checkout', '-b', 'b-only']);
    fs.writeFileSync(path.join(fixB.rootPath, 'b-only.txt'), 'b\n');
    await execGit(fixB.rootPath, ['add', 'b-only.txt']);
    await execGit(fixB.rootPath, ['commit', '-m', 'b-only tip']);
    await execGit(fixB.rootPath, ['checkout', fixB.defaultBranch]);

    const aMainTip = await revParse(fixA.rootPath, fixA.defaultBranch);
    const bMainTip = await revParse(fixB.rootPath, fixB.defaultBranch);
    const bOnlyTip = await revParse(fixB.rootPath, 'b-only');

    const [repoA, repoB] = await useFixtureWorkspaces([fixA.rootPath, fixB.rootPath]);
    const rootA = repoA.rootUri.fsPath;
    const rootB = repoB.rootUri.fsPath;

    provider = getGitToolWindowProvider()!;
    assert.ok(provider, 'the tool window provider must be live');

    // Both repos must reach the selector before the merged scope can engage.
    await poll(
      () => provider.repoScope.getAvailableRepositories().length === 2,
      'both repositories to reach the selector'
    );

    // Enter the merged "All Repositories" scope through the production scope
    // event — the same path the selector dropdown fires.
    provider.repoScope.handleRepositorySelection('all');
    await poll(() => {
      const nodes = provider.log.state.commitNodes;
      return (
        nodes.some((n) => n.commit.repoRoot === rootA) &&
        nodes.some((n) => n.commit.repoRoot === rootB)
      );
    }, 'the merged log to interleave both roots');

    // Sanity: the merged load keys its branch map by the composite row key —
    // the exact shape the tip resolution must decompose.
    assert.ok(
      provider.log.state.branchMap.has(graphRowKey(bOnlyTip, rootB)),
      'merged branch map must be keyed by (hash, root)'
    );

    // The BRANCHES-tree selection path: jump to a branch only repo B has.
    provider.navigateToBranch('b-only', rootB);
    let state = provider.getExtendedLogState();
    assert.strictEqual(state.expandedCommit, bOnlyTip, 'jump lands on the BARE b-only tip hash');
    assert.ok(state.selectedCommits.has(bOnlyTip), 'the b-only tip row is selected');

    // Same-named branch in both roots: the clicked row's repo wins.
    provider.navigateToBranch(fixA.defaultBranch, rootA);
    state = provider.getExtendedLogState();
    assert.strictEqual(
      state.expandedCommit,
      aMainTip,
      `${fixA.defaultBranch} in repo A lands on A's tip`
    );

    provider.navigateToBranch(fixB.defaultBranch, rootB);
    state = provider.getExtendedLogState();
    assert.strictEqual(
      state.expandedCommit,
      bMainTip,
      `${fixB.defaultBranch} in repo B lands on B's tip`
    );
  });
});
