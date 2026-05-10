/**
 * Property-based tests for Undo Commit disabled state.
 *
 * Feature: git-graph-context-menu
 *
 * Uses fast-check to verify that the "Undo Commit" menu item has the
 * disabled class if and only if the commit hash does not equal the HEAD hash.
 *
 * Properties tested:
 *   2 — Undo Commit disabled state
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a full commit hash (40 hex characters).
 */
function arbitraryFullHash(): fc.Arbitrary<string> {
  return fc.stringOf(fc.constantFrom(...'0123456789abcdef'.split('')), {
    minLength: 40,
    maxLength: 40,
  });
}

// ─── Pure logic extracted from webview JS ─────────────────────────────────────

/**
 * Determines whether the "Undo Commit" menu item should be disabled.
 *
 * This mirrors the logic in showCommitContextMenu():
 * - If the selected commit hashes contain exactly one hash that matches
 *   the HEAD hash, the item is enabled (not disabled).
 * - Otherwise, the item is disabled.
 *
 * @param commitHashes - The commit hashes selected for the context menu
 * @param headHash - The HEAD commit hash from data-head-hash
 * @returns true if the item should have the 'disabled' class
 */
function shouldUndoCommitBeDisabled(commitHashes: string[], headHash: string): boolean {
  return !(commitHashes.length === 1 && commitHashes[0] === headHash);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: git-graph-context-menu - Undo Commit Disabled State Property Tests', () => {
  // Feature: git-graph-context-menu, Property 2: Undo Commit disabled state
  describe('Property 2: Undo Commit disabled state', () => {
    /**
     * **Validates: Requirements 4.5, 8.1**
     *
     * For any pair of commit hash and HEAD hash, the "Undo Commit" menu item
     * should have the disabled class if and only if the commit hash does not
     * equal the HEAD hash.
     */
    it('should disable Undo Commit if and only if the commit hash does not equal the HEAD hash', () => {
      fc.assert(
        fc.property(arbitraryFullHash(), arbitraryFullHash(), (commitHash, headHash) => {
          const isDisabled = shouldUndoCommitBeDisabled([commitHash], headHash);

          if (commitHash === headHash) {
            assert.strictEqual(
              isDisabled,
              false,
              `Undo Commit should NOT be disabled when commit hash equals HEAD hash (${commitHash})`
            );
          } else {
            assert.strictEqual(
              isDisabled,
              true,
              `Undo Commit should be disabled when commit hash (${commitHash}) differs from HEAD hash (${headHash})`
            );
          }
        }),
        { numRuns: 100 }
      );
    });

    it('should always disable Undo Commit for multi-select (more than one commit)', () => {
      fc.assert(
        fc.property(
          fc.array(arbitraryFullHash(), { minLength: 2, maxLength: 5 }),
          arbitraryFullHash(),
          (commitHashes, headHash) => {
            const isDisabled = shouldUndoCommitBeDisabled(commitHashes, headHash);
            assert.strictEqual(
              isDisabled,
              true,
              'Undo Commit should always be disabled when multiple commits are selected'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should always disable Undo Commit when no commits are selected', () => {
      fc.assert(
        fc.property(arbitraryFullHash(), (headHash) => {
          const isDisabled = shouldUndoCommitBeDisabled([], headHash);
          assert.strictEqual(
            isDisabled,
            true,
            'Undo Commit should be disabled when no commits are selected'
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
