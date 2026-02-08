/**
 * Property-based tests for excluded commands on current branch.
 *
 * Feature: branch-context-menu, Property 1: Excluded commands do not appear for current branch
 *
 * For any command that should be hidden from the current branch context menu
 * (Checkout, Delete), the `when` clause in the menu contribution SHALL NOT
 * match the `intellig.localBranchCurrent` context value.
 *
 * **Validates: Requirements 2.3, 2.7**
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The context value used for the currently checked-out local branch.
 */
const CURRENT_BRANCH_CONTEXT = 'intellig.localBranchCurrent';

/**
 * Commands that MUST be excluded from the current branch context menu.
 * - Checkout: not applicable because the branch is already checked out (Requirement 2.3)
 * - Delete: not applicable because you cannot delete the currently checked-out branch (Requirement 2.7)
 */
const EXCLUDED_COMMANDS: ReadonlyArray<string> = [
  'intellig.branch.checkout',
  'intellig.branch.delete',
];

// ─── Menu Contribution Parsing ────────────────────────────────────────────────

interface MenuEntry {
  command: string;
  when: string;
  group: string;
}

/**
 * Read and parse the view/item/context menu contributions from package.json.
 */
function getMenuContributions(): MenuEntry[] {
  const packageJsonPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  const menus = packageJson?.contributes?.menus?.['view/item/context'];
  if (!Array.isArray(menus)) {
    throw new Error('No view/item/context menu contributions found in package.json');
  }
  return menus as MenuEntry[];
}

/**
 * Get all menu entries that target the current branch context value.
 */
function getCurrentBranchMenuEntries(allEntries: MenuEntry[]): MenuEntry[] {
  return allEntries.filter(
    (entry) => entry.when && entry.when.includes(CURRENT_BRANCH_CONTEXT)
  );
}

/**
 * Get all unique command IDs from the menu contributions.
 */
function getAllCommandIds(allEntries: MenuEntry[]): string[] {
  return [...new Set(allEntries.map((entry) => entry.command))];
}

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a random subset of excluded command IDs.
 * This tests that for ANY combination of excluded commands,
 * none of them appear in the current branch menu.
 */
function arbitraryExcludedSubset(allCommandIds: string[]): fc.Arbitrary<string[]> {
  return fc.subarray(allCommandIds, { minLength: 1 });
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: branch-context-menu - Excluded Commands Property Tests', () => {
  let allMenuEntries: MenuEntry[];
  let currentBranchEntries: MenuEntry[];
  let allCommandIds: string[];

  before(() => {
    allMenuEntries = getMenuContributions();
    currentBranchEntries = getCurrentBranchMenuEntries(allMenuEntries);
    allCommandIds = getAllCommandIds(allMenuEntries);
  });

  describe('Property 1: Excluded commands do not appear for current branch', () => {
    /**
     * **Validates: Requirements 2.3, 2.7**
     *
     * For any command that should be hidden from the current branch context menu
     * (Checkout, Delete), the when clause in the menu contribution SHALL NOT
     * match the intellig.localBranchCurrent context value.
     */

    it('Checkout and Delete commands are never present in current branch menu entries', () => {
      const currentBranchCommandIds = currentBranchEntries.map((entry) => entry.command);

      fc.assert(
        fc.property(
          fc.constantFrom(...EXCLUDED_COMMANDS),
          (excludedCommand) => {
            assert.ok(
              !currentBranchCommandIds.includes(excludedCommand),
              `Excluded command "${excludedCommand}" should NOT appear in the current branch ` +
              `(${CURRENT_BRANCH_CONTEXT}) context menu, but it was found. ` +
              `Current branch commands: [${currentBranchCommandIds.join(', ')}]`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('for any random subset of commands, excluded commands are never in current branch menu', () => {
      fc.assert(
        fc.property(
          arbitraryExcludedSubset(allCommandIds),
          (commandSubset) => {
            // For each command in the random subset, check if it's an excluded command
            // and if so, verify it does NOT appear in the current branch menu
            for (const cmd of commandSubset) {
              if (EXCLUDED_COMMANDS.includes(cmd)) {
                const matchingEntries = currentBranchEntries.filter(
                  (entry) => entry.command === cmd
                );
                assert.strictEqual(
                  matchingEntries.length,
                  0,
                  `Excluded command "${cmd}" should NOT have any menu entries for ` +
                  `${CURRENT_BRANCH_CONTEXT}, but found ${matchingEntries.length} entries`
                );
              }
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('current branch menu entries only contain allowed commands', () => {
      // The allowed commands for current branch per the design:
      // - intellig.branch.newBranchFrom (1_branchOps@1)
      // - intellig.branch.update (2_sync@1)
      // - intellig.branch.push (2_sync@2)
      // - intellig.branch.rename (3_manage@1)
      const ALLOWED_CURRENT_BRANCH_COMMANDS: ReadonlyArray<string> = [
        'intellig.branch.newBranchFrom',
        'intellig.branch.update',
        'intellig.branch.push',
        'intellig.branch.rename',
      ];

      fc.assert(
        fc.property(
          fc.constantFrom(...currentBranchEntries),
          (entry) => {
            assert.ok(
              ALLOWED_CURRENT_BRANCH_COMMANDS.includes(entry.command),
              `Command "${entry.command}" found in current branch menu but is not in the ` +
              `allowed list. Allowed: [${ALLOWED_CURRENT_BRANCH_COMMANDS.join(', ')}]`
            );

            // Also verify it's not an excluded command (double-check)
            assert.ok(
              !EXCLUDED_COMMANDS.includes(entry.command),
              `Excluded command "${entry.command}" should NOT appear in the current branch menu`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('excluded commands only appear for non-current branch context values', () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...EXCLUDED_COMMANDS),
          (excludedCommand) => {
            // Find all menu entries for this excluded command
            const entriesForCommand = allMenuEntries.filter(
              (entry) => entry.command === excludedCommand
            );

            // Each entry's when clause must NOT reference the current branch context
            for (const entry of entriesForCommand) {
              assert.ok(
                !entry.when.includes(CURRENT_BRANCH_CONTEXT),
                `Excluded command "${excludedCommand}" has a menu entry with ` +
                `when="${entry.when}" that matches the current branch context ` +
                `(${CURRENT_BRANCH_CONTEXT}). This violates Requirements 2.3 and 2.7.`
              );
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
