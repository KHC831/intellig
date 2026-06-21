/**
 * / F3 — `parseBranches` parenthesized-pseudo-ref filter property test.
 *
 * The filter rule is `/^\(.*\)$/.test(refname.trim()) → continue`.
 * This property test fuzzes the parenthesized segment with arbitrary
 * strings (UTF-8, ASCII, whitespace, multi-byte) and asserts the
 * invariant: NO IBranch returned by `parseBranches` ever has a `.name`
 * that starts with `(`. The fixture mixes one parenthesized line with
 * normal local + remote lines so the property covers the regular-
 * branch path as well — the filter must not eat real entries.
 *
 * Why a property test in addition to the unit fixtures: git's pseudo-
 * ref strings vary by repo state (`(HEAD detached at <sha>)`,
 * `(no branch, rebasing main)`, `(no branch, bisect started on …)`,
 * `(no branch, cherry-pick of <sha>)`, and future variants). Hand-
 * picking 5 fixtures pins the known shapes; fuzzing the contents
 * pins the predicate itself. A future regression that narrows the
 * filter to `^\(HEAD detached` only would let the bisect/cherry-pick
 * variants leak through and is caught by this test.
 *
 * The property runs at the default sample budget; the property suite's
 * stress mode (`test:property:stress`) cranks numRuns + duration via
 * the existing harness configuration.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { parseBranches } from '../../src/git-core/gitParser';

/**
 * Inner-content fuzzer for parenthesized pseudo-refs. `\n` is the row
 * separator in our line-based parsing — fuzzing it would split the line
 * and produce undefined fixture behavior unrelated to the predicate
 * under test. `|` is reserved as our column separator (see
 * `getBranchFormat`). Excluding both keeps the fuzz aimed at the
 * predicate, not at separator-collision behavior. (Note: git itself
 * accepts both characters in refnames — `git check-ref-format
 * 'refs/heads/foo|bar'` exits 0 — so a real branch with `|` in its
 * name is a pre-existing parser fragility, orthogonal to the
 * pseudo-ref filter under test here.)
 *
 * The remaining char-set is broad enough to cover ASCII + multi-byte
 * UTF-8 + whitespace + punctuation, which is what git actually emits
 * for `(HEAD detached at <sha>)` / `(no branch, …)` and any future
 * variant.
 */
const innerContent = fc.string().filter((s) => !s.includes('|') && !s.includes('\n'));

describe('parseBranches property — Wave F', () => {
  it('no branch name starts with `(` (parenthesized pseudo-refs filtered for any inner content)', () => {
    fc.assert(
      fc.property(innerContent, (parenthesizedSegment) => {
        // Construct an output line with a parenthesized refname mixed
        // with two normal entries (one local, one remote). The
        // parenthesized inner content is arbitrary — the predicate
        // must catch ALL of them. We use a fixed sha because the
        // filter looks at refname only, not commit.
        const lines = [
          `(${parenthesizedSegment})|abc1234567890123456789012345678901234567890||*`,
          `refs/heads/main|def4567890123456789012345678901234567890abc||`,
          `refs/remotes/origin/main|def4567890123456789012345678901234567890abc||`,
        ];
        const result = parseBranches(lines.join('\n'));

        // INVARIANT 1: no surviving branch carries a parenthesized name.
        for (const b of result) {
          if (b.name.startsWith('(')) {
            throw new Error(
              `leaked parenthesized refname: ${JSON.stringify(b.name)} ` +
                `(inner segment was ${JSON.stringify(parenthesizedSegment)})`
            );
          }
        }

        // INVARIANT 2: the two normal entries must be present —
        // the filter must not over-match. (We don't assert
        // length === 2 because some pathological inner content
        // — e.g. `\nrefs/heads/foo` — could split the line and
        // create extra parsed entries; the relevant invariant is
        // simply "main and origin/main both survive".)
        assert.ok(
          result.some((b) => b.name === 'main' && b.type === 'local'),
          `local main must survive the filter; got ${JSON.stringify(result.map((b) => b.name))}`
        );
        assert.ok(
          result.some((b) => b.name === 'origin/main' && b.type === 'remote'),
          `remote origin/main must survive the filter; got ${JSON.stringify(result.map((b) => b.name))}`
        );
      }),
      { numRuns: 200 }
    );
  });

  it('whitespace around the parenthesized refname is also filtered (.trim() coverage)', () => {
    // The filter applies after `.trim()` — git emits clean refname
    // values, but a future format change that pads the column with
    // spaces should still see the pseudo-ref filtered.
    fc.assert(
      fc.property(
        innerContent,
        fc.nat({ max: 4 }),
        fc.nat({ max: 4 }),
        (segment, leftPad, rightPad) => {
          const padded = ' '.repeat(leftPad) + `(${segment})` + ' '.repeat(rightPad);
          const lines = [
            `${padded}|abc1234567890123456789012345678901234567890||*`,
            `refs/heads/main|def4567890123456789012345678901234567890abc||`,
          ];
          const result = parseBranches(lines.join('\n'));
          for (const b of result) {
            if (b.name.trim().startsWith('(')) {
              throw new Error(
                `leaked padded parenthesized refname: ${JSON.stringify(b.name)} ` +
                  `(padded source was ${JSON.stringify(padded)})`
              );
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
