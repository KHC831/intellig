import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  RebaseAction,
  IRebaseCommit,
  IRebaseSession,
  IRebaseAction,
} from '../../git-core/interfaces/IRebaseService';

/**
 * Property-based tests for Interactive Rebase Action Support.
 * Feature: intellig-vscode, Property 13: Interactive Rebase Action Support
 *
 *
 * Property Description:
 * For any commit in an interactive rebase session, all six actions (pick, reword, edit, squash, fixup, drop)
 * SHALL be available and selectable.
 */
describe('Interactive Rebase Action Support Property Tests', () => {
  /**
   * All valid rebase actions as defined in the RebaseAction type
   */
  const ALL_REBASE_ACTIONS: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

  /**
   * Arbitrary generator for valid commit hashes (40 hex characters)
   */
  const commitHashArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 40, maxLength: 40 }
  );

  /**
   * Arbitrary generator for commit messages
   */
  const commitMessageArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 100 });

  /**
   * Arbitrary generator for a single rebase action
   */
  const rebaseActionArb: fc.Arbitrary<RebaseAction> = fc.constantFrom(...ALL_REBASE_ACTIONS);

  /**
   * Arbitrary generator for a rebase commit
   */
  const rebaseCommitArb: fc.Arbitrary<IRebaseCommit> = fc.record({
    hash: commitHashArb,
    message: commitMessageArb,
    action: rebaseActionArb,
  });

  /**
   * Arbitrary generator for an array of rebase commits with unique hashes
   */
  const rebaseCommitsArb: fc.Arbitrary<IRebaseCommit[]> = fc
    .array(rebaseCommitArb, { minLength: 1, maxLength: 10 })
    .map((commits) => {
      // Ensure unique hashes
      const seen = new Set<string>();
      return commits.filter((c) => {
        if (seen.has(c.hash)) {
          return false;
        }
        seen.add(c.hash);
        return true;
      });
    })
    .filter((commits) => commits.length > 0);

  /**
   * Arbitrary generator for valid branch names
   */
  const branchNameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
      ),
      { minLength: 1, maxLength: 30 }
    )
    .filter((s) => {
      if (s.length === 0) {
        return false;
      }
      if (s.startsWith('.') || s.startsWith('-')) {
        return false;
      }
      if (s.endsWith('.lock')) {
        return false;
      }
      if (s === 'HEAD' || s === 'head') {
        return false;
      }
      return true;
    });

  /**
   * Mock Rebase Service that simulates interactive rebase session management.
   * This allows us to test rebase action support properties without actual Git operations.
   */
  class MockRebaseService {
    private _session: IRebaseSession | undefined;

    /**
     * Start an interactive rebase session with the given commits.
     * All commits start with 'pick' action by default.
     */
    startInteractiveRebase(
      onto: string,
      originalBranch: string,
      commits: IRebaseCommit[]
    ): IRebaseSession {
      this._session = {
        onto,
        originalBranch,
        commits: commits.map((c) => ({ ...c, action: 'pick' as RebaseAction })),
        currentStep: 0,
        status: 'planning',
      };
      return this._session;
    }

    /**
     * Get the current rebase session
     */
    getRebaseSession(): IRebaseSession | undefined {
      return this._session;
    }

    /**
     * Get all available actions for a commit in the rebase session.
     * all six actions should be available.
     */
    getAvailableActionsForCommit(_commitHash: string): RebaseAction[] {
      // All six actions are always available for any commit
      return [...ALL_REBASE_ACTIONS];
    }

    /**
     * Check if a specific action is available for a commit.
     */
    isActionAvailable(_commitHash: string, action: RebaseAction): boolean {
      return ALL_REBASE_ACTIONS.includes(action);
    }

    /**
     * Update the action for a specific commit in the rebase plan.
     * Returns true if the action was successfully updated.
     */
    setCommitAction(commitHash: string, action: RebaseAction): boolean {
      if (!this._session) {
        return false;
      }

      // Verify the action is valid
      if (!ALL_REBASE_ACTIONS.includes(action)) {
        return false;
      }

      const commitIndex = this._session.commits.findIndex((c) => c.hash === commitHash);
      if (commitIndex === -1) {
        return false;
      }

      // Update the action
      this._session.commits[commitIndex] = {
        ...this._session.commits[commitIndex],
        action,
      };

      return true;
    }

    /**
     * Update the rebase plan with new actions for multiple commits.
     */
    updateRebasePlan(plan: IRebaseAction[]): boolean {
      if (!this._session) {
        return false;
      }

      for (const action of plan) {
        if (!this.setCommitAction(action.hash, action.action)) {
          return false;
        }
      }

      return true;
    }

    /**
     * Get the current action for a commit.
     */
    getCommitAction(commitHash: string): RebaseAction | undefined {
      if (!this._session) {
        return undefined;
      }

      const commit = this._session.commits.find((c) => c.hash === commitHash);
      return commit?.action;
    }
  }

  describe('Property 13: Interactive Rebase Action Support', () => {
    /**
     * Property: All six rebase actions are available for any commit in a rebase session.
     */
    it('Property: All six rebase actions are available for any commit', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          (commits, branchName, ontoHash): boolean => {
            // Setup: Create a rebase session
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // For each commit in the session
            for (const commit of commits) {
              // Get available actions for this commit
              const availableActions = rebaseService.getAvailableActionsForCommit(commit.hash);

              // Assert: All six actions are available
              assert.strictEqual(
                availableActions.length,
                6,
                `Should have exactly 6 available actions for commit ${commit.hash}`
              );

              // Assert: Each of the six actions is present
              for (const expectedAction of ALL_REBASE_ACTIONS) {
                assert.ok(
                  availableActions.includes(expectedAction),
                  `Action '${expectedAction}' should be available for commit ${commit.hash}`
                );
              }
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Each of the six actions can be individually selected for any commit.
     */
    it('Property: Each action can be selected for any commit', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          rebaseActionArb,
          (commits, branchName, ontoHash, actionToSelect): boolean => {
            // Setup: Create a rebase session
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // For each commit in the session
            for (const commit of commits) {
              // Act: Try to select the action
              const success = rebaseService.setCommitAction(commit.hash, actionToSelect);

              // Assert: Action selection succeeded
              assert.strictEqual(
                success,
                true,
                `Should be able to select action '${actionToSelect}' for commit ${commit.hash}`
              );

              // Assert: The action was actually set
              const currentAction = rebaseService.getCommitAction(commit.hash);
              assert.strictEqual(
                currentAction,
                actionToSelect,
                `Commit ${commit.hash} should have action '${actionToSelect}' after selection`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Actions can be changed multiple times for the same commit.
     */
    it('Property: Actions can be changed multiple times for the same commit', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fc.array(rebaseActionArb, { minLength: 2, maxLength: 10 }),
          (commits, branchName, ontoHash, actionsSequence): boolean => {
            // Setup: Create a rebase session
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Pick the first commit to test
            const testCommit = commits[0];

            // Apply each action in sequence
            for (const action of actionsSequence) {
              // Act: Change the action
              const success = rebaseService.setCommitAction(testCommit.hash, action);

              // Assert: Change succeeded
              assert.strictEqual(success, true, `Should be able to change action to '${action}'`);

              // Assert: Action was updated
              const currentAction = rebaseService.getCommitAction(testCommit.hash);
              assert.strictEqual(
                currentAction,
                action,
                `Action should be '${action}' after change`
              );
            }

            // Assert: Final action is the last one in the sequence
            const finalAction = rebaseService.getCommitAction(testCommit.hash);
            assert.strictEqual(
              finalAction,
              actionsSequence[actionsSequence.length - 1],
              'Final action should be the last one applied'
            );

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: All six actions are selectable for all commits simultaneously.
     */
    it('Property: Different actions can be set for different commits simultaneously', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          (commits, branchName, ontoHash): boolean => {
            if (commits.length < 2) {
              return true; // Skip if not enough commits
            }

            // Setup: Create a rebase session
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Create a plan with different actions for each commit
            const plan: IRebaseAction[] = commits.map((commit, index) => ({
              hash: commit.hash,
              action: ALL_REBASE_ACTIONS[index % ALL_REBASE_ACTIONS.length],
            }));

            // Act: Update the plan
            const success = rebaseService.updateRebasePlan(plan);

            // Assert: Plan update succeeded
            assert.strictEqual(success, true, 'Should be able to update the rebase plan');

            // Assert: Each commit has the expected action
            for (let i = 0; i < commits.length; i++) {
              const expectedAction = ALL_REBASE_ACTIONS[i % ALL_REBASE_ACTIONS.length];
              const actualAction = rebaseService.getCommitAction(commits[i].hash);
              assert.strictEqual(
                actualAction,
                expectedAction,
                `Commit ${commits[i].hash} should have action '${expectedAction}'`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The 'pick' action is available and selectable (default action).
     */
    it('Property: Pick action is available and selectable', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          (commits, branchName, ontoHash): boolean => {
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            for (const commit of commits) {
              // Assert: pick is available
              assert.ok(
                rebaseService.isActionAvailable(commit.hash, 'pick'),
                'Pick action should be available'
              );

              // Act: Select pick
              const success = rebaseService.setCommitAction(commit.hash, 'pick');
              assert.strictEqual(success, true, 'Should be able to select pick');

              // Assert: pick is set
              assert.strictEqual(
                rebaseService.getCommitAction(commit.hash),
                'pick',
                'Action should be pick'
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The 'reword' action is available and selectable.
     */
    it('Property: Reword action is available and selectable', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          (commits, branchName, ontoHash): boolean => {
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            for (const commit of commits) {
              assert.ok(
                rebaseService.isActionAvailable(commit.hash, 'reword'),
                'Reword action should be available'
              );

              const success = rebaseService.setCommitAction(commit.hash, 'reword');
              assert.strictEqual(success, true, 'Should be able to select reword');
              assert.strictEqual(
                rebaseService.getCommitAction(commit.hash),
                'reword',
                'Action should be reword'
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The 'edit' action is available and selectable.
     */
    it('Property: Edit action is available and selectable', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          (commits, branchName, ontoHash): boolean => {
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            for (const commit of commits) {
              assert.ok(
                rebaseService.isActionAvailable(commit.hash, 'edit'),
                'Edit action should be available'
              );

              const success = rebaseService.setCommitAction(commit.hash, 'edit');
              assert.strictEqual(success, true, 'Should be able to select edit');
              assert.strictEqual(
                rebaseService.getCommitAction(commit.hash),
                'edit',
                'Action should be edit'
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The 'squash' action is available and selectable.
     */
    it('Property: Squash action is available and selectable', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          (commits, branchName, ontoHash): boolean => {
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            for (const commit of commits) {
              assert.ok(
                rebaseService.isActionAvailable(commit.hash, 'squash'),
                'Squash action should be available'
              );

              const success = rebaseService.setCommitAction(commit.hash, 'squash');
              assert.strictEqual(success, true, 'Should be able to select squash');
              assert.strictEqual(
                rebaseService.getCommitAction(commit.hash),
                'squash',
                'Action should be squash'
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The 'fixup' action is available and selectable.
     */
    it('Property: Fixup action is available and selectable', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          (commits, branchName, ontoHash): boolean => {
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            for (const commit of commits) {
              assert.ok(
                rebaseService.isActionAvailable(commit.hash, 'fixup'),
                'Fixup action should be available'
              );

              const success = rebaseService.setCommitAction(commit.hash, 'fixup');
              assert.strictEqual(success, true, 'Should be able to select fixup');
              assert.strictEqual(
                rebaseService.getCommitAction(commit.hash),
                'fixup',
                'Action should be fixup'
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: The 'drop' action is available and selectable.
     */
    it('Property: Drop action is available and selectable', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          (commits, branchName, ontoHash): boolean => {
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            for (const commit of commits) {
              assert.ok(
                rebaseService.isActionAvailable(commit.hash, 'drop'),
                'Drop action should be available'
              );

              const success = rebaseService.setCommitAction(commit.hash, 'drop');
              assert.strictEqual(success, true, 'Should be able to select drop');
              assert.strictEqual(
                rebaseService.getCommitAction(commit.hash),
                'drop',
                'Action should be drop'
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * Property: Session maintains action selections across multiple commits.
     */
    it('Property: Session maintains action selections across multiple commits', () => {
      fc.assert(
        fc.property(
          rebaseCommitsArb,
          branchNameArb,
          commitHashArb,
          fc.array(
            fc.record({
              commitIndex: fc.nat(),
              action: rebaseActionArb,
            }),
            { minLength: 1, maxLength: 20 }
          ),
          (commits, branchName, ontoHash, actionChanges): boolean => {
            const rebaseService = new MockRebaseService();
            rebaseService.startInteractiveRebase(ontoHash, branchName, commits);

            // Track expected actions for each commit
            const expectedActions = new Map<string, RebaseAction>();
            for (const commit of commits) {
              expectedActions.set(commit.hash, 'pick'); // Default action
            }

            // Apply action changes
            for (const change of actionChanges) {
              const commitIndex = change.commitIndex % commits.length;
              const commit = commits[commitIndex];

              rebaseService.setCommitAction(commit.hash, change.action);
              expectedActions.set(commit.hash, change.action);
            }

            // Verify all actions are as expected
            for (const commit of commits) {
              const actualAction = rebaseService.getCommitAction(commit.hash);
              const expectedAction = expectedActions.get(commit.hash);
              assert.strictEqual(
                actualAction,
                expectedAction,
                `Commit ${commit.hash} should have action '${expectedAction}'`
              );
            }

            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
