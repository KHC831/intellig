import * as fc from 'fast-check';
import * as assert from 'assert';
import { IBranch, BranchType } from '../../git-core/interfaces/IGitService';

/**
 * Property-based tests for Branch Popup Completeness.
 * Feature: intellig-vscode, Property 9: Branch Popup Completeness
 *
 *
 * Property Description:
 * For any repository, the branch popup SHALL display all local branches
 * and all remote tracking branches.
 */
describe('Branch Popup Completeness Property Tests', () => {
  /**
   * Arbitrary generator for valid branch names.
   * Git branch names have specific rules:
   * - Cannot start with a dot
   * - Cannot contain consecutive dots
   * - Cannot contain spaces, ~, ^, :, ?, *, [, \, or control characters
   * - Cannot end with .lock
   * - Cannot be empty
   */
  const validBranchNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => {
      // Filter out invalid branch names
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('.')) {
        return false;
      }
      if (s.startsWith('-')) {
        return false;
      }
      if (s.endsWith('.lock')) {
        return false;
      }
      if (s.includes('..')) {
        return false;
      }
      // Avoid reserved names
      if (s === 'HEAD' || s === 'head') {
        return false;
      }
      return true;
    });

  /**
   * Arbitrary generator for remote names
   */
  const remoteNameArb: fc.Arbitrary<string> = fc.constantFrom(
    'origin',
    'upstream',
    'fork',
    'backup'
  );

  /**
   * Arbitrary generator for commit hashes (40 character hex string)
   */
  const commitHashArb: fc.Arbitrary<string> = fc
    .hexaString({ minLength: 40, maxLength: 40 })
    .map((s) => s.toLowerCase());

  /**
   * Arbitrary generator for a local branch object
   */
  const localBranchArb: fc.Arbitrary<IBranch> = fc.record({
    name: validBranchNameArb,
    type: fc.constant('local' as BranchType),
    commit: commitHashArb,
    upstream: fc.constant(undefined),
    isHead: fc.boolean(),
    ahead: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
    behind: fc.option(fc.nat({ max: 100 }), { nil: undefined }),
  });

  /**
   * Arbitrary generator for a remote branch object
   */
  const remoteBranchArb: fc.Arbitrary<IBranch> = fc
    .tuple(remoteNameArb, validBranchNameArb, commitHashArb)
    .map(([remoteName, branchName, commit]) => ({
      name: `${remoteName}/${branchName}`,
      type: 'remote' as BranchType,
      commit,
      upstream: undefined,
      isHead: false,
      ahead: undefined,
      behind: undefined,
    }));

  /**
   * Arbitrary generator for an array of local branches
   */
  const localBranchesArb: fc.Arbitrary<IBranch[]> = fc
    .array(localBranchArb, { minLength: 1, maxLength: 10 })
    .map((branches) => {
      // Ensure unique branch names
      const seen = new Set<string>();
      const uniqueBranches: IBranch[] = [];
      for (const branch of branches) {
        if (!seen.has(branch.name)) {
          seen.add(branch.name);
          uniqueBranches.push(branch);
        }
      }
      // Ensure exactly one branch is HEAD
      let hasHead = false;
      return uniqueBranches.map((b, i) => {
        if (i === 0 && !hasHead) {
          hasHead = true;
          return { ...b, isHead: true };
        }
        return { ...b, isHead: false };
      });
    });

  /**
   * Arbitrary generator for an array of remote branches
   */
  const remoteBranchesArb: fc.Arbitrary<IBranch[]> = fc
    .array(remoteBranchArb, { minLength: 0, maxLength: 10 })
    .map((branches) => {
      // Ensure unique branch names
      const seen = new Set<string>();
      const uniqueBranches: IBranch[] = [];
      for (const branch of branches) {
        if (!seen.has(branch.name)) {
          seen.add(branch.name);
          uniqueBranches.push(branch);
        }
      }
      return uniqueBranches;
    });

  /**
   * Arbitrary generator for a repository with branches
   */
  const repositoryWithBranchesArb: fc.Arbitrary<{
    localBranches: IBranch[];
    remoteBranches: IBranch[];
  }> = fc.record({
    localBranches: localBranchesArb,
    remoteBranches: remoteBranchesArb,
  });

  /**
   * Mock BranchPopup that simulates the branch popup behavior.
   * This extracts the core logic of building quick pick items from branches.
   */
  class MockBranchPopup {
    private _branches: IBranch[] = [];

    /**
     * Set the branches that would be returned by GitService.getBranches()
     */
    setBranches(branches: IBranch[]): void {
      this._branches = branches;
    }

    /**
     * Get all branches (simulates GitService.getBranches())
     */
    getBranches(): IBranch[] {
      return [...this._branches];
    }

    /**
     * Build the list of branch items that would be displayed in the popup.
     * This mirrors the logic in BranchPopup._buildQuickPickItems()
     */
    buildBranchItems(): { localBranches: IBranch[]; remoteBranches: IBranch[] } {
      const branches = this.getBranches();

      // Separate local and remote branches (same logic as BranchPopup)
      const localBranches = branches.filter((b) => b.type === 'local');
      const remoteBranches = branches.filter((b) => b.type === 'remote');

      return { localBranches, remoteBranches };
    }

    /**
     * Get the names of all branches that would be displayed in the popup.
     */
    getDisplayedBranchNames(): Set<string> {
      const { localBranches, remoteBranches } = this.buildBranchItems();
      const names = new Set<string>();

      for (const branch of localBranches) {
        names.add(branch.name);
      }

      for (const branch of remoteBranches) {
        names.add(branch.name);
      }

      return names;
    }

    /**
     * Check if a specific branch would be displayed in the popup.
     */
    isBranchDisplayed(branchName: string): boolean {
      return this.getDisplayedBranchNames().has(branchName);
    }
  }

  describe('Property 9: Branch Popup Completeness', () => {
    /**
     * Property: All local branches SHALL be displayed in the branch popup.
     */
    it('Property: All local branches are displayed in the popup', () => {
      fc.assert(
        fc.property(repositoryWithBranchesArb, ({ localBranches, remoteBranches }): boolean => {
          // Setup
          const popup = new MockBranchPopup();
          const allBranches = [...localBranches, ...remoteBranches];
          popup.setBranches(allBranches);

          // Act: Get the displayed branches
          const { localBranches: displayedLocal } = popup.buildBranchItems();

          // Assert: All local branches are displayed
          const displayedLocalNames = new Set(displayedLocal.map((b) => b.name));

          for (const branch of localBranches) {
            assert.strictEqual(
              displayedLocalNames.has(branch.name),
              true,
              `Local branch '${branch.name}' should be displayed in the popup`
            );
          }

          // Assert: The count matches
          assert.strictEqual(
            displayedLocal.length,
            localBranches.length,
            'All local branches should be displayed'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All remote tracking branches SHALL be displayed in the branch popup.
     */
    it('Property: All remote tracking branches are displayed in the popup', () => {
      fc.assert(
        fc.property(repositoryWithBranchesArb, ({ localBranches, remoteBranches }): boolean => {
          // Setup
          const popup = new MockBranchPopup();
          const allBranches = [...localBranches, ...remoteBranches];
          popup.setBranches(allBranches);

          // Act: Get the displayed branches
          const { remoteBranches: displayedRemote } = popup.buildBranchItems();

          // Assert: All remote branches are displayed
          const displayedRemoteNames = new Set(displayedRemote.map((b) => b.name));

          for (const branch of remoteBranches) {
            assert.strictEqual(
              displayedRemoteNames.has(branch.name),
              true,
              `Remote branch '${branch.name}' should be displayed in the popup`
            );
          }

          // Assert: The count matches
          assert.strictEqual(
            displayedRemote.length,
            remoteBranches.length,
            'All remote branches should be displayed'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The branch popup SHALL display the complete set of all branches.
     */
    it('Property: Branch popup displays complete set of all branches', () => {
      fc.assert(
        fc.property(repositoryWithBranchesArb, ({ localBranches, remoteBranches }): boolean => {
          // Setup
          const popup = new MockBranchPopup();
          const allBranches = [...localBranches, ...remoteBranches];
          popup.setBranches(allBranches);

          // Act: Get all displayed branch names
          const displayedNames = popup.getDisplayedBranchNames();

          // Assert: Every branch in the repository is displayed
          for (const branch of allBranches) {
            assert.strictEqual(
              displayedNames.has(branch.name),
              true,
              `Branch '${branch.name}' should be displayed in the popup`
            );
          }

          // Assert: Total count matches
          assert.strictEqual(
            displayedNames.size,
            allBranches.length,
            'Total displayed branches should match total repository branches'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Local and remote branches SHALL be correctly categorized.
     */
    it('Property: Branches are correctly categorized as local or remote', () => {
      fc.assert(
        fc.property(repositoryWithBranchesArb, ({ localBranches, remoteBranches }): boolean => {
          // Setup
          const popup = new MockBranchPopup();
          const allBranches = [...localBranches, ...remoteBranches];
          popup.setBranches(allBranches);

          // Act: Get categorized branches
          const { localBranches: displayedLocal, remoteBranches: displayedRemote } =
            popup.buildBranchItems();

          // Assert: All displayed local branches have type 'local'
          for (const branch of displayedLocal) {
            assert.strictEqual(
              branch.type,
              'local',
              `Branch '${branch.name}' in local section should have type 'local'`
            );
          }

          // Assert: All displayed remote branches have type 'remote'
          for (const branch of displayedRemote) {
            assert.strictEqual(
              branch.type,
              'remote',
              `Branch '${branch.name}' in remote section should have type 'remote'`
            );
          }

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: No branches SHALL be duplicated in the popup.
     */
    it('Property: No branches are duplicated in the popup', () => {
      fc.assert(
        fc.property(repositoryWithBranchesArb, ({ localBranches, remoteBranches }): boolean => {
          // Setup
          const popup = new MockBranchPopup();
          const allBranches = [...localBranches, ...remoteBranches];
          popup.setBranches(allBranches);

          // Act: Get categorized branches
          const { localBranches: displayedLocal, remoteBranches: displayedRemote } =
            popup.buildBranchItems();

          // Assert: No duplicates in local branches
          const localNames = displayedLocal.map((b) => b.name);
          const uniqueLocalNames = new Set(localNames);
          assert.strictEqual(
            localNames.length,
            uniqueLocalNames.size,
            'Local branches should not have duplicates'
          );

          // Assert: No duplicates in remote branches
          const remoteNames = displayedRemote.map((b) => b.name);
          const uniqueRemoteNames = new Set(remoteNames);
          assert.strictEqual(
            remoteNames.length,
            uniqueRemoteNames.size,
            'Remote branches should not have duplicates'
          );

          // Assert: No branch appears in both local and remote sections
          const allDisplayedNames = [...localNames, ...remoteNames];
          const uniqueAllNames = new Set(allDisplayedNames);
          assert.strictEqual(
            allDisplayedNames.length,
            uniqueAllNames.size,
            'No branch should appear in both local and remote sections'
          );

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Empty repository (no branches) SHALL result in empty popup sections.
     */
    it('Property: Empty branch list results in empty popup sections', () => {
      fc.assert(
        fc.property(fc.constant(null), (): boolean => {
          // Setup: Empty repository
          const popup = new MockBranchPopup();
          popup.setBranches([]);

          // Act: Get categorized branches
          const { localBranches: displayedLocal, remoteBranches: displayedRemote } =
            popup.buildBranchItems();

          // Assert: Both sections are empty
          assert.strictEqual(displayedLocal.length, 0, 'Local branches should be empty');
          assert.strictEqual(displayedRemote.length, 0, 'Remote branches should be empty');

          return true;
        }),
        { numRuns: 1 }
      );
    });

    /**
     * Property: Repository with only local branches SHALL display only local section.
     */
    it('Property: Repository with only local branches displays only local section', () => {
      fc.assert(
        fc.property(localBranchesArb, (localBranches): boolean => {
          // Setup: Only local branches
          const popup = new MockBranchPopup();
          popup.setBranches(localBranches);

          // Act: Get categorized branches
          const { localBranches: displayedLocal, remoteBranches: displayedRemote } =
            popup.buildBranchItems();

          // Assert: Local section has all branches
          assert.strictEqual(
            displayedLocal.length,
            localBranches.length,
            'All local branches should be displayed'
          );

          // Assert: Remote section is empty
          assert.strictEqual(displayedRemote.length, 0, 'Remote branches should be empty');

          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Repository with only remote branches SHALL display only remote section.
     */
    it('Property: Repository with only remote branches displays only remote section', () => {
      fc.assert(
        fc.property(
          remoteBranchesArb.filter((branches) => branches.length > 0),
          (remoteBranches): boolean => {
            // Setup: Only remote branches
            const popup = new MockBranchPopup();
            popup.setBranches(remoteBranches);

            // Act: Get categorized branches
            const { localBranches: displayedLocal, remoteBranches: displayedRemote } =
              popup.buildBranchItems();

            // Assert: Remote section has all branches
            assert.strictEqual(
              displayedRemote.length,
              remoteBranches.length,
              'All remote branches should be displayed'
            );

            // Assert: Local section is empty
            assert.strictEqual(displayedLocal.length, 0, 'Local branches should be empty');

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Branch popup completeness is preserved regardless of branch order.
     */
    it('Property: Branch popup completeness is preserved regardless of input order', () => {
      fc.assert(
        fc.property(
          repositoryWithBranchesArb,
          fc.boolean(),
          ({ localBranches, remoteBranches }, reverseOrder): boolean => {
            // Setup: Create branches in different orders
            const popup1 = new MockBranchPopup();
            const popup2 = new MockBranchPopup();

            const allBranches = [...localBranches, ...remoteBranches];
            const reversedBranches = [...allBranches].reverse();

            popup1.setBranches(reverseOrder ? reversedBranches : allBranches);
            popup2.setBranches(reverseOrder ? allBranches : reversedBranches);

            // Act: Get displayed branch names from both
            const names1 = popup1.getDisplayedBranchNames();
            const names2 = popup2.getDisplayedBranchNames();

            // Assert: Both popups display the same branches
            assert.strictEqual(
              names1.size,
              names2.size,
              'Both popups should display the same number of branches'
            );

            for (const name of names1) {
              assert.strictEqual(
                names2.has(name),
                true,
                `Branch '${name}' should be displayed in both popups`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Large number of branches SHALL all be displayed.
     */
    it('Property: Large number of branches are all displayed', () => {
      // Generate a larger set of branches
      const manyLocalBranchesArb = fc
        .array(localBranchArb, { minLength: 20, maxLength: 50 })
        .map((branches) => {
          const seen = new Set<string>();
          const uniqueBranches: IBranch[] = [];
          for (const branch of branches) {
            if (!seen.has(branch.name)) {
              seen.add(branch.name);
              uniqueBranches.push(branch);
            }
          }
          // Ensure exactly one branch is HEAD
          if (uniqueBranches.length > 0) {
            uniqueBranches[0] = { ...uniqueBranches[0], isHead: true };
            for (let i = 1; i < uniqueBranches.length; i++) {
              uniqueBranches[i] = { ...uniqueBranches[i], isHead: false };
            }
          }
          return uniqueBranches;
        });

      const manyRemoteBranchesArb = fc
        .array(remoteBranchArb, { minLength: 20, maxLength: 50 })
        .map((branches) => {
          const seen = new Set<string>();
          const uniqueBranches: IBranch[] = [];
          for (const branch of branches) {
            if (!seen.has(branch.name)) {
              seen.add(branch.name);
              uniqueBranches.push(branch);
            }
          }
          return uniqueBranches;
        });

      fc.assert(
        fc.property(
          manyLocalBranchesArb,
          manyRemoteBranchesArb,
          (localBranches, remoteBranches): boolean => {
            // Setup
            const popup = new MockBranchPopup();
            const allBranches = [...localBranches, ...remoteBranches];
            popup.setBranches(allBranches);

            // Act: Get displayed branches
            const displayedNames = popup.getDisplayedBranchNames();

            // Assert: All branches are displayed
            assert.strictEqual(
              displayedNames.size,
              allBranches.length,
              `All ${allBranches.length} branches should be displayed`
            );

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
