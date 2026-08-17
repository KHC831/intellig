/**
 * Tier-2 E2E — the Git window's BRANCH filter scopes the Branches tree.
 *
 * Drives the REAL apply-filter path (`applyLogFilter`, the same entry the
 * filter row's webview message lands on) against the ACTIVATED extension, then
 * reads the live BranchTreeProvider. Unit tests cover the wiring function and
 * the tree predicate separately; only this proves the production chain
 * (webview filter → sanitizer → onDidRequestLogFilter → wiring → tree) is
 * actually connected in the running host.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getBranchTreeProvider, getGitToolWindowProvider } from '../support/activatedExtension';
import type { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';
import type { BranchTreeProvider } from '../../../src/branches/BranchTreeProvider';

describe('e2e — the branch filter scopes the Branches tree', function () {
  this.timeout(60_000);

  let fix: Fixture;
  let provider: GitToolWindowProvider;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (provider) {
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

  /** Local-branch row labels currently rendered by the live tree. */
  const localRows = async (tree: BranchTreeProvider): Promise<string[]> => {
    const root = await tree.getChildren();
    const local = root.find((n) => n.label === 'Local');
    assert.ok(local, 'the tree renders a Local category');
    const rows = await tree.getChildren(local);
    return rows.map((r) => String(r.branch?.name ?? r.label));
  };

  it('narrows the tree to the filtered branches and restores on clear', async () => {
    fix = await createFixtureRepo({
      commits: 3,
      branches: [
        { name: 'keep', fromCommit: 1 },
        { name: 'drop', fromCommit: 1 },
      ],
    });
    await useFixtureWorkspace(fix.rootPath);

    provider = getGitToolWindowProvider()!;
    const tree = getBranchTreeProvider()!;
    assert.ok(provider && tree, 'the tool window and branch tree must both be live');
    await poll(() => tree.getRepository() !== undefined, 'the tree to see the fixture repo');

    const before = await localRows(tree);
    assert.ok(
      before.includes('keep') && before.includes('drop') && before.includes(fix.defaultBranch),
      `unfiltered tree lists every local branch (got ${before.join(', ')})`
    );

    // The production filter entry — exactly what the filter row posts.
    provider.applyLogFilter({ branches: ['keep'] });
    const filtered = await localRows(tree);

    assert.ok(filtered.includes('keep'), 'the filtered branch stays listed');
    assert.ok(
      filtered.includes(fix.defaultBranch),
      'the checked-out branch survives the filter (the tree must not hide HEAD)'
    );
    assert.ok(
      !filtered.includes('drop'),
      `an unselected branch is hidden from the tree (got ${filtered.join(', ')})`
    );

    provider.applyLogFilter(null);
    const restored = await localRows(tree);
    assert.ok(
      restored.includes('drop') && restored.includes('keep'),
      'clearing the filter restores every branch'
    );
  });
});
