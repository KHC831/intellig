/**
 * Tier-2 E2E — the Branches-window flow a dogfood pass would walk, end to end.
 *
 * Chains the three behaviors a user exercises in one sitting against real git
 * fixtures in a two-root workspace:
 *   1. pick a repository  → the tree lists that repo only;
 *   2. click one of its branches whose tip sits BELOW the loaded page → the
 *      graph loads far enough back and selects it;
 *   3. whatever happens, the click is never a silent no-op — either the target
 *      becomes a selected row, or the user is told why not.
 *
 * (3) is asserted as an either/or on purpose: growth is unavailable in the
 * merged all-roots scope, so the honest invariant is "jump or tell me", which
 * holds in both scopes. The silent dead click is what the user reported.
 *
 * Not covered here (still human): actual pixels — icon color rendering, theme
 * contrast, and whether the graph visibly scrolls rather than merely selecting.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

import { Fixture, createFixtureRepo, revParse } from '../support/gitFixture';
import { clearWorkspace, useFixtureWorkspaces } from '../support/workspaceHelper';
import { getBranchTreeProvider, getGitToolWindowProvider } from '../support/activatedExtension';
import type { GitToolWindowProvider } from '../../../src/git-core/gitToolWindow/GitToolWindowProvider';

/** Comfortably more than the 100-commit initial page. */
const DEEP_HISTORY = 130;

describe('e2e — Branches window user flow (repo scope + branch jump)', function () {
  this.timeout(180_000);

  let fixA: Fixture;
  let fixB: Fixture;
  let provider: GitToolWindowProvider;
  let warnings: string[] = [];
  let restoreWarning: (() => void) | undefined;

  beforeEach(() => {
    warnings = [];
    // Capture user-facing warnings so "the click told the user something" is
    // assertable; the bundle calls through this same vscode module instance.
    const original = vscode.window.showWarningMessage;
    (vscode.window as { showWarningMessage: unknown }).showWarningMessage = ((message: string) => {
      warnings.push(message);
      return Promise.resolve(undefined);
    }) as unknown as typeof vscode.window.showWarningMessage;
    restoreWarning = (): void => {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
    };
  });

  afterEach(async () => {
    restoreWarning?.();
    restoreWarning = undefined;
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    if (provider && provider.repoScope.getAvailableRepositories().length > 0) {
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
    for (let i = 0; i < 200 && !cond(); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(cond(), `timed out waiting for ${what}`);
  };

  const loadedHashes = (): Set<string> =>
    new Set(provider.log.state.commitNodes.map((n) => n.commit.hash));

  it('selects a repo, lists only its branches, and jumps to a deep branch tip', async () => {
    fixA = await createFixtureRepo({ commits: 2 });
    fixB = await createFixtureRepo({
      commits: DEEP_HISTORY,
      branches: [{ name: 'deep-branch', fromCommit: 2 }],
    });
    const deepTip = await revParse(fixB.rootPath, 'deep-branch');

    const [repoA, repoB] = await useFixtureWorkspaces([fixA.rootPath, fixB.rootPath]);
    provider = getGitToolWindowProvider()!;
    const tree = getBranchTreeProvider()!;
    assert.ok(provider && tree, 'the tool window and branch tree must both be live');
    await poll(
      () => provider.repoScope.getAvailableRepositories().length === 2,
      'both repositories to reach the selector'
    );

    // 1. Pick repo B in the selector — the tree must drop repo A's row.
    const indexOfB = provider.repoScope
      .getAvailableRepositories()
      .findIndex((r) => r.rootUri.fsPath === repoB.rootUri.fsPath);
    provider.repoScope.handleRepositorySelection(indexOfB);

    const rootRows = await tree.getChildren();
    assert.deepStrictEqual(
      rootRows.map((r) => String(r.label)),
      [String(rootRows[0]?.label)].filter(Boolean),
      'exactly one repository row remains'
    );
    assert.strictEqual(
      rootRows[0]?.repository?.rootUri.fsPath,
      repoB.rootUri.fsPath,
      'the remaining row is the repo the user picked'
    );
    assert.ok(
      !rootRows.some((r) => r.repository?.rootUri.fsPath === repoA.rootUri.fsPath),
      'the unselected repo is hidden from the Branches window'
    );

    // Wait for repo B's OWN load to land: a stale merged/repo-A snapshot also
    // has commitNodes, and its branch map knows nothing of deep-branch.
    const branchMapKnows = (name: string): boolean =>
      [...provider.log.state.branchMap.values()].some((refs) => refs.some((r) => r.name === name));
    await poll(() => branchMapKnows('deep-branch'), "repo B's log (and branch map) to load");

    // 2. The deep branch tip starts outside the loaded page.
    assert.ok(!loadedHashes().has(deepTip), 'precondition: the deep tip is not loaded yet');

    // 3. Click it the way the tree does, and never accept silence.
    await provider.navigateToBranch('deep-branch', repoB.rootUri.fsPath);

    const jumped = (): boolean =>
      loadedHashes().has(deepTip) && provider.getExtendedLogState().expandedCommit === deepTip;
    await poll(() => jumped() || warnings.length > 0, 'the click to jump or explain itself');

    assert.ok(
      jumped(),
      `the deep branch tip must load and be selected in single-repo scope (warnings: ${warnings.join(' | ') || 'none'})`
    );
  });

  it('never dies silently on a branch whose tip cannot be reached', async () => {
    fixA = await createFixtureRepo({ commits: 2 });
    fixB = await createFixtureRepo({
      commits: DEEP_HISTORY,
      branches: [{ name: 'deep-branch', fromCommit: 2 }],
    });
    const deepTip = await revParse(fixB.rootPath, 'deep-branch');

    const [, repoB] = await useFixtureWorkspaces([fixA.rootPath, fixB.rootPath]);
    provider = getGitToolWindowProvider()!;
    await poll(
      () => provider.repoScope.getAvailableRepositories().length === 2,
      'both repositories to reach the selector'
    );

    // Merged all-roots scope: the window cannot grow here, so the click must
    // surface a warning rather than doing nothing at all.
    provider.repoScope.handleRepositorySelection('all');
    await poll(() => provider.log.state.commitNodes.length > 0, 'the merged log to paint');
    assert.ok(!loadedHashes().has(deepTip), 'precondition: the deep tip is not loaded yet');

    await provider.navigateToBranch('deep-branch', repoB.rootUri.fsPath);
    await poll(
      () => loadedHashes().has(deepTip) || warnings.length > 0,
      'the click to jump or warn'
    );

    const jumped = loadedHashes().has(deepTip);
    assert.ok(
      jumped || warnings.some((w) => w.includes('deep-branch') || w.includes('not loaded')),
      'an unreachable branch click must jump or warn — never both nothing'
    );
  });
});
