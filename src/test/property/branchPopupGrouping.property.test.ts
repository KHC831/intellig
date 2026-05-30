/**
 * Property tests for T3-11 — Auto-group-by-`/` regression coverage.
 *
 * The T1-10 Branches popup redesign added an auto-indent behavior for
 * branches that share a `/`-prefix with ≥ AUTO_INDENT_MIN_GROUP_SIZE
 * siblings. T3-11 verifies that behaviour holds over arbitrary branch
 * sets so a future edit can't silently break it.
 *
 * Properties:
 *   1. `detectIndentablePrefixes` returns exactly the set of prefixes
 *      whose sibling-count is ≥ AUTO_INDENT_MIN_GROUP_SIZE.
 *   2. `formatBranchLabel` indents a branch iff its name starts with a
 *      qualifying prefix AND the branch isn't the current one.
 *   3. The current branch is always prefixed with `● ` regardless of
 *      whether it matches an indentable prefix.
 *   4. Mixed prefixes — only groups meeting the threshold get indented;
 *      sub-threshold groups stay flat.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  AUTO_INDENT_MIN_GROUP_SIZE,
  detectIndentablePrefixes,
  formatBranchLabel,
} from '../../branches/BranchPopup';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

/** A single path segment (no `/`). Alphanumeric + `-` + `_`. */
const segment = fc
  .stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
    ),
    { minLength: 1, maxLength: 12 }
  )
  .filter((s) => s.length > 0);

/**
 * A branch name: either a single segment (`main`) or a two-segment path
 * (`feature/x`). Three-segment names would also work, but keeping this
 * small makes the shrinker output easier to read.
 */
const branchName = fc.oneof(
  segment,
  fc.tuple(segment, segment).map(([a, b]) => `${a}/${b}`)
);

/** A small array of unique branch names. */
const branchNameSet = fc
  .array(branchName, { minLength: 0, maxLength: 12 })
  .map((arr) => Array.from(new Set(arr)));

// ─── Property 1: detectIndentablePrefixes threshold invariant ────────────────

describe('T3-11 property — detectIndentablePrefixes', () => {
  it('returns exactly the set of `<prefix>/` groups with ≥ threshold siblings', () => {
    return fc.assert(
      fc.property(branchNameSet, (names) => {
        const prefixes = detectIndentablePrefixes(names);
        // Manually count how many branches start with each distinct prefix.
        const counts = new Map<string, number>();
        for (const name of names) {
          const slash = name.indexOf('/');
          if (slash <= 0) {
            continue;
          }
          const prefix = name.substring(0, slash + 1);
          counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
        }
        const expected = new Set<string>();
        for (const [prefix, count] of counts) {
          if (count >= AUTO_INDENT_MIN_GROUP_SIZE) {
            expected.add(prefix);
          }
        }
        // Equality: both sets must contain the same prefixes.
        assert.strictEqual(
          prefixes.size,
          expected.size,
          `expected ${expected.size} prefixes, got ${prefixes.size}`
        );
        for (const p of expected) {
          assert.ok(prefixes.has(p), `missing expected prefix ${p}`);
        }
        for (const p of prefixes) {
          assert.ok(expected.has(p), `unexpected prefix ${p}`);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('never returns a prefix when all sibling counts are below threshold', () => {
    // Bounded generator: at most (threshold - 1) branches per prefix.
    const atMostSubThreshold = fc
      .array(
        fc.tuple(segment, segment).map(([a, b]) => `${a}/${b}`),
        { minLength: 0, maxLength: AUTO_INDENT_MIN_GROUP_SIZE - 1 }
      )
      .map((names) => Array.from(new Set(names)));
    return fc.assert(
      fc.property(atMostSubThreshold, (names) => {
        // With at most `threshold - 1` total branches, no prefix can reach
        // the threshold even if they all share one.
        const prefixes = detectIndentablePrefixes(names);
        assert.strictEqual(prefixes.size, 0);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 2: formatBranchLabel indent invariant ──────────────────────────

describe('T3-11 property — formatBranchLabel', () => {
  it('indents non-current branches iff their name starts with an indentable prefix', () => {
    return fc.assert(
      fc.property(branchNameSet, (names) => {
        const prefixes = detectIndentablePrefixes(names);
        for (const name of names) {
          const label = formatBranchLabel(name, prefixes, /* isCurrent */ false);
          const indented = label.startsWith('  ');
          const shouldIndent = Array.from(prefixes).some((p) => name.startsWith(p));
          assert.strictEqual(
            indented,
            shouldIndent,
            `name="${name}" label="${label}" shouldIndent=${shouldIndent}`
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  it('always marks the current branch with `● ` regardless of indent group', () => {
    return fc.assert(
      fc.property(branchNameSet, (names) => {
        const prefixes = detectIndentablePrefixes(names);
        for (const name of names) {
          const label = formatBranchLabel(name, prefixes, /* isCurrent */ true);
          assert.ok(
            label.startsWith('● '),
            `current branch '${name}' should start with '● ', got: "${label}"`
          );
          assert.ok(
            !label.startsWith('  '),
            `current branch must not be indented, got: "${label}"`
          );
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 3: mixed-prefix case ───────────────────────────────────────────

describe('T3-11 property — mixed-prefix regression', () => {
  it('only indents branches in qualifying groups; sub-threshold groups stay flat', () => {
    return fc.assert(
      fc.property(
        fc.tuple(
          // Generate 0..5 names for group A
          fc.array(segment, { minLength: 0, maxLength: 5 }),
          // Generate 0..5 names for group B
          fc.array(segment, { minLength: 0, maxLength: 5 }),
          // Two distinct prefix labels
          segment,
          segment
        ),
        ([aLeaves, bLeaves, aPrefix, bPrefix]) => {
          fc.pre(aPrefix !== bPrefix);
          const dedupA = Array.from(new Set(aLeaves));
          const dedupB = Array.from(new Set(bLeaves));
          const aNames = dedupA.map((leaf) => `${aPrefix}/${leaf}`);
          const bNames = dedupB.map((leaf) => `${bPrefix}/${leaf}`);
          const all = Array.from(new Set([...aNames, ...bNames]));
          const prefixes = detectIndentablePrefixes(all);

          const aQualifies = dedupA.length >= AUTO_INDENT_MIN_GROUP_SIZE;
          const bQualifies = dedupB.length >= AUTO_INDENT_MIN_GROUP_SIZE;

          assert.strictEqual(
            prefixes.has(`${aPrefix}/`),
            aQualifies,
            `A-group qualification mismatch — size=${dedupA.length}`
          );
          assert.strictEqual(
            prefixes.has(`${bPrefix}/`),
            bQualifies,
            `B-group qualification mismatch — size=${dedupB.length}`
          );
        }
      ),
      { numRuns: 200 }
    );
  });
});
