/**
 * Unit tests for `scripts/restructure/plan.json` — the deterministic
 * Restructure_Plan that drives `scripts/restructure/migrate.mjs`.
 *
 * These tests pin the plan's *shape* invariants (Requirement 9.2,
 * 9.3, 9.4, 12.1 from the logging-and-src-restructure spec):
 *
 *   - The plan is JSON with `version === 1`, a `moves` array of
 *     `{ from, to, rationale }` entries, and a `barrelShim` block.
 *   - The `barrelShim` keeps the public services barrel at its
 *     original path (`src/services/index.ts`) and declares a
 *     `strategy` field (so consumers — and the migration script —
 *     can ratchet the rewrite mode).
 *   - The test-suite layout (`src/test/**`) and the extension
 *     entry point (`src/extension.ts`) appear as *identity*
 *     entries (`from === to`), matching the requirements that
 *     forbid those paths from moving (9.2 + 9.3).
 *   - Every `from` is unique, and every `to` is unique. The
 *     migration script's idempotence (12.3) and ts-morph import
 *     rewriter (12.5) both depend on this.
 *
 * The behavioural side of the migration (rename + import rewrite +
 * unmapped-path guard) is covered separately by tasks 13.8 / 13.9 /
 * the property-test in 12.3.
 */

import '../../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const PLAN_PATH = path.join(REPO_ROOT, 'scripts', 'restructure', 'plan.json');

interface Move {
  from: string;
  to: string;
  rationale: string;
}

interface BarrelShim {
  path: string;
  strategy: string;
}

interface Plan {
  version: number;
  moves: Move[];
  barrelShim: BarrelShim;
}

/**
 * Read and JSON.parse the plan once for the whole describe block.
 * The plan is small (~12 KB) and the assertions below all read it
 * — caching the parse result keeps the test ordering robust if the
 * file is touched between describes (it isn't, in CI, but the cache
 * also makes intent obvious).
 */
function loadPlan(): Plan {
  const raw = fs.readFileSync(PLAN_PATH, 'utf8');
  return JSON.parse(raw) as Plan;
}

describe('scripts/restructure/plan.json — shape invariants', () => {
  let plan: Plan;

  before(() => {
    plan = loadPlan();
  });

  describe('top-level schema', () => {
    it('version === 1', () => {
      assert.strictEqual(
        plan.version,
        1,
        `expected plan.version === 1; got ${String(plan.version)}`
      );
    });

    it('moves is a non-empty array', () => {
      assert.ok(Array.isArray(plan.moves), 'plan.moves is not an array');
      assert.ok(
        plan.moves.length > 0,
        'plan.moves is empty (Requirement 9.1: every src/ file is mapped)'
      );
    });

    it('every move entry has string `from`, `to`, and `rationale` fields', () => {
      for (const [i, m] of plan.moves.entries()) {
        assert.strictEqual(
          typeof m.from,
          'string',
          `moves[${i}].from is not a string: ${JSON.stringify(m)}`
        );
        assert.strictEqual(
          typeof m.to,
          'string',
          `moves[${i}].to is not a string: ${JSON.stringify(m)}`
        );
        assert.strictEqual(
          typeof m.rationale,
          'string',
          `moves[${i}].rationale is not a string: ${JSON.stringify(m)}`
        );
        assert.ok(
          m.from.length > 0,
          `moves[${i}].from is empty: ${JSON.stringify(m)}`
        );
        assert.ok(
          m.to.length > 0,
          `moves[${i}].to is empty: ${JSON.stringify(m)}`
        );
        assert.ok(
          m.rationale.length > 0,
          `moves[${i}].rationale is empty: ${JSON.stringify(m)}`
        );
      }
    });

    it('every move entry has only the three documented fields', () => {
      // Reject accidental field additions; the schema is closed by
      // design (the migration script consumes only these three).
      const allowed = new Set(['from', 'to', 'rationale']);
      for (const [i, m] of plan.moves.entries()) {
        for (const k of Object.keys(m as unknown as Record<string, unknown>)) {
          assert.ok(
            allowed.has(k),
            `moves[${i}] has unexpected field "${k}": ${JSON.stringify(m)}`
          );
        }
      }
    });
  });

  describe('barrelShim block', () => {
    it('is present', () => {
      assert.ok(
        plan.barrelShim,
        'plan.barrelShim is missing (design.md §Restructure_Plan)'
      );
    });

    it('has path === "src/services/index.ts" (Requirement 10.1, 10.2)', () => {
      assert.strictEqual(
        plan.barrelShim.path,
        'src/services/index.ts',
        `expected barrelShim.path === "src/services/index.ts"; ` +
          `got "${plan.barrelShim.path}"`
      );
    });

    it('has a non-empty `strategy` string', () => {
      assert.strictEqual(
        typeof plan.barrelShim.strategy,
        'string',
        `barrelShim.strategy is not a string: ` +
          `${JSON.stringify(plan.barrelShim.strategy)}`
      );
      assert.ok(
        plan.barrelShim.strategy.length > 0,
        'barrelShim.strategy is empty'
      );
    });
  });

  describe('identity entries (Requirement 9.2, 9.3)', () => {
    it('src/extension.ts appears as an identity entry (from === to)', () => {
      const ext = plan.moves.find((m) => m.from === 'src/extension.ts');
      assert.ok(ext, 'plan does not contain an entry for src/extension.ts');
      assert.strictEqual(
        ext.to,
        'src/extension.ts',
        `src/extension.ts must be an identity entry; got to="${ext.to}"`
      );
    });

    it('every src/test/** entry is an identity entry (from === to)', () => {
      const testEntries = plan.moves.filter((m) =>
        m.from.startsWith('src/test/')
      );
      assert.ok(
        testEntries.length > 0,
        'plan contains no src/test/** entries (Requirement 9.3)'
      );
      const moved = testEntries.filter((m) => m.from !== m.to);
      assert.deepStrictEqual(
        moved,
        [],
        `every src/test/** entry must be an identity entry, but the ` +
          `following moved:\n` +
          moved.map((m) => `  ${m.from} -> ${m.to}`).join('\n')
      );
    });

    it('every src/test/** to-path stays under src/test/ (no leakage)', () => {
      const leaks = plan.moves.filter(
        (m) => m.from.startsWith('src/test/') && !m.to.startsWith('src/test/')
      );
      assert.deepStrictEqual(
        leaks,
        [],
        `src/test/** entries leaked outside src/test/:\n` +
          leaks.map((m) => `  ${m.from} -> ${m.to}`).join('\n')
      );
    });
  });

  describe('uniqueness (Requirement 12.1)', () => {
    it('no duplicate `from` paths', () => {
      const seen = new Map<string, number>();
      const dups: string[] = [];
      for (const m of plan.moves) {
        const prev = seen.get(m.from);
        if (prev !== undefined) {
          dups.push(m.from);
        } else {
          seen.set(m.from, 1);
        }
      }
      assert.deepStrictEqual(
        dups,
        [],
        `duplicate \`from\` paths in plan.moves:\n` +
          dups.map((p) => `  ${p}`).join('\n')
      );
    });

    it('no duplicate `to` paths', () => {
      const seen = new Map<string, number>();
      const dups: string[] = [];
      for (const m of plan.moves) {
        const prev = seen.get(m.to);
        if (prev !== undefined) {
          dups.push(m.to);
        } else {
          seen.set(m.to, 1);
        }
      }
      assert.deepStrictEqual(
        dups,
        [],
        `duplicate \`to\` paths in plan.moves:\n` +
          dups.map((p) => `  ${p}`).join('\n')
      );
    });
  });
});
