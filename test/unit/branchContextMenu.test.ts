/**
 * Unit tests for branch context menu configuration in package.json.
 *
 * Verifies that the view/item/context menu contributions are correctly
 * configured for each branch type: current local branch, non-current
 * local branch, and remote branch.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MenuEntry {
  command: string;
  when: string;
  group: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Load and parse the package.json file from the project root.
 */
function loadPackageJson(): Record<string, unknown> {
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const content = fs.readFileSync(packageJsonPath, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

/**
 * Get the view/item/context menu entries from package.json.
 */
function getMenuEntries(): MenuEntry[] {
  const pkg = loadPackageJson();
  const contributes = pkg.contributes as Record<string, unknown>;
  const menus = contributes.menus as Record<string, unknown>;
  return menus['view/item/context'] as MenuEntry[];
}

/**
 * Filter menu entries by a specific viewItem context value.
 */
function getEntriesForContext(entries: MenuEntry[], contextValue: string): MenuEntry[] {
  return entries.filter((e) => e.when === `viewItem == ${contextValue}`);
}

/**
 * Parse the group string into section name and order number.
 * e.g., "1_branchOps@1" -> { section: "1_branchOps", order: 1 }
 */
function parseGroup(group: string): { section: string; order: number } {
  const [section, orderStr] = group.split('@');
  return { section, order: parseInt(orderStr, 10) };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Branch Context Menu - package.json Menu Contributions', () => {
  let allEntries: MenuEntry[];

  before(() => {
    allEntries = getMenuEntries();
  });

  // ─── Current Local Branch (intellig.localBranchCurrent) ───────────────────

  describe('Current Local Branch Menu (intellig.localBranchCurrent)', () => {
    let entries: MenuEntry[];

    before(() => {
      entries = getEntriesForContext(allEntries, 'intellig.localBranchCurrent');
    });

    it('should have exactly 6 menu items', () => {
      // intellig.branch.focusOnGraph (inline) + intellig.branch.toggleFavorite
      // (4_favorite) added on top of the four branch-op entries.
      assert.strictEqual(entries.length, 6, `Expected 6 items, got ${entries.length}`);
    });

    it('should include Toggle Favorite in section 4_favorite@1', () => {
      const entry = entries.find((e) => e.command === 'intellig.branch.toggleFavorite');
      assert.ok(entry, 'intellig.branch.toggleFavorite should be present for current branch');
      assert.strictEqual(entry.group, '4_favorite@1');
    });

    it('should include Focus on Graph in section inline@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.focusOnGraph' && e.group === 'inline@1'
      );
      assert.ok(entry, 'intellig.branch.focusOnGraph should be at inline@1 for current branch');
    });

    it('should include New Branch from in section 1_branchOps@1', () => {
      const entry = entries.find((e) => e.command === 'intellig.branch.newBranchFrom');
      assert.ok(entry, 'intellig.branch.newBranchFrom should be present');
      assert.strictEqual(entry.group, '1_branchOps@1');
    });

    it('should include Update in section 2_sync@1', () => {
      const entry = entries.find((e) => e.command === 'intellig.branch.update');
      assert.ok(entry, 'intellig.branch.update should be present');
      assert.strictEqual(entry.group, '2_sync@1');
    });

    it('should include Push in section 2_sync@2', () => {
      const entry = entries.find((e) => e.command === 'intellig.branch.push');
      assert.ok(entry, 'intellig.branch.push should be present');
      assert.strictEqual(entry.group, '2_sync@2');
    });

    it('should include Rename in section 3_manage@1', () => {
      const entry = entries.find((e) => e.command === 'intellig.branch.rename');
      assert.ok(entry, 'intellig.branch.rename should be present');
      assert.strictEqual(entry.group, '3_manage@1');
    });

    it('should NOT include Checkout command', () => {
      const entry = entries.find((e) => e.command === 'intellig.branch.checkout');
      assert.strictEqual(entry, undefined, 'Checkout should not appear for current branch');
    });

    it('should NOT include Delete command', () => {
      const entry = entries.find((e) => e.command === 'intellig.branch.delete');
      assert.strictEqual(entry, undefined, 'Delete should not appear for current branch');
    });

    it('should have groups ordered correctly (1_branchOps < 2_sync < 3_manage)', () => {
      const sections = entries.map((e) => parseGroup(e.group).section);
      const uniqueSections = [...new Set(sections)];
      assert.deepStrictEqual(uniqueSections.sort(), [
        '1_branchOps',
        '2_sync',
        '3_manage',
        '4_favorite',
        'inline',
      ]);
    });
  });

  // ─── Non-Current Local Branch (intellig.localBranch) ──────────────────────

  describe('Non-Current Local Branch Menu (intellig.localBranch)', () => {
    let entries: MenuEntry[];

    before(() => {
      entries = getEntriesForContext(allEntries, 'intellig.localBranch');
    });

    it('should have exactly 17 menu items', () => {
      // intellig.branch.focusOnGraph (inline) + intellig.branch.toggleFavorite
      // (6_favorite) on top of the branch-op entries, including the three
      // worktree commands (New / Open / Remove Worktree…) and the align-local
      // Update Selected entry (4_sync).
      assert.strictEqual(entries.length, 17, `Expected 17 items, got ${entries.length}`);
    });

    it('should include Remove Worktree next to New Worktree (3_worktree@2)', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.removeWorktree' && e.group === '3_worktree@2'
      );
      assert.ok(entry, 'intellig.branch.removeWorktree should be at 3_worktree@2');
    });

    it('should include New Worktree in its own section between Integrate and Sync (3_worktree@1)', () => {
      // git4idea places "Create New Working Tree" in its own group between the
      // Integrate (Rebase/Merge) and Sync (Update/Push) sections
      // (Git.Branch.Backend, intellij.vcs.git.backend.xml). "3_worktree" sorts
      // after "3_integrate" and before "4_sync".
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.newWorktree' && e.group === '3_worktree@1'
      );
      assert.ok(entry, 'intellig.branch.newWorktree should be at 3_worktree@1');
    });

    it('should include Open Worktree in section 1_branchOps@5', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.openWorktree' && e.group === '1_branchOps@5'
      );
      assert.ok(entry, 'intellig.branch.openWorktree should be at 1_branchOps@5');
    });

    it('should include Focus on Graph in section inline@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.focusOnGraph' && e.group === 'inline@1'
      );
      assert.ok(entry, 'intellig.branch.focusOnGraph should be at inline@1 for local branch');
    });

    it('should include Toggle Favorite in section 6_favorite@1', () => {
      const entry = entries.find((e) => e.command === 'intellig.branch.toggleFavorite');
      assert.ok(entry, 'intellig.branch.toggleFavorite should be present for local branch');
      assert.strictEqual(entry.group, '6_favorite@1');
    });

    it('should include Checkout in section 1_branchOps@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.checkout' && e.group === '1_branchOps@1'
      );
      assert.ok(entry, 'intellig.branch.checkout should be at 1_branchOps@1');
    });

    it('should include New Branch from in section 1_branchOps@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.newBranchFrom' && e.group === '1_branchOps@2'
      );
      assert.ok(entry, 'intellig.branch.newBranchFrom should be at 1_branchOps@2');
    });

    it('should include Checkout and Rebase in section 1_branchOps@3', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.checkoutAndRebase' && e.group === '1_branchOps@3'
      );
      assert.ok(entry, 'intellig.branch.checkoutAndRebase should be at 1_branchOps@3');
    });

    it('should include Compare with Current in section 2_compare@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.compareWithCurrent' && e.group === '2_compare@1'
      );
      assert.ok(entry, 'intellig.branch.compareWithCurrent should be at 2_compare@1');
    });

    it('should include Show Diff with Working Tree in section 2_compare@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.showDiffWithWorkingTree' && e.group === '2_compare@2'
      );
      assert.ok(entry, 'intellig.branch.showDiffWithWorkingTree should be at 2_compare@2');
    });

    it('should include Rebase Current Onto in section 3_integrate@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.rebaseCurrentOnto' && e.group === '3_integrate@1'
      );
      assert.ok(entry, 'intellig.branch.rebaseCurrentOnto should be at 3_integrate@1');
    });

    it('should include Merge into Current in section 3_integrate@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.mergeIntoCurrent' && e.group === '3_integrate@2'
      );
      assert.ok(entry, 'intellig.branch.mergeIntoCurrent should be at 3_integrate@2');
    });

    it('should include Update in section 4_sync@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.update' && e.group === '4_sync@1'
      );
      assert.ok(entry, 'intellig.branch.update should be at 4_sync@1');
    });

    it('should include Push in section 4_sync@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.push' && e.group === '4_sync@2'
      );
      assert.ok(entry, 'intellig.branch.push should be at 4_sync@2');
    });

    it('should include Update Selected (align-local FF) in section 4_sync@3', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.updateSelected' && e.group === '4_sync@3'
      );
      assert.ok(entry, 'intellig.branch.updateSelected should be at 4_sync@3');
    });

    it('should include Rename in section 5_manage@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.rename' && e.group === '5_manage@1'
      );
      assert.ok(entry, 'intellig.branch.rename should be at 5_manage@1');
    });

    it('should include Delete in section 5_manage@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.delete' && e.group === '5_manage@2'
      );
      assert.ok(entry, 'intellig.branch.delete should be at 5_manage@2');
    });

    it('should have 8 distinct group sections in correct order', () => {
      const sections = [...new Set(entries.map((e) => parseGroup(e.group).section))];
      assert.deepStrictEqual(sections.sort(), [
        '1_branchOps',
        '2_compare',
        '3_integrate',
        '3_worktree',
        '4_sync',
        '5_manage',
        '6_favorite',
        'inline',
      ]);
    });
  });

  // ─── Remote Branch (intellig.remoteBranch) ────────────────────────────────

  describe('Remote Branch Menu (intellig.remoteBranch)', () => {
    let entries: MenuEntry[];

    before(() => {
      entries = getEntriesForContext(allEntries, 'intellig.remoteBranch');
    });

    it('should have exactly 11 menu items', () => {
      // Pull into Current Using Rebase / Using Merge sit directly in the menu
      // (the former "Tracked Branch" submenu was flattened away). Track Branch
      // is no longer a menu entry.
      assert.strictEqual(entries.length, 11, `Expected 11 items, got ${entries.length}`);
    });

    it('should include Focus on Graph in section inline@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.focusOnGraph' && e.group === 'inline@1'
      );
      assert.ok(entry, 'intellig.branch.focusOnGraph should be at inline@1 for remote branch');
    });

    it('should include Checkout as Local in section 1_branchOps@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.remoteBranch.checkoutAsLocal' && e.group === '1_branchOps@1'
      );
      assert.ok(entry, 'intellig.remoteBranch.checkoutAsLocal should be at 1_branchOps@1');
    });

    it('should include New Branch from in section 1_branchOps@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.newBranchFrom' && e.group === '1_branchOps@2'
      );
      assert.ok(entry, 'intellig.branch.newBranchFrom should be at 1_branchOps@2');
    });

    it('should include Checkout and Rebase in section 1_branchOps@3', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.checkoutAndRebase' && e.group === '1_branchOps@3'
      );
      assert.ok(entry, 'intellig.branch.checkoutAndRebase should be at 1_branchOps@3');
    });

    it('should include Compare with Current in section 2_compare@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.compareWithCurrent' && e.group === '2_compare@1'
      );
      assert.ok(entry, 'intellig.branch.compareWithCurrent should be at 2_compare@1');
    });

    it('should include Show Diff with Working Tree in section 2_compare@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.showDiffWithWorkingTree' && e.group === '2_compare@2'
      );
      assert.ok(entry, 'intellig.branch.showDiffWithWorkingTree should be at 2_compare@2');
    });

    it('should include Rebase Current Onto in section 3_integrate@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.rebaseCurrentOnto' && e.group === '3_integrate@1'
      );
      assert.ok(entry, 'intellig.branch.rebaseCurrentOnto should be at 3_integrate@1');
    });

    it('should include Merge into Current in section 3_integrate@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.branch.mergeIntoCurrent' && e.group === '3_integrate@2'
      );
      assert.ok(entry, 'intellig.branch.mergeIntoCurrent should be at 3_integrate@2');
    });

    it('should include Pull into Current Using Rebase in section 4_pull@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.remoteBranch.pullUsingRebase' && e.group === '4_pull@1'
      );
      assert.ok(entry, 'intellig.remoteBranch.pullUsingRebase should be at 4_pull@1');
    });

    it('should include Pull into Current Using Merge in section 4_pull@2', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.remoteBranch.pullUsingMerge' && e.group === '4_pull@2'
      );
      assert.ok(entry, 'intellig.remoteBranch.pullUsingMerge should be at 4_pull@2');
    });

    it('no longer declares the Tracked Branch submenu (flattened)', () => {
      const pkg = loadPackageJson();
      const menus = (pkg.contributes as Record<string, unknown>).menus as Record<string, unknown>;
      assert.strictEqual(
        menus['intellig.trackedBranchSubmenu'],
        undefined,
        'intellig.trackedBranchSubmenu menu contributions must be gone'
      );

      const submenus = (pkg.contributes as Record<string, unknown>).submenus as {
        id: string;
        label: string;
      }[];
      const def = submenus.find((s) => s.id === 'intellig.trackedBranchSubmenu');
      assert.strictEqual(def, undefined, 'intellig.trackedBranchSubmenu must not be declared');
    });

    it('should include Delete Remote in section 5_manage@1', () => {
      const entry = entries.find(
        (e) => e.command === 'intellig.remoteBranch.deleteRemote' && e.group === '5_manage@1'
      );
      assert.ok(entry, 'intellig.remoteBranch.deleteRemote should be at 5_manage@1');
    });

    it('should have 6 distinct group sections in correct order', () => {
      const sections = [...new Set(entries.map((e) => parseGroup(e.group).section))];
      assert.deepStrictEqual(sections.sort(), [
        '1_branchOps',
        '2_compare',
        '3_integrate',
        '4_pull',
        '5_manage',
        'inline',
      ]);
    });
  });

  // ─── Cross-menu Validation ────────────────────────────────────────────────

  describe('Cross-menu Validation', () => {
    it('should not have Checkout or Delete commands for current branch context', () => {
      const currentEntries = getEntriesForContext(allEntries, 'intellig.localBranchCurrent');
      const excludedCommands = ['intellig.branch.checkout', 'intellig.branch.delete'];

      for (const cmd of excludedCommands) {
        const found = currentEntries.find((e) => e.command === cmd);
        assert.strictEqual(found, undefined, `Command ${cmd} should not appear for current branch`);
      }
    });

    it('should have all entries with valid group format (section@order)', () => {
      for (const entry of allEntries) {
        assert.ok(
          entry.group.includes('@'),
          `Group "${entry.group}" for command "${entry.command}" should contain @ separator`
        );
        const { order } = parseGroup(entry.group);
        assert.ok(
          !isNaN(order) && order > 0,
          `Group "${entry.group}" for command "${entry.command}" should have a positive order number`
        );
      }
    });
  });
});
