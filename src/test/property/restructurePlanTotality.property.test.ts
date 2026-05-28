/**
 * Task 12.3 — Property 13: Plan-coverage totality.
 *
 * **Validates: Requirements 9.1, 14.6**
 *
 * Property 13 (per requirements.md §9.1 + §14.6):
 *
 *   FOR EVERY file `f` under `src/` in the pre-change tree, the
 *   Restructure_Plan SHALL contain exactly one entry with `f` as
 *   its `from` path.
 *
 * In other words: `scripts/restructure/plan.json`'s `moves` array
 * is a *total* function over the current `src/` tree — every file
 * that exists on disk under `src/` is mentioned exactly once as a
 * `from` path, and no `from` entry refers to a file that is not on
 * disk.
 *
 * This is a "totality"-style property where the universal
 * quantifier ranges over a finite, discoverable set (the regular
 * files under `src/`), not random data. fast-check's role here is
 * to drive the assertion across the discovered set with shrinking
 * — if the test fails, fast-check converges on the single offending
 * path rather than dumping the whole 387-entry diff. We use
 * `fc.constantFrom(...filesUnderSrc)` to wrap the file set in a
 * fast-check arbitrary so the property layer's reporting convention
 * still applies.
 *
 * The plan-shape invariants (uniqueness of `from`/`to`, presence of
 * `barrelShim`, identity entries for `src/test/**` and
 * `src/extension.ts`) are pinned by the unit test
 * `src/test/unit/scripts/restructure/planShape.test.ts` (task 12.2).
 * This property test is intentionally narrow: it asserts only the
 * coverage relation between disk and plan.
 *
 * @see Requirement 9.1 — THE IntelliG_Extension SHALL produce a
 *      Restructure_Plan that maps every existing path in `src/`
 *      to exactly one new path under `src/`.
 * @see Requirement 14.6 — Plan-coverage totality.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as path from 'path';

// ─── Plan + tree fixtures ──────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const PLAN_PATH = path.join(REPO_ROOT, 'scripts', 'restructure', 'plan.json');
const SRC_DIR = path.join(REPO_ROOT, 'src');

interface IMove {
  readonly from: string;
  readonly to: string;
  readonly rationale: string;
}

interface IPlan {
  readonly version: number;
  readonly moves: readonly IMove[];
  readonly barrelShim: { readonly path: string; readonly strategy: string };
}

/**
 * Recursively walk a directory tree and return every regular file's
 * path *relative to the repository root*, normalized to forward
 * slashes (the same form `plan.json`'s `from` entries use). Symbolic
 * links and non-regular entries are skipped — the plan only tracks
 * source files that ts-morph or the migration's `fs.rename` would
 * move.
 */
function walkSrcTree(root: string): readonly string[] {
  const out: string[] = [];

  function visit(dir: string): void {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        visit(full);
      } else if (ent.isFile()) {
        const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
        out.push(rel);
      }
      // Symbolic links and other entry kinds intentionally ignored:
      // the plan only tracks regular files.
    }
  }

  visit(root);
  out.sort();
  return out;
}

function loadPlan(): IPlan {
  const raw = fs.readFileSync(PLAN_PATH, 'utf8');
  return JSON.parse(raw) as IPlan;
}

// ─── Property test ─────────────────────────────────────────────────────────

