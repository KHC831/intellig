/**
 * Property-based tests for Branch Panel rendering.
 *
 * Feature: intellij-git-layout
 *
 * Uses fast-check to verify universal correctness properties of the
 * Branch Panel HTML generation in GitToolWindowProvider._getBranchPanelHtml().
 *
 * Properties tested:
 *   4 — HEAD display correctness
 *   5 — Local branches alphabetical ordering
 *   6 — Remote branches grouped by remote
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../services/GitToolWindowProvider';
import { IBranchPanelData } from '../../services/interfaces';
import { IBranch } from '../../services/interfaces/IGitService';
import { Uri } from '../mocks/vscode';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid branch name segment (no whitespace, no HTML special chars).
 * Branch names in git can contain alphanumeric, hyphens, underscores, slashes, and dots.
 */
function arbitraryBranchSegment(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'
        .split('')
    ),
    { minLength: 1, maxLength: 20 }
  );
}

/**
 * Generate a valid branch name (1-3 segments joined by '/').
 */
function arbitraryBranchName(): fc.Arbitrary<string> {
  return fc.array(arbitraryBranchSegment(), { minLength: 1, maxLength: 3 })
    .map(segments => segments.join('/'));
}

/**
 * Generate a short commit hash (7-12 hex characters).
 */
function arbitraryShortHash(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 7, maxLength: 12 }
  );
}

/**
 * Generate a full commit hash (40 hex characters).
 */
function arbitraryFullHash(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 40, maxLength: 40 }
  );
}

/**
 * Generate a HEAD state that is NOT detached (points to a branch name).
 */
function arbitraryAttachedHead(): fc.Arbitrary<IBranchPanelData['head']> {
  return arbitraryBranchName().map(name => ({
    name,
    isDetached: false,
  }));
}

/**
 * Generate a HEAD state that IS detached (has a commit hash).
 */
function arbitraryDetachedHead(): fc.Arbitrary<IBranchPanelData['head']> {
  return arbitraryShortHash().map(hash => ({
    name: hash,
    isDetached: true,
    commitHash: hash,
  }));
}

/**
 * Generate either an attached or detached HEAD state.
 */
function arbitraryHead(): fc.Arbitrary<IBranchPanelData['head']> {
  return fc.oneof(arbitraryAttachedHead(), arbitraryDetachedHead());
}

/**
 * Generate a minimal IBranch for a local branch.
 */
function arbitraryLocalBranch(): fc.Arbitrary<IBranch> {
  return fc.record({
    name: arbitraryBranchName(),
    type: fc.constant('local' as const),
    commit: arbitraryFullHash(),
    isHead: fc.constant(false),
  });
}

/**
 * Generate a non-empty list of local branches with unique names.
 */
function arbitraryLocalBranches(): fc.Arbitrary<IBranch[]> {
  return fc.array(arbitraryLocalBranch(), { minLength: 1, maxLength: 20 })
    .map(branches => {
      // Deduplicate by name
      const seen = new Set<string>();
      return branches.filter(b => {
        const lower = b.name.toLowerCase();
        if (seen.has(lower)) { return false; }
        seen.add(lower);
        return true;
      });
    })
    .filter(branches => branches.length > 0);
}

/**
 * Generate a valid remote name (e.g. "origin", "upstream", "fork").
 */
function arbitraryRemoteName(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')),
    { minLength: 1, maxLength: 12 }
  );
}

/**
 * Generate a remote branch (name prefixed with remoteName/).
 */
function arbitraryRemoteBranch(remoteName: string): fc.Arbitrary<IBranch> {
  return fc.record({
    name: arbitraryBranchName().map(n => `${remoteName}/${n}`),
    type: fc.constant('remote' as const),
    commit: arbitraryFullHash(),
    isHead: fc.constant(false),
  });
}

/**
 * Generate a remote group with a remote name and 1-8 branches.
 */
