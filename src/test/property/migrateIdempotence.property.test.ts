/**
 * Property 15: Migration idempotence.
 *
 * **Validates: Requirements 12.3, 14.5**
 *
 * Property 15 (per requirements.md §12.3 + §14.5, design.md
 * "Property 15: Migration idempotence"):
 *
 *   For every state of the working tree (clean pre-change tree,
 *   post-change tree, partially-applied tree), running
 *   `migrate.mjs` once and then running it a second time produces
 *   a byte-identical working tree to running it once. The second
 *   run performs zero file-system mutations.
 *
 * The migration script itself is an ESM Node script that performs
 * real filesystem operations (`fs.rename`, ts-morph `saveSync`).
 * Driving it from a property test would mean spinning up a temp
 * `src/` clone per fast-check iteration — too slow to converge and
 * out of scope for the property layer. Instead, this test pins the
 * **algorithmic** invariants that imply idempotence for the real
 * script:
 *
 *   - **15a — State coverage.** For every plan entry, exactly ONE
 *     of three filesystem states is consistent:
 *       * pending  — `from` exists, `to` absent
 *       * applied  — `from` absent, `to` exists
 *       * identity — `from === to`, file exists
 *     The two forbidden states (partial-applied: both endpoints
 *     present; missing-source: neither endpoint present) are
 *     rejected by `validatePlan` in `migrate.mjs`. The categorize-
 *     and-apply algorithm is total over the three valid states.
 *
 *   - **15b — Fixed-point convergence.** The categorize-and-apply
 *     pipeline maps every valid state to either "applied" or
 *     "identity" — the only fixed points of the categorization
 *     function. Once applied, a second invocation produces zero
 *     pending moves (no further filesystem mutations).
 *
 *   - **15c — Live-plan invariance.** The actual on-disk
 *     `scripts/restructure/plan.json` evaluated against the
 *     current `src/` tree converges in at most one step: the
 *     pre-migration tree categorizes to a mix of pending/applied/
 *     identity, the post-application categorization is purely
 *     applied/identity, and a third application is a no-op.
 *
 * The script's `rewriteImports` step (the ts-morph pass) is also
 * idempotent by construction — ts-morph only writes a source file
 * when its AST text changed since load — but that property is
 * pinned by Property 16 / `migrateImportRewrite.property.test.ts`
 * (task 13.13), not here. This test focuses on the move/categorize
 * pipeline that defines the script's filesystem-level idempotence.
 *
 * @see Requirement 12.3 — WHEN the migration script is run twice
 *      against the post-restructure layout, THE second run SHALL
 *      be a no-op (idempotence).
 * @see Requirement 14.5 — Migration idempotence.
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

/** Categorization of a single plan entry against a virtual filesystem. */
type MoveState = 'pending' | 'applied' | 'identity' | 'partial-applied' | 'missing-source';

// ─── In-test reimplementation of categorize + applyMoves ────────────────────

/**
 * Pure-functional model of `categorizeMoves` from `migrate.mjs`.
 * Operates against an abstract filesystem (a `Set<string>` of
 * present file paths) instead of the real disk so the property
 * test can iterate without I/O.
 *
 * Mirrors the algorithm in `scripts/restructure/migrate.mjs`'s
 * `categorizeMoves` exactly:
 *
 *   - identity (from === to) → 'identity' (file must exist)
 *   - from in fs, to not in fs → 'pending'
 *   - from not in fs, to in fs → 'applied'
 *   - both present → 'partial-applied' (rejected by validatePlan)
 *   - neither present → 'missing-source' (rejected by validatePlan)
 */
function categorizeMove(move: IMove, virtualFs: ReadonlySet<string>): MoveState {
  if (move.from === move.to) {
    // Identity entries: caller's responsibility to ensure the file
    // exists on disk; categorize returns 'identity' regardless and
    // validatePlan handles the "must exist" case separately. We
    // mirror that — return 'identity' if present, 'missing-source'
    // otherwise (the latter caught by validatePlan in the script).
    return virtualFs.has(move.from) ? 'identity' : 'missing-source';
  }
  const fromExists = virtualFs.has(move.from);
  const toExists = virtualFs.has(move.to);
  if (fromExists && !toExists) {
    return 'pending';
  }
  if (!fromExists && toExists) {
    return 'applied';
  }
  if (fromExists && toExists) {
    return 'partial-applied';
  }
  return 'missing-source';
}

