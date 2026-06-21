/**
 * Property test for Logger level-admission monotonicity.
 *
 * **Property 5: Level admission monotonicity**
 *
 * The rule:
 *
 * > WHEN `intellig.log.level` transitions from level L1 to a stricter
 * > level L2 (>), THE Logger SHALL admit a strict subset of the
 * > records it admitted at L1; THE Logger SHALL NOT admit a record at
 * > level L < L2 after the transition.
 *
 *
 * ### Approach
 *
 * The acceptance criterion is a property over level *transitions*. The
 * cleanest unit for the property is the Logger's level resolver
 * (`LogLevelResolver` in `src/utils/logger/levels.ts`) — it is the
 * single component the Logger consults on the hot path (Requirement
 * 7.1, 7.3) and the single component re-read on every
 * `vscode.workspace.onDidChangeConfiguration` event.
 *
 * The test drives transitions by writing
 * `setMockConfigValue('intellig', 'log.level', T)` and calling
 * `resolver.refresh()` — exactly the path
 * `initLogger`'s configuration listener takes in production. For each
 * generated `` pair with `L2` strictly stricter than `L1`, we
 * compute the admit set at each threshold across all five record
 * levels and assert:
 *
 * 1. **Strict subset**: `admit ⊊ admit`.
 *   2. **Floor by L2**: every record level `L < L2` (i.e.
 *      `LEVEL_RANK[L] < LEVEL_RANK[L2]`) is rejected after the
 *      transition.
 *   3. **Single-direction stability**: re-applying L1 returns the
 *      original admit set (no resolver-internal hysteresis).
 *
 * The `'off'` threshold deserves its own pin: it
 * always admits the empty set, satisfying both clauses for any L1.
 *
 * ### Generators
 *
 * - `thresholdArb`: one of the six valid `LogThreshold` strings.
 * - `pairArb`: a pair `` with `LEVEL_RANK[L2] > LEVEL_RANK[L1]`,
 *   constructed via `fc.tuple` + `filter` so fast-check shrinks toward
 *   adjacent pairs (e.g. `('info', 'warn')`) when a counterexample
 *   exists.
 * - `recordLevelArb`: the five `LogLevel` strings (no `'off'` — a
 *   record can never be at level `'off'`, see `levels.ts` docstring).
 *
 * ### Isolation
 *
 * Each iteration constructs a fresh `LogLevelResolver`, so cross-test
 * state in the resolver's `invalidLevelWarned` set or threshold cache
 * cannot leak between runs. `resetMockConfiguration()` runs in
 * `beforeEach` to clear any prior `setMockConfigValue` writes, and
 * `__resetLoggerForTest()` runs in `afterEach` so any sibling test
 * that touches the module-level Logger singleton starts clean.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';

import {
  LEVEL_RANK,
  LogLevelResolver,
  type LogLevel,
  type LogThreshold,
} from '../../src/utils/logger/levels';
import { __resetLoggerForTest } from '../../src/utils/logger';
import { resetMockConfiguration, setMockConfigValue } from '../mocks/vscode';

/**
 * The five record-level severities. A record can never be at level
 * `'off'` (`'off'` is a *threshold* value only — see `levels.ts`),
 * so we enumerate over the five admissible record levels.
 */
const RECORD_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

/**
 * The six valid `LogThreshold` strings, matching the
 * `package.json` `intellig.log.level` enum.
 */
const ALL_THRESHOLDS: readonly LogThreshold[] = ['trace', 'debug', 'info', 'warn', 'error', 'off'];

/**
 * Arbitrary over the six valid `LogThreshold` strings.
 */
const thresholdArb: fc.Arbitrary<LogThreshold> = fc.constantFrom(...ALL_THRESHOLDS);

/**
 * Arbitrary over `` pairs where `L2` is strictly stricter
 * than `L1` (`LEVEL_RANK[] > LEVEL_RANK[]`). Constrained by
 * `filter` rather than constructed-by-index so fast-check's shrinker
 * can walk both axes independently and home in on minimal
 * counterexamples (e.g. `('info', 'warn')`).
 */
const stricterPairArb: fc.Arbitrary<readonly [LogThreshold, LogThreshold]> = fc
  .tuple(thresholdArb, thresholdArb)
  .filter(([l1, l2]) => LEVEL_RANK[l2] > LEVEL_RANK[l1]);

/**
 * Compute the set of record levels admitted by `resolver` at the
 * currently-cached threshold. Pure read against `resolver.admits` —
 * mirrors the Logger's hot-path query at emit time.
 */
function admitSet(resolver: LogLevelResolver): Set<LogLevel> {
  const admitted = new Set<LogLevel>();
  for (const level of RECORD_LEVELS) {
    if (resolver.admits(level)) {
      admitted.add(level);
    }
  }
  return admitted;
}

/**
 * Drive a threshold transition through the same code path the Logger
 * uses in production: write the new value via `setMockConfigValue`
 * (so `vscode.workspace.getConfiguration('intellig').get('log.level')`
 * returns it) then call `resolver.refresh()`.
 */