describe('Restructure_Plan plan-coverage totality (Property 13 / Requirements 9.1, 14.6)', () => {
  let plan: IPlan;
  let filesUnderSrc: readonly string[];
  let planFromSet: ReadonlySet<string>;
  let fromCounts: ReadonlyMap<string, number>;

  before(() => {
    plan = loadPlan();
    filesUnderSrc = walkSrcTree(SRC_DIR);

    // Build the lookup structures once. The property iterations only
    // read these — no mutation across runs.
    const counts = new Map<string, number>();
    for (const m of plan.moves) {
      counts.set(m.from, (counts.get(m.from) ?? 0) + 1);
    }
    fromCounts = counts;
    planFromSet = new Set(plan.moves.map((m) => m.from));
  });

  /**
   * Property 13 (forward direction):
   *   ∀ file f ∈ walk(src/) . f ∈ {move.from : move ∈ plan.moves}
   *
   * Wrap the discovered file set in `fc.constantFrom` so fast-check
   * drives the assertion across every file and shrinks to the
   * single missing one on failure. `numRuns` is set to the size of
   * the file set so every file is exercised at least once (with
   * fast-check's deduplication this means each file is tested
   * exactly once when the seed is exhaustive enough).
   */
  it('Property 13 (forward): every file under src/ appears as a `from` entry in plan.moves', () => {
    assert.ok(
      filesUnderSrc.length > 0,
      'walkSrcTree(src/) returned no files — fixture is broken'
    );

    fc.assert(
      fc.property(fc.constantFrom(...filesUnderSrc), (file) => {
        assert.ok(
          planFromSet.has(file),
          `Requirement 9.1/14.6 violation: file '${file}' exists on ` +
            `disk under src/ but is not present as a \`from\` entry ` +
            `in scripts/restructure/plan.json. Every file under src/ ` +
            `must be covered by exactly one plan entry.`
        );
      }),
      // Drive the property across every discovered file. Using the
      // file-set size as numRuns gives fast-check enough budget to
      // pick each value at least once with high probability.
      { numRuns: filesUnderSrc.length }
    );
  });

  /**
   * Property 13 (uniqueness side):
   *   ∀ file f ∈ walk(src/) . |{move ∈ plan.moves : move.from === f}| === 1
   *
   * Requirement 9.1's "exactly one entry" pins both presence
   * (forward direction above) AND uniqueness. The plan-shape unit
   * test in task 12.2 already asserts no duplicate `from` across
   * the whole plan; this property re-checks the uniqueness-when-
   * intersected-with-disk slice so the two checks fail with focused
   * messages on regression.
   */
  it('Property 13 (uniqueness): every disk file appears exactly once in plan.moves', () => {
    fc.assert(
      fc.property(fc.constantFrom(...filesUnderSrc), (file) => {
        const count = fromCounts.get(file) ?? 0;
        assert.strictEqual(
          count,
          1,
          `Requirement 9.1/14.6 violation: file '${file}' under src/ ` +
            `appears ${count} times as a \`from\` entry in ` +
            `scripts/restructure/plan.json (expected exactly 1).`
        );
      }),
      { numRuns: filesUnderSrc.length }
    );
  });

  /**
   * Property 13 (reverse direction):
   *   ∀ move ∈ plan.moves . move.from ∈ walk(src/)
   *
   * The plan must not refer to phantom files. If a `from` entry
   * names a path that does not exist on disk, the migration script's
   * `fs.rename(from, to)` step would fail at runtime; we want that
   * caught by the property test before the migration ever runs. The
   * one allowable exception is identity entries (`from === to`) for
   * which the file existing post-migration counts as the same set —
   * but pre-migration every `from` (identity or not) must point at a
   * real file in the current tree, since the plan is authored
   * against the current pre-migration tree (Requirement 9.1).
   */
  it('Property 13 (reverse): every `from` entry in plan.moves names a real file on disk', () => {
    const treeSet = new Set(filesUnderSrc);

    fc.assert(
      fc.property(fc.constantFrom(...plan.moves), (move) => {
        assert.ok(
          treeSet.has(move.from),
          `scripts/restructure/plan.json contains an entry whose ` +
            `\`from\` path '${move.from}' does not exist on disk under ` +
            `src/. The plan must be authored against the current ` +
            `pre-migration tree (Requirement 9.1).`
        );
      }),
      { numRuns: plan.moves.length }
    );
  });

  /**
   * Direct exhaustive cross-check: the set of files under `src/` is
   * equal to the set of `from` paths in `plan.moves`. This is the
   * compact, byte-for-byte version of the three properties above
   * — kept because if it ever fails, the diff between the two sets
   * is the most useful possible failure message (vs. a single-file
   * counterexample from a property iteration).
   *
   * The assertion compares sorted arrays via `deepStrictEqual` so a
   * missing or extra entry surfaces with full context, not just the
   * shrunk fast-check witness.
   */
  it('the set of files under src/ equals the set of `from` entries in plan.moves', () => {
    const fromsSorted = [...new Set(plan.moves.map((m) => m.from))].sort();
    const treeSorted = [...filesUnderSrc].sort();
    assert.deepStrictEqual(
      fromsSorted,
      treeSorted,
      'plan.moves `from` set does not equal the set of files under ' +
        'src/. Inspect the diff above for missing or extra entries ' +
        '(Requirement 9.1, 14.6).'
    );
  });
});