/**
 * Pure-functional model of `applyMoves` from `migrate.mjs`. Given
 * a virtual filesystem and a plan, return the new filesystem with
 * every pending move applied (i.e. `from` removed, `to` added).
 *
 * Identity entries and already-applied entries are no-ops on the
 * filesystem (the corresponding files are unchanged). Forbidden
 * states (`partial-applied`, `missing-source`) cause the model to
 * throw — mirroring the script's `process.exit(1)` from
 * `validatePlan`.
 */
function applyPlan(plan: IPlan, virtualFs: ReadonlySet<string>): Set<string> {
  const next = new Set(virtualFs);
  for (const move of plan.moves) {
    const state = categorizeMove(move, virtualFs);
    switch (state) {
      case 'pending':
        next.delete(move.from);
        next.add(move.to);
        break;
      case 'applied':
      case 'identity':
        // No filesystem mutation — file already at its final
        // resting place (or never moves).
        break;
      case 'partial-applied':
        throw new Error(
          `partial-applied state for "${move.from}" → "${move.to}" ` +
            '(both endpoints present); validatePlan rejects this'
        );
      case 'missing-source':
        throw new Error(
          `missing source for "${move.from}" → "${move.to}" ` +
            '(neither endpoint present); validatePlan rejects this'
        );
    }
  }
  return next;
}

/**
 * Recursively walk a directory tree and return every regular file's
 * path *relative to the repository root*, normalized to forward
 * slashes (the same form `plan.json`'s entries use).
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

// ─── fast-check arbitraries ────────────────────────────────────────────────

/**
 * Generate a synthetic plan with `n` move entries, where each move
 * takes the form `dirA/file_i.ts` → `dirB/file_i.ts` (or identity
 * when randomly chosen). The synthetic plan has no path collisions
 * (every `from` and `to` is unique by index) and lives entirely
 * within an abstract virtual namespace — no real files involved.
 *
 * The state of each entry (pending / applied / identity) is drawn
 * by a separate arbitrary so we can independently assert behaviour
 * across all valid combinations.
 */
const syntheticPlanArb = (size: number) =>
  fc.array(
    fc.record({
      kind: fc.constantFrom('pending' as const, 'applied' as const, 'identity' as const),
    }),
    { minLength: size, maxLength: size }
  );

// ─── Property tests ────────────────────────────────────────────────────────