function applyThreshold(resolver: LogLevelResolver, threshold: LogThreshold): void {
  setMockConfigValue('intellig', 'log.level', threshold);
  resolver.refresh();
}

describe('Logger level admission monotonicity (Property 5)', () => {
  beforeEach(() => {
    resetMockConfiguration();
  });

  afterEach(() => {
    resetMockConfiguration();
    __resetLoggerForTest();
  });

  describe('Strict subset under transition to a stricter threshold', () => {
    it('Property: admit(L2) is a strict subset of admit(L1) when L2 > L1', () => {
      fc.assert(
        fc.property(stricterPairArb, ([l1, l2]) => {
          const resolver = new LogLevelResolver();

          // Apply L1 first and snapshot its admit set.
          applyThreshold(resolver, l1);
          assert.strictEqual(
            resolver.threshold,
            l1,
            `resolver must reflect threshold L1 (${l1}) after refresh`
          );
          const admitL1 = admitSet(resolver);

          // Transition to L2 (stricter).
          applyThreshold(resolver, l2);
          assert.strictEqual(
            resolver.threshold,
            l2,
            `resolver must reflect threshold L2 (${l2}) after refresh`
          );
          const admitL2 = admitSet(resolver);

          // (a) Subset: every level admitted at L2 was already admitted at L1.
          for (const level of admitL2) {
            assert.ok(
              admitL1.has(level),
              `record level '${level}' admitted at L2='${l2}' must also have been admitted at L1='${l1}'`
            );
          }

          // (b) Strict subset: at least one level admitted at L1 is dropped at L2.
          assert.ok(
            admitL2.size < admitL1.size,
            `admit(L2='${l2}') size ${admitL2.size} must be strictly less than admit(L1='${l1}') size ${admitL1.size}`
          );
        }),
        { numRuns: 200 }
      );
    });

    it('Property: every record level L < L2 is rejected after the transition', () => {
      fc.assert(
        fc.property(stricterPairArb, ([l1, l2]) => {
          const resolver = new LogLevelResolver();

          applyThreshold(resolver, l1);
          applyThreshold(resolver, l2);

          for (const level of RECORD_LEVELS) {
            if (LEVEL_RANK[level] < LEVEL_RANK[l2]) {
              assert.strictEqual(
                resolver.admits(level),
                false,
                `record level '${level}' (rank ${LEVEL_RANK[level]}) must not be admitted at threshold L2='${l2}' (rank ${LEVEL_RANK[l2]})`
              );
            }
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('Reversibility — re-applying L1 restores the original admit set', () => {
    it('Property: admit(L1 → L2 → L1) === admit(L1)', () => {
      fc.assert(
        fc.property(stricterPairArb, ([l1, l2]) => {
          const resolver = new LogLevelResolver();

          applyThreshold(resolver, l1);
          const before = admitSet(resolver);

          applyThreshold(resolver, l2);
          applyThreshold(resolver, l1);
          const after = admitSet(resolver);

          assert.deepStrictEqual(
            [...after].sort(),
            [...before].sort(),
            `admit set after L1 → L2 → L1 transition must equal initial admit(L1='${l1}')`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("Threshold 'off' admits no records", () => {
    it("Property: for every record level L, admit at threshold 'off' is false", () => {
      fc.assert(
        fc.property(fc.constantFrom(...RECORD_LEVELS), (level) => {
          const resolver = new LogLevelResolver();

          applyThreshold(resolver, 'off');
          assert.strictEqual(
            resolver.admits(level),
            false,
            `record level '${level}' must be rejected when threshold is 'off'`
          );
        }),
        { numRuns: 50 }
      );
    });

    it("Property: transitioning any threshold L1 → 'off' yields the empty admit set", () => {
      fc.assert(
        fc.property(thresholdArb, (l1) => {
          const resolver = new LogLevelResolver();

          applyThreshold(resolver, l1);
          applyThreshold(resolver, 'off');

          const admitted = admitSet(resolver);
          assert.strictEqual(
            admitted.size,
            0,
            `admit set at threshold 'off' (after starting at L1='${l1}') must be empty, got ${[...admitted].join(',')}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Direct admits semantics', () => {
    it('Property: a record at level L is admitted iff LEVEL_RANK[L] >= LEVEL_RANK[threshold] AND threshold !== off', () => {
      fc.assert(
        fc.property(thresholdArb, fc.constantFrom(...RECORD_LEVELS), (threshold, level) => {
          const resolver = new LogLevelResolver();
          applyThreshold(resolver, threshold);

          const expected = threshold !== 'off' && LEVEL_RANK[level] >= LEVEL_RANK[threshold];

          assert.strictEqual(
            resolver.admits(level),
            expected,
            `admits('${level}') at threshold='${threshold}' expected ${expected}`
          );
        }),
        { numRuns: 200 }
      );
    });
  });
});
