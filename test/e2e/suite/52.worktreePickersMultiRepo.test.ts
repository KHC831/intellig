/**
 * Tier-2 E2E — the branch menu's worktree pickers in a window with several
 * repositories list the worktrees of the repository the right-clicked branch
 * belongs to, not of the Branches tree's current repository.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { createFixtureRepo, execGit, Fixture } from '../support/gitFixture';
import { stubPrompts, PromptStubs } from '../support/stubs';
import { useFixtureWorkspaces, clearWorkspace } from '../support/workspaceHelper';
import { getBranchTreeProvider, getGitToolWindowProvider } from '../support/activatedExtension';

describe('e2e — the branch menu worktree pickers in a multi-repository window', function () {
  this.timeout(60_000);

  let fixA: Fixture;
  let fixB: Fixture;
  let stubs: PromptStubs | undefined;

  afterEach(async () => {
    stubs?.restore();
    stubs = undefined;
    await clearWorkspace();
    await fixA?.cleanup();
    await fixB?.cleanup();
  });

  it("Open and Remove Worktree… on a branch list the worktrees of THAT branch's repository", async () => {
    fixA = await createFixtureRepo();
    fixB = await createFixtureRepo();
    const besideA = (n: string): string => path.join(path.dirname(fixA.rootPath), n);
    const besideB = (n: string): string => path.join(path.dirname(fixB.rootPath), n);
    for (const n of ['a-one', 'a-two', 'a-three']) {
      await execGit(fixA.rootPath, ['worktree', 'add', '-b', n, besideA(n), 'HEAD']);
    }
    await execGit(fixB.rootPath, ['worktree', 'add', '-b', 'b-one', besideB('b-one'), 'HEAD']);
    const [repoA, repoB] = await useFixtureWorkspaces([fixA.rootPath, fixB.rootPath]);
    assert.ok(repoA && repoB, 'both repositories are open');

    // Show every repository: an earlier suite may have left the log scoped.
    const gitWindow = getGitToolWindowProvider()!;
    const deadline = Date.now() + 15_000;
    while (gitWindow.repoScope.getAvailableRepositories().length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    gitWindow.repoScope.handleRepositorySelection(0);

    const provider = getBranchTreeProvider()!;
    // The tree's own "current" repository is the OTHER one.
    provider.setRepository(repoB);
    const root = await provider.getChildren();
    const nodeA = root.find(
      (n) =>
        n.itemType === 'repository' &&
        fs.realpathSync.native(n.repository!.rootUri.fsPath) ===
          fs.realpathSync.native(fixA.rootPath)
    );
    assert.ok(nodeA, `repository A's node: ${root.map((n) => String(n.label)).join(', ')}`);
    const local = (await provider.getChildren(nodeA)).find((n) => n.label === 'Local');
    const branchRow = (await provider.getChildren(local)).find(
      (n) => n.branch?.name === fixA.defaultBranch
    );
    assert.ok(branchRow, "a row for repository A's default branch");

    let offered: string[] = [];
    stubs = stubPrompts({
      quickPick: (items: unknown) => {
        offered = (items as Array<{ description?: string }>)
          .map((i) => i.description ?? '')
          .filter((d) => d.length > 0);
        return undefined;
      },
    });
    await vscode.commands.executeCommand('intellig.branch.removeWorktree', branchRow);

    const real = (p: string): string => fs.realpathSync.native(p);
    const offeredPaths = offered
      .map((d) => d.split('  ').pop()!)
      .map(real)
      .sort();
    assert.deepStrictEqual(
      offeredPaths,
      ['a-one', 'a-two', 'a-three'].map((n) => real(besideA(n))).sort(),
      `offered: ${JSON.stringify(offered)}`
    );

    offered = [];
    await vscode.commands.executeCommand('intellig.branch.openWorktree', branchRow);
    assert.deepStrictEqual(
      offered
        .map((d) => d.split('  ').pop()!)
        .map(real)
        .sort(),
      [fixA.rootPath, ...['a-one', 'a-two', 'a-three'].map(besideA)].map(real).sort(),
      `Open Worktree… offered: ${JSON.stringify(offered)}`
    );
  });
});