describe('Migration idempotence (Property 15 / Requirements 12.3, 14.5)', () => {
  // ---- 15a: state coverage ------------------------------------------------

  /**
   * Property 15a — state coverage.
   *
   * For every plan entry across every valid initial filesystem
   * state, `categorizeMove` returns exactly one of the three
   * "valid" states (`pending`, `applied`, `identity`). The two
   * "invalid" states (`partial-applied`, `missing-source`) only
   * arise from filesystem configurations that `validatePlan`
   * rejects — we exercise those explicitly to confirm the model
   * matches the script's failure modes.
   */
  it('Property 15a (valid states): pending / applied / identity are total over valid filesystems', () => {
    fc.assert(
      fc.property(
        syntheticPlanArb(5),
        fc.boolean(), // include identity entry?
        (entries, includeIdentity) => {
          // Build a synthetic plan + virtual filesystem from the
          // entry kinds. Each entry gets unique `from`/`to` paths
          // keyed by index so there are no duplicates.
          const moves: IMove[] = [];
          const virtualFs = new Set<string>();

          entries.forEach((e, i) => {
            const from = `src/legacy/file${i}.ts`;
            const to = `src/topical/file${i}.ts`;
            moves.push({ from, to, rationale: `synthetic ${i}` });
            switch (e.kind) {
              case 'pending':
                virtualFs.add(from);
                break;
              case 'applied':
                virtualFs.add(to);
                break;
              case 'identity':
                // Replace this entry's `to` with `from` to make it
                // an identity, and mark the file present.
                moves[moves.length - 1] = { from, to: from, rationale: `synthetic ${i}` };
                virtualFs.add(from);
                break;
            }
          });

          if (includeIdentity) {
            const idPath = 'src/utils/keep.ts';
            moves.push({ from: idPath, to: idPath, rationale: 'identity guard' });
            virtualFs.add(idPath);
          }

          const plan: IPlan = {
            version: 1,
            moves,
            barrelShim: { path: 'x', strategy: 'y' },
          };

          // Every entry categorizes to a valid state — the two
          // forbidden states never appear under this construction.
          for (const m of plan.moves) {
            const state = categorizeMove(m, virtualFs);
            assert.ok(
              state === 'pending' || state === 'applied' || state === 'identity',
              `Property 15a violation: entry ${m.from} → ${m.to} ` +
                `categorized as "${state}" (expected pending/applied/identity)`
            );
          }
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 15a (forbidden states): partial-applied and missing-source are detected', () => {
    // Sanity-check the model: forbidden filesystem configurations
    // (which validatePlan would reject) categorize to the named
    // forbidden states. This pins the model's failure semantics so
    // the property in 15b can rely on it.
    const move: IMove = { from: 'src/a.ts', to: 'src/b.ts', rationale: '' };

    assert.strictEqual(
      categorizeMove(move, new Set(['src/a.ts', 'src/b.ts'])),
      'partial-applied',
      'both endpoints present must categorize as partial-applied'
    );
    assert.strictEqual(
      categorizeMove(move, new Set()),
      'missing-source',
      'neither endpoint present must categorize as missing-source'
    );
  });

  // ---- 15b: fixed-point convergence ---------------------------------------

  /**
   * Property 15b — fixed-point convergence on synthetic plans.
   *
   * For every synthetic plan-and-filesystem pair drawn in any valid
   * initial state, applying the plan once produces a filesystem
   * where every entry is in the "applied" or "identity" state.
   * Applying the plan a second time changes nothing (no pending
   * moves remain).
   *
   * This is the algorithmic core of Requirement 12.3: the second
   * run is a no-op because the categorization function has only
   * "applied" and "identity" as fixed points.
   */
  it('Property 15b: applying the plan once yields a fixed point (zero pending entries on second pass)', () => {
    fc.assert(
      fc.property(syntheticPlanArb(8), (entries) => {
        const moves: IMove[] = [];
        const initialFs = new Set<string>();

        entries.forEach((e, i) => {
          const from = `src/legacy/file${i}.ts`;
          const to = `src/topical/file${i}.ts`;
          switch (e.kind) {
            case 'pending':
              moves.push({ from, to, rationale: '' });
              initialFs.add(from);
              break;
            case 'applied':
              moves.push({ from, to, rationale: '' });
              initialFs.add(to);
              break;
            case 'identity':
              moves.push({ from, to: from, rationale: '' });
              initialFs.add(from);
              break;
          }
        });

        const plan: IPlan = {
          version: 1,
          moves,
          barrelShim: { path: 'x', strategy: 'y' },
        };

        // First application.
        const afterFirst = applyPlan(plan, initialFs);

        // After one pass, every entry is either applied or identity
        // — no pending entries remain. (The algorithm has reached a
        // fixed point of the categorization function.)
        for (const m of plan.moves) {
          const state = categorizeMove(m, afterFirst);
          assert.ok(
            state === 'applied' || state === 'identity',
            `Property 15b violation: after one application, entry ` +
              `${m.from} → ${m.to} is in state "${state}" ` +
              `(expected applied or identity)`
          );
        }

        // Second application — must produce a byte-identical
        // filesystem (no further mutations). This is the literal
        // form of Requirement 12.3.
        const afterSecond = applyPlan(plan, afterFirst);
        assert.deepStrictEqual(
          [...afterSecond].sort(),
          [...afterFirst].sort(),
          'Property 15b violation: second application of the plan ' +
            'produced a different filesystem than the first ' +
            '(Requirement 12.3 / 14.5: second run must be a no-op)'
        );
      }),
      { numRuns: 200 }
    );
  });

  /**
   * Property 15b corollary — one-step convergence from any valid
   * starting state, including a partially-applied tree (some
   * entries pending, some already applied, some identity).
   *
   * Even when the initial filesystem mixes states across the plan,
   * a single application drives the whole tree to the fixed point.
   */
  it('Property 15b (mixed-state initial): mixed pending/applied/identity converges in one pass', () => {
    fc.assert(
      fc.property(syntheticPlanArb(6), (entries) => {
        const moves: IMove[] = [];
        const initialFs = new Set<string>();

        // Force at least one of each kind to appear.
        const forced: ('pending' | 'applied' | 'identity')[] = ['pending', 'applied', 'identity'];
        const allKinds = entries.map((e, i) => (i < forced.length ? forced[i] : e.kind));

        allKinds.forEach((kind, i) => {
          const from = `src/mixed/file${i}.ts`;
          const to = `src/result/file${i}.ts`;
          switch (kind) {
            case 'pending':
              moves.push({ from, to, rationale: '' });
              initialFs.add(from);
              break;
            case 'applied':
              moves.push({ from, to, rationale: '' });
              initialFs.add(to);
              break;
            case 'identity':
              moves.push({ from, to: from, rationale: '' });
              initialFs.add(from);
              break;
          }
        });

        const plan: IPlan = {
          version: 1,
          moves,
          barrelShim: { path: 'x', strategy: 'y' },
        };

        const once = applyPlan(plan, initialFs);
        const twice = applyPlan(plan, once);

        // Idempotence: applying twice == applying once.
        assert.deepStrictEqual(
          [...twice].sort(),
          [...once].sort(),
          'Property 15b violation: mixed-state filesystem did not ' +
            'reach a fixed point after one pass'
        );
      }),
      { numRuns: 100 }
    );
  });

  // ---- 15c: live-plan invariance ------------------------------------------

  /**
   * Property 15c — the live `plan.json` evaluated against the
   * current `src/` tree converges in at most one step.
   *
   * This drives the model with the actual production plan so any
   * regression in `plan.json` (e.g. a duplicate entry, a
   * partial-applied state authored by mistake) surfaces here even
   * if the synthetic generators in 15a/15b would not produce it.
   *
   * The test uses `fc.constantFrom` to wrap the plan's moves so
   * fast-check's reporting convention applies on failure — the
   * counter-example is the single offending entry rather than the
   * whole plan.
   */
  describe('Property 15c (live plan): scripts/restructure/plan.json categorizes consistently against the current src/ tree', () => {
    let plan: IPlan;
    let initialFs: Set<string>;

    before(() => {
      plan = loadPlan();
      initialFs = new Set(walkSrcTree(SRC_DIR));
    });

    it('every live plan entry categorizes to pending / applied / identity (no forbidden states)', () => {
      fc.assert(
        fc.property(fc.constantFrom(...plan.moves), (move) => {
          const state = categorizeMove(move, initialFs);
          assert.ok(
            state === 'pending' || state === 'applied' || state === 'identity',
            `Property 15c violation: live plan entry ` +
              `${move.from} → ${move.to} categorizes as "${state}" ` +
              `against the current src/ tree. Forbidden states ` +
              `(partial-applied, missing-source) indicate a ` +
              `validatePlan-rejecting tree.`
          );
        }),
        { numRuns: plan.moves.length }
      );
    });

    it('applying the live plan twice equals applying it once (idempotence over the real plan)', () => {
      // Single-shot, deterministic check (no fast-check generator):
      // the plan and the tree are both fixed inputs, so a property
      // iteration would test the same input N times. The
      // assertion is the literal byte-equality form of
      // Requirement 12.3.
      const once = applyPlan(plan, initialFs);
      const twice = applyPlan(plan, once);

      assert.deepStrictEqual(
        [...twice].sort(),
        [...once].sort(),
        'Property 15c violation: applying the live plan a second ' +
          'time produced a different filesystem than the first. ' +
          'Requirement 12.3 / 14.5: the migration must be idempotent.'
      );
    });

    it('after one application of the live plan, no entry remains in the pending state', () => {
      const once = applyPlan(plan, initialFs);
      fc.assert(
        fc.property(fc.constantFrom(...plan.moves), (move) => {
          const state = categorizeMove(move, once);
          assert.ok(
            state === 'applied' || state === 'identity',
            `Property 15c violation: after one application of the ` +
              `live plan, entry ${move.from} → ${move.to} is in ` +
              `state "${state}" (expected applied or identity). ` +
              `The migration has not reached a fixed point.`
          );
        }),
        { numRuns: plan.moves.length }
      );
    });
  });
});