function arbitraryRemoteGroup(): fc.Arbitrary<{ remoteName: string; branches: IBranch[] }> {
  return arbitraryRemoteName().chain(remoteName =>
    fc.array(arbitraryRemoteBranch(remoteName), { minLength: 1, maxLength: 8 })
      .map(branches => {
        // Deduplicate by name
        const seen = new Set<string>();
        const unique = branches.filter(b => {
          const lower = b.name.toLowerCase();
          if (seen.has(lower)) { return false; }
          seen.add(lower);
          return true;
        });
        return { remoteName, branches: unique };
      })
      .filter(group => group.branches.length > 0)
  );
}

/**
 * Generate a non-empty list of remote groups with unique remote names.
 */
function arbitraryRemoteGroups(): fc.Arbitrary<{ remoteName: string; branches: IBranch[] }[]> {
  return fc.array(arbitraryRemoteGroup(), { minLength: 1, maxLength: 5 })
    .map(groups => {
      // Deduplicate by remote name
      const seen = new Set<string>();
      return groups.filter(g => {
        const lower = g.remoteName.toLowerCase();
        if (seen.has(lower)) { return false; }
        seen.add(lower);
        return true;
      });
    })
    .filter(groups => groups.length > 0);
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Create a GitToolWindowProvider instance for testing.
 */
function createProvider(): GitToolWindowProvider {
  const extensionUri = Uri.file('/test/extension');
  return new GitToolWindowProvider(extensionUri);
}

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: intellij-git-layout - Branch Panel Property Tests', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = createProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('Property 4: HEAD display correctness', () => {
    /**
     * **Validates: Requirements 2.2, 2.3**
     *
     * For any repository HEAD state (either pointing to a branch name or in
     * detached state with a commit hash), the Branch Panel HTML SHALL contain
     * the branch name when not detached, or the short commit hash with a
     * "(detached)" label when detached.
     */
    it('Feature: intellij-git-layout, Property 4: HEAD display correctness — attached HEAD shows branch name, detached HEAD shows hash with (detached) label', () => {
      fc.assert(
        fc.property(
          arbitraryHead(),
          (head) => {
            const data: IBranchPanelData = {
              head,
              local: [],
              remote: [],
            };

            const html = provider._getBranchPanelHtml(data);

            // The HTML must contain the HEAD (Current Branch) category
            assert.ok(
              html.includes('HEAD (Current Branch)'),
              'HTML should contain HEAD (Current Branch) category'
            );

            if (head.isDetached) {
              // Detached: should show the commit hash and "(detached)" label
              const hash = head.commitHash || head.name;
              assert.ok(
                html.includes(hash),
                `Detached HEAD HTML should contain the commit hash "${hash}"`
              );
              assert.ok(
                html.includes('(detached)'),
                'Detached HEAD HTML should contain "(detached)" label'
              );
            } else {
              // Attached: should show the branch name and NOT show "(detached)"
              assert.ok(
                html.includes(head.name),
                `Attached HEAD HTML should contain the branch name "${head.name}"`
              );
              // Extract the HEAD category section to check for detached label
              const headCategoryStart = html.indexOf('data-category="head"');
              const localCategoryStart = html.indexOf('data-category="local"');
              const headSection = html.substring(headCategoryStart, localCategoryStart);
              assert.ok(
                !headSection.includes('(detached)'),
                'Attached HEAD section should NOT contain "(detached)" label'
              );
            }
          }
        ),
        { numRuns: 150 }
      );
    });
  });

  describe('Property 5: Local branches alphabetical ordering', () => {
    /**
     * **Validates: Requirements 2.4**
     *
     * For any non-empty list of local branches, the Branch Panel SHALL render
     * them in case-insensitive alphabetical order under the "Local" category.
     */
    it('Feature: intellij-git-layout, Property 5: Local branches alphabetical ordering — branches appear in case-insensitive alphabetical order', () => {
      fc.assert(
        fc.property(
          arbitraryLocalBranches(),
          (localBranches) => {
            const data: IBranchPanelData = {
              head: { name: 'main', isDetached: false },
              local: localBranches,
              remote: [],
            };

            const html = provider._getBranchPanelHtml(data);

            // Extract the Local category section (between data-category="local" and data-category="remote")
            const localStart = html.indexOf('data-category="local"');
            const remoteStart = html.indexOf('data-category="remote"');
            assert.ok(localStart > -1, 'HTML should contain Local category');
            assert.ok(remoteStart > localStart, 'Remote category should come after Local category');
            const localSection = html.substring(localStart, remoteStart);

            // Compute expected order: case-insensitive alphabetical
            const expectedOrder = [...localBranches]
              .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
              .map(b => b.name);

            // Verify all branches are present and in the correct order
            let lastIndex = -1;
            for (const name of expectedOrder) {
              // Look for the branch name in the local section using the branch-name span pattern
              const idx = localSection.indexOf(`>${name}<`, lastIndex + 1);
              assert.ok(
                idx > lastIndex,
                `Branch "${name}" should appear after the previous branch in the Local section (found at ${idx}, last was ${lastIndex})`
              );
              lastIndex = idx;
            }
          }
        ),
        { numRuns: 150 }
      );
    });
  });

  describe('Property 6: Remote branches grouped by remote', () => {
    /**
     * **Validates: Requirements 2.5**
     *
     * For any set of remote branches, the Branch Panel SHALL group them by
     * remote name, and each group SHALL contain exactly the branches belonging
     * to that remote.
     */
    it('Feature: intellij-git-layout, Property 6: Remote branches grouped by remote — each remote group contains exactly its branches', () => {
      fc.assert(
        fc.property(
          arbitraryRemoteGroups(),
          (remoteGroups) => {
            const data: IBranchPanelData = {
              head: { name: 'main', isDetached: false },
              local: [],
              remote: remoteGroups,
            };

            const html = provider._getBranchPanelHtml(data);

            // Extract the Remote category section
            const remoteStart = html.indexOf('data-category="remote"');
            assert.ok(remoteStart > -1, 'HTML should contain Remote category');
            const remoteSection = html.substring(remoteStart);

            // Verify each remote group is present
            for (const group of remoteGroups) {
              assert.ok(
                remoteSection.includes(group.remoteName),
                `Remote section should contain remote name "${group.remoteName}"`
              );

              // Find the remote group section in the HTML
              const groupStart = remoteSection.indexOf(`>${group.remoteName}<`);
              assert.ok(
                groupStart > -1,
                `Remote group header for "${group.remoteName}" should be present`
              );

              // Find the boundaries of this group's children
              // The group's branches are in a branch-category-children div after the header
              const childrenStart = remoteSection.indexOf('branch-category-children', groupStart);
              assert.ok(
                childrenStart > -1,
                `Remote group "${group.remoteName}" should have a children container`
              );

              // Find the end of this children div (next branch-remote-group or end of section)
              const nextGroupStart = remoteSection.indexOf('branch-remote-group', childrenStart + 1);
              const groupSection = nextGroupStart > -1
                ? remoteSection.substring(childrenStart, nextGroupStart)
                : remoteSection.substring(childrenStart);

              // Verify each branch in this group is present in the group section
              for (const branch of group.branches) {
                assert.ok(
                  groupSection.includes(branch.name),
                  `Branch "${branch.name}" should be in the "${group.remoteName}" group section`
                );
                // Verify the branch has the correct data-remote attribute
                assert.ok(
                  groupSection.includes(`data-remote="${group.remoteName}"`),
                  `Branches in "${group.remoteName}" group should have data-remote="${group.remoteName}"`
                );
              }
            }

            // Verify no branch appears outside its designated group
            // by checking that each branch name appears in the HTML with the correct data-remote
            for (const group of remoteGroups) {
              for (const branch of group.branches) {
                // Find all occurrences of this branch in the remote section
                // and verify they all have the correct data-remote
                const branchPattern = `data-branch="${branch.name}"`;
                const remotePattern = `data-remote="${group.remoteName}"`;
                const branchIdx = remoteSection.indexOf(branchPattern);
                if (branchIdx > -1) {
                  // Get the surrounding context (the branch-item div)
                  const contextStart = remoteSection.lastIndexOf('<div', branchIdx);
                  const contextEnd = remoteSection.indexOf('>', branchIdx + branchPattern.length);
                  const context = remoteSection.substring(contextStart, contextEnd);
                  assert.ok(
                    context.includes(remotePattern),
                    `Branch "${branch.name}" should have data-remote="${group.remoteName}"`
                  );
                }
              }
            }
          }
        ),
        { numRuns: 150 }
      );
    });
  });
});
