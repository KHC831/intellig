/**
 * Tier-2 E2E — a branch click jumps to the tip even when the tip is OUTSIDE
 * the loaded commit window.
 *
 * The log paints one bounded page (GRAPH_INITIAL_PAGE = 100 commits), but the
 * branch map is built from `getBranches` — every ref, regardless of whether
 * its tip made the page. Clicking an older branch therefore resolves a real
 * tip hash whose ROW was never loaded: `selectCommit` stamps the state and the
 * webview is told to scroll to a row that does not exist, so the user sees
 * nothing happen ("selecting a branch does not jump to that branch").
 *
 * The assertions here deliberately check the loaded NODE list, not just
 * `expandedCommit` — selection state is stamped unconditionally, so an
 * expandedCommit assertion passes while the UI does nothing (the blind spot
 * that let this ship). A same-window branch is exercised first as the positive
 * control: if that one ever fails, the harness is broken, not the feature.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, revParse } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspace } from '../support/workspaceHelper';
import { getGitToolWindowProvider } from '../support/activatedExtension';
import type { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';

/** Comfortably more than the 100-commit initial page. */
const COMMIT_COUNT = 130;

describe('e2e — branch jump reaches a tip outside the loaded window', function () {
  this.timeout(180_000);

  let fix: Fixture;
  let provider: GitToolWindowProvider;

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await clearWorkspace();
    if (fix) {
      await fix.cleanup();
    }
  });

  const poll = async (cond: () => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 200 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(cond(), `timed out waiting for ${what}`);
  };

  const loadedHashes = (): Set<string> =>
    new Set(provider.log.state.commitNodes.map((n) => n.commit.hash));

  it('loads the window far enough to select an older branch tip', async () => {
    // `old-branch` sits ~127 commits back — far outside the first page.
    fix = await createFixtureRepo({
      commits: COMMIT_COUNT,
      branches: [{ name: 'old-branch', fromCommit: 2 }],
    });
    const oldTip = await revParse(fix.rootPath, 'old-branch');
    const headTip = await revParse(fix.rootPath, fix.defaultBranch);

    await useFixtureWorkspace(fix.rootPath);
    provider = getGitToolWindowProvider()!;
    assert.ok(provider, 'the tool window provider must be live');

    // The provider outlives workspace swaps, so a previous suite's rows can
    // still be painted: wait for THIS repository's first page.
    await poll(() => loadedHashes().has(headTip), 'the log to paint its first page');

    // Positive control: the tip of the current branch IS on the first page, so
    // this click must land on a real row.
    await provider.navigateToBranch(fix.defaultBranch, fix.rootPath);
    assert.ok(
      loadedHashes().has(headTip),
      'positive control: the default branch tip is a loaded row'
    );
    assert.strictEqual(
      provider.getExtendedLogState().expandedCommit,
      headTip,
      'positive control: the default branch tip is selected'
    );

    // The regression: the older branch tip is NOT on the first page.
    assert.ok(
      !loadedHashes().has(oldTip),
      'precondition: the old branch tip starts outside the loaded window'
    );

    await provider.navigateToBranch('old-branch', fix.rootPath);

    await poll(() => loadedHashes().has(oldTip), 'the window to grow far enough to hold the tip');
    assert.ok(
      loadedHashes().has(oldTip),
      'the old branch tip must become a LOADED row — selecting a row that was never ' +
        'loaded is the silent no-op the user sees as "the branch click does nothing"'
    );
    assert.strictEqual(
      provider.getExtendedLogState().expandedCommit,
      oldTip,
      'the old branch tip is the selected/expanded commit'
    );
  });
});
