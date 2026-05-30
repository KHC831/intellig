/**
 * Property-based tests for dynamic label substitution correctness.
 *
 * Feature: branch-context-menu, Property 2: Dynamic label substitution correctness
 *
 * For any branch name (right-clicked or current), when a label template containing
 * placeholders is resolved, the resulting label SHALL contain the exact branch name
 * in place of each placeholder. When the current branch is unavailable, the placeholder
 * SHALL resolve to "HEAD".
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import { resolveLabel } from '../../commits/CommandTitleProvider';

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Generate a valid branch name segment (alphanumeric, hyphens, underscores, dots).
 */
function arbitraryBranchSegment(): fc.Arbitrary<string> {
  return fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split('')
    ),
    { minLength: 1, maxLength: 20 }
  );
}

/**
 * Generate a valid branch name including slashes, dots, and special characters.
 * Branch names can have 1-3 segments joined by '/'.
 * Examples: "main", "feature/my-branch", "release/v1.0.0", "user/feature/fix-bug"
 */
function arbitraryBranchName(): fc.Arbitrary<string> {
  return fc
    .array(arbitraryBranchSegment(), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'));
}

/**
 * All dynamic title templates used by CommandTitleProvider.
 * Each entry has a template string and which placeholders it contains.
 */
const TEMPLATES: ReadonlyArray<{
  name: string;
  template: string;
  hasBranch: boolean;
  hasCurrent: boolean;
}> = [
  {
    name: "New Branch from '{branch}'",
    template: "New Branch from '{branch}'",
    hasBranch: true,
    hasCurrent: false,
  },
  {
    name: "Compare with '{current}'",
    template: "Compare with '{current}'",
    hasBranch: false,
    hasCurrent: true,
  },
  {
    name: "Rebase '{current}' onto '{branch}'",
    template: "Rebase '{current}' onto '{branch}'",
    hasBranch: true,
    hasCurrent: true,
  },
  {
    name: "Merge '{branch}' into '{current}'",
    template: "Merge '{branch}' into '{current}'",
    hasBranch: true,
    hasCurrent: true,
  },
  {
    name: "Checkout and Rebase onto '{current}'",
    template: "Checkout and Rebase onto '{current}'",
    hasBranch: false,
    hasCurrent: true,
  },
  {
    name: "Pull into '{current}' Using Rebase",
    template: "Pull into '{current}' Using Rebase",
    hasBranch: false,
    hasCurrent: true,
  },
  {
    name: "Pull into '{current}' Using Merge",
    template: "Pull into '{current}' Using Merge",
    hasBranch: false,
    hasCurrent: true,
  },
];

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('Feature: branch-context-menu - Dynamic Label Substitution Property Tests', () => {
  describe('Property 2: Dynamic label substitution correctness', () => {
    /**
     *
     * For any branch name (right-clicked or current), when a label template
     * containing placeholders is resolved, the resulting label SHALL contain
     * the exact branch name in place of each placeholder.
     */

    for (const tmpl of TEMPLATES) {
      it(`resolveLabel correctly substitutes placeholders in template: ${tmpl.name}`, () => {
        fc.assert(
          fc.property(
            arbitraryBranchName(),
            arbitraryBranchName(),
            (branchName, currentBranchName) => {
              const result = resolveLabel(tmpl.template, branchName, currentBranchName);

              // The result must not contain any remaining placeholders
              assert.ok(
                !result.includes('{branch}'),
                `Resolved label should not contain {branch} placeholder. Got: "${result}"`
              );
              assert.ok(
                !result.includes('{current}'),
                `Resolved label should not contain {current} placeholder. Got: "${result}"`
              );

              // If the template has {branch}, the result must contain the exact branch name
              if (tmpl.hasBranch) {
                assert.ok(
                  result.includes(branchName),
                  `Resolved label should contain branch name "${branchName}". Got: "${result}"`
                );
              }

              // If the template has {current}, the result must contain the exact current branch name
              if (tmpl.hasCurrent) {
                assert.ok(
                  result.includes(currentBranchName),
                  `Resolved label should contain current branch name "${currentBranchName}". Got: "${result}"`
                );
              }
            }
          ),
          { numRuns: 100 }
        );
      });
    }

    it('resolveLabel produces the exact expected string for all templates', () => {
      fc.assert(
        fc.property(
          arbitraryBranchName(),
          arbitraryBranchName(),
          fc.constantFrom(...TEMPLATES),
          (branchName, currentBranchName, tmpl) => {
            const result = resolveLabel(tmpl.template, branchName, currentBranchName);

            // Build the expected result by manually replacing placeholders
            const expected = tmpl.template
              .split('{branch}')
              .join(branchName)
              .split('{current}')
              .join(currentBranchName);

            assert.strictEqual(
              result,
              expected,
              `resolveLabel("${tmpl.template}", "${branchName}", "${currentBranchName}") should equal "${expected}" but got "${result}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     *
     * When the current branch is unavailable (detached HEAD state),
     * the {current} placeholder SHALL resolve to "HEAD".
     */
    it('resolveLabel uses "HEAD" as fallback for current branch in detached HEAD state', () => {
      fc.assert(
        fc.property(
          arbitraryBranchName(),
          fc.constantFrom(...TEMPLATES.filter((t) => t.hasCurrent)),
          (branchName, tmpl) => {
            // In detached HEAD state, the current branch name is "HEAD"
            const currentBranchName = 'HEAD';
            const result = resolveLabel(tmpl.template, branchName, currentBranchName);

            // The result must contain "HEAD" where {current} was
            assert.ok(
              result.includes('HEAD'),
              `Resolved label should contain "HEAD" for detached state. Got: "${result}"`
            );

            // Build the expected result
            const expected = tmpl.template
              .split('{branch}')
              .join(branchName)
              .split('{current}')
              .join('HEAD');

            assert.strictEqual(
              result,
              expected,
              `In detached HEAD state, resolveLabel("${tmpl.template}", "${branchName}", "HEAD") should equal "${expected}" but got "${result}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('resolveLabel handles branch names with special characters (slashes, dots, hyphens)', () => {
      // Use a generator that specifically produces branch names with special characters
      const specialBranchName = fc.oneof(
        // Names with slashes (feature branches)
        fc
          .tuple(
            fc.constantFrom('feature', 'bugfix', 'release', 'hotfix', 'user'),
            arbitraryBranchSegment()
          )
          .map(([prefix, suffix]) => `${prefix}/${suffix}`),
        // Names with dots (version branches)
        fc
          .tuple(
            fc.constantFrom('v', 'release-'),
            fc.nat({ max: 99 }),
            fc.nat({ max: 99 }),
            fc.nat({ max: 99 })
          )
          .map(([prefix, major, minor, patch]) => `${prefix}${major}.${minor}.${patch}`),
        // Names with multiple slashes
        fc
          .tuple(arbitraryBranchSegment(), arbitraryBranchSegment(), arbitraryBranchSegment())
          .map(([a, b, c]) => `${a}/${b}/${c}`),
        // Names with hyphens and underscores
        fc
          .tuple(arbitraryBranchSegment(), fc.constantFrom('-', '_'), arbitraryBranchSegment())
          .map(([a, sep, b]) => `${a}${sep}${b}`)
      );

      fc.assert(
        fc.property(
          specialBranchName,
          specialBranchName,
          fc.constantFrom(...TEMPLATES),
          (branchName, currentBranchName, tmpl) => {
            const result = resolveLabel(tmpl.template, branchName, currentBranchName);

            // Build the expected result
            const expected = tmpl.template
              .split('{branch}')
              .join(branchName)
              .split('{current}')
              .join(currentBranchName);

            assert.strictEqual(
              result,
              expected,
              `resolveLabel with special chars failed for template "${tmpl.template}": expected "${expected}" but got "${result}"`
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
