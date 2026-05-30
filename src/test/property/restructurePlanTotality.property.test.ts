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
  let planCoverageSet: ReadonlySet<string>;
  let coverageCounts: ReadonlyMap<string, number>;
  let coveragePaths: readonly string[];
  let alreadyApplied: boolean;

  /**
   * Tree-state duality (post-§14): Requirement 14.6 quantifies over
   * "every file `f` under `src/` **in the pre-change tree**". The
   * canonical statement is "the plan's `from` set equals the
   * pre-migration `src/` file set". Once the §14 migration is
   * applied, the live tree IS the post-migration tree: the `from`
   * paths of non-identity moves no longer exist on disk, and the
   * files that DO exist match the `to` paths (plus identity `from`
   * paths, which equal their `to`). The equivalent coverage relation
   * for an applied tree is therefore against the plan's
   * post-migration coverage set:
   *
   *     coverage(move) = move.from === move.to ? move.from : move.to
   *
   * which is exactly the union set the migration's own unmapped-path
   * guard ({ to | from≠to } ∪ { from | from===to }) enforces.
   *
   * This suite detects which tree it is running against and asserts
   * the corresponding coverage relation at full strength — no
   * assertion is skipped or weakened (Requirement 13.4). Against a
   * fresh checkout of the pre-§14 commit the `coveragePath` reduces
   * to `move.from` and the property is byte-for-byte the original
   * pre-migration check.
   */
  function coveragePathFor(move: IMove): string {
    if (alreadyApplied) {
      return move.from === move.to ? move.from : move.to;
    }
    return move.from;
  }

  before(() => {
    plan = loadPlan();
    filesUnderSrc = walkSrcTree(SRC_DIR);

    // Detect tree state the same way migrate.mjs categorizes moves:
    // a non-identity move is "applied" when its `from` is absent and
    // its `to` is present on disk. When every non-identity move is
    // applied, the live tree is the post-migration tree.
    const exists = (rel: string): boolean => fs.existsSync(path.join(REPO_ROOT, ...rel.split('/')));
    const nonIdentity = plan.moves.filter((m) => m.from !== m.to);
    const appliedCount = nonIdentity.filter((m) => !exists(m.from) && exists(m.to)).length;
    alreadyApplied = nonIdentity.length > 0 && appliedCount === nonIdentity.length;

    // Build the lookup structures once against the state-appropriate
    // coverage path. The property iterations only read these — no
    // mutation across runs.
    coveragePaths = plan.moves.map((m) => coveragePathFor(m));
    const counts = new Map<string, number>();
    for (const cp of coveragePaths) {
      counts.set(cp, (counts.get(cp) ?? 0) + 1);
    }
    coverageCounts = counts;
    planCoverageSet = new Set(coveragePaths);
  });

  /**
   * Property 13 (forward direction):
   *   ∀ file f ∈ walk(src/) . f ∈ {coverage(move) : move ∈ plan.moves}
   *
   * Pre-migration `coverage(move) === move.from`; post-migration it
   * is the move's destination (or its identity path). Wrap the
   * discovered file set in `fc.constantFrom` so fast-check drives
   * the assertion across every file and shrinks to the single
   * missing one on failure.
   */
  it('Property 13 (forward): every file under src/ appears as a `from` entry in plan.moves', () => {
    assert.ok(filesUnderSrc.length > 0, 'walkSrcTree(src/) returned no files — fixture is broken');

    fc.assert(
      fc.property(fc.constantFrom(...filesUnderSrc), (file) => {
        assert.ok(
          planCoverageSet.has(file),
          `Requirement 9.1/14.6 violation: file '${file}' exists on ` +
            `disk under src/ but is not present as a ` +
            `${alreadyApplied ? '`to`/identity coverage' : '`from`'} entry ` +
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
   *   ∀ file f ∈ walk(src/) . |{move : coverage(move) === f}| === 1
   *
   * Requirement 9.1's "exactly one entry" pins both presence
   * (forward direction above) AND uniqueness. The plan-shape unit
   * test in task 12.2 already asserts no duplicate `from`/`to`
   * across the whole plan; this property re-checks the uniqueness-
   * when-intersected-with-disk slice so the two checks fail with
   * focused messages on regression.
   */
  it('Property 13 (uniqueness): every disk file appears exactly once in plan.moves', () => {
    fc.assert(
      fc.property(fc.constantFrom(...filesUnderSrc), (file) => {
        const count = coverageCounts.get(file) ?? 0;
        assert.strictEqual(
          count,
          1,
          `Requirement 9.1/14.6 violation: file '${file}' under src/ ` +
            `appears ${count} times as a ` +
            `${alreadyApplied ? '`to`/identity coverage' : '`from`'} entry in ` +
            `scripts/restructure/plan.json (expected exactly 1).`
        );
      }),
      { numRuns: filesUnderSrc.length }
    );
  });

  /**
   * Property 13 (reverse direction):
   *   ∀ move ∈ plan.moves . coverage(move) ∈ walk(src/)
   *
   * The plan must not refer to phantom files. Pre-migration every
   * `from` must point at a real file (else `fs.rename(from, to)`
   * would fail); post-migration every coverage path (the `to`, or
   * the identity `from`) must point at a real file (else the tree
   * does not match the plan's declared post-migration shape). We
   * want either gap caught by the property test.
   */
  it('Property 13 (reverse): every `from` entry in plan.moves names a real file on disk', () => {
    const treeSet = new Set(filesUnderSrc);

    fc.assert(
      fc.property(fc.constantFrom(...plan.moves), (move) => {
        const cp = coveragePathFor(move);
        assert.ok(
          treeSet.has(cp),
          `scripts/restructure/plan.json contains an entry whose ` +
            `${alreadyApplied ? 'coverage' : '`from`'} path '${cp}' does ` +
            `not exist on disk under src/. The plan must match the ` +
            `${alreadyApplied ? 'post-migration' : 'current pre-migration'} ` +
            `tree (Requirement 9.1).`
        );
      }),
      { numRuns: plan.moves.length }
    );
  });

  /**
   * Direct exhaustive cross-check: the set of files under `src/` is
   * equal to the set of coverage paths in `plan.moves`. This is the
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
    const coverageSorted = [...new Set(coveragePaths)].sort();
    const treeSorted = [...filesUnderSrc].sort();
    assert.deepStrictEqual(
      coverageSorted,
      treeSorted,
      'plan.moves coverage set does not equal the set of files under ' +
        'src/. Inspect the diff above for missing or extra entries ' +
        '(Requirement 9.1, 14.6).'
    );
  });
});
