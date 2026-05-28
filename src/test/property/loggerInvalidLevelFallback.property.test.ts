/**
 * Task 4.6 — property test for the Logger's invalid-threshold fallback.
 *
 * **Property 6: Invalid threshold fallback**
 *
 * From requirements.md → Requirement 2.5:
 *
 * > IF `intellig.log.level` is read and the value is not one of the
 * > six literal strings in 2.1, THEN THE Logger SHALL fall back to
 * > `"info"` and emit one warn-level Log_Record naming the invalid
 * > value (sanitized).
 *
 * **Validates: Requirement 2.5**
 *
 * ### Approach
 *
 * The acceptance criterion has three observable consequences:
 *
 *   1. The cached threshold falls back to `'info'` for any
 *      out-of-enum value.
 *   2. The §2.5 warn signal is produced exactly once per distinct
 *      invalid value seen — repeated `refresh()` calls observing the
 *      same invalid value MUST NOT re-signal (no log-flooding when a
 *      user saves the same typo'd setting repeatedly).
 *   3. A different invalid value, even after a previous one has been
 *      signalled, MUST produce a fresh signal (each typo names
 *      itself).
 *
 * Per the task description: *"Use the LogLevelResolver directly OR
 * initLogger + driven config changes."* The cleanest unit for the
 * property is `LogLevelResolver` — it is the single component the
 * Logger consults for thresholds AND the single component whose
 * `refresh()` return value drives the §2.5 warn at the Logger
 * boundary (`initLogger` in `logger.ts` reads
 * `resolver.refresh()` and forwards the offending value to
 * `getLogger().warn(...)` exactly when the resolver reports one).
 * Validating the resolver's contract therefore validates the warn-
 * once mechanism end-to-end.
 *
 * ### Generators
 *
 * - `invalidLevelArb`: an `fc.string()` filtered against the six
 *   valid threshold strings. We bias slightly toward short strings
 *   so fast-check shrinking surfaces minimal counterexamples
 *   (e.g. `''`, `'INFO'`, `'verbose'`).
 * - `distinctInvalidPairArb`: a pair `(s1, s2)` of distinct invalid
 *   strings, used by the "different invalid → fresh signal"
 *   property.
 *
 * ### Isolation
 *
 * Each iteration constructs a fresh `LogLevelResolver`, so cross-test
 * state in `invalidLevelWarned` cannot leak between runs.
 * `resetMockConfiguration()` runs in `beforeEach` to clear any prior
 * `setMockConfigValue` writes, and `__resetLoggerForTest()` runs in
 * `afterEach` so any sibling test that touches the module-level
 * Logger singleton starts clean.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';

import { LogLevelResolver, type LogThreshold } from '../../utils/logger/levels';
import { __resetLoggerForTest } from '../../utils/logger';
import { resetMockConfiguration, setMockConfigValue } from '../mocks/vscode';

/**
 * The six valid `LogThreshold` strings, matching the
 * `package.json` `intellig.log.level` enum and Requirement 2.1.
 * Any string outside this set is "invalid" for the purposes of §2.5.
 */
const VALID_THRESHOLDS: ReadonlySet<string> = new Set<LogThreshold>([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'off',
]);

/**
 * Arbitrary over strings that are NOT one of the six valid threshold
 * values. The filter rejects the six valid strings so every drawn
 * value triggers the §2.5 fallback path. The base `fc.string()`
 * arbitrary already covers empty strings, mixed case (`'INFO'`,
 * `'Trace'`), substrings (`'inf'`), and arbitrary unicode garbage —
 * a `maxLength` of 32 keeps the input space narrow enough that
 * fast-check's shrinker reliably reaches small counterexamples.
 */
const invalidLevelArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 32 })
  .filter((s) => !VALID_THRESHOLDS.has(s));

/**
 * Arbitrary over `(s1, s2)` pairs of distinct invalid strings.
 * Filtered after generation rather than constructed-by-index so
 * fast-check can shrink each axis independently when a
 * counterexample exists.
 */
const distinctInvalidPairArb: fc.Arbitrary<readonly [string, string]> = fc
  .tuple(invalidLevelArb, invalidLevelArb)
  .filter(([a, b]) => a !== b);

/**
 * Drive a threshold write through the same code path the Logger uses
 * in production: `setMockConfigValue` makes
 * `vscode.workspace.getConfiguration('intellig').get('log.level')`
 * return the new value; the caller then triggers
 * `resolver.refresh()` directly (matching the production listener's
 * behaviour on `onDidChangeConfiguration`).
 */
function writeLevel(value: string): void {
  setMockConfigValue('intellig', 'log.level', value);
}

describe('Logger invalid-threshold fallback (Property 6 / Task 4.6)', () => {
  beforeEach(() => {
    resetMockConfiguration();
  });

  afterEach(() => {
    resetMockConfiguration();
    __resetLoggerForTest();
  });

  describe("Threshold falls back to 'info' for any invalid value (Requirement 2.5)", () => {
    it("Property: any invalid string sets the cached threshold to 'info'", () => {
      fc.assert(
        fc.property(invalidLevelArb, (invalid) => {
          const resolver = new LogLevelResolver();

          writeLevel(invalid);
          resolver.refresh();

          assert.strictEqual(
            resolver.threshold,
            'info',
            `cached threshold must fall back to 'info' for invalid value ${JSON.stringify(invalid)}, got ${JSON.stringify(resolver.threshold)}`
          );
        }),
        { numRuns: 200 }
      );
    });

    it("Property: threshold remains pinned at 'info' across repeated refreshes of the same invalid value", () => {
      fc.assert(
        fc.property(invalidLevelArb, (invalid) => {
          const resolver = new LogLevelResolver();

          writeLevel(invalid);
          resolver.refresh();
          resolver.refresh();
          resolver.refresh();

          assert.strictEqual(
            resolver.threshold,
            'info',
            `threshold must remain at the info fallback after repeat refreshes of ${JSON.stringify(invalid)}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Warn-once semantic via refresh() return value (Requirement 2.5)', () => {
    it('Property: refresh() returns the offending value the FIRST time it is observed', () => {
      fc.assert(
        fc.property(invalidLevelArb, (invalid) => {
          const resolver = new LogLevelResolver();

          writeLevel(invalid);
          const reported = resolver.refresh();

          assert.strictEqual(
            reported,
            invalid,
            `first refresh() observing invalid value ${JSON.stringify(invalid)} must return that value, got ${JSON.stringify(reported)}`
          );
        }),
        { numRuns: 200 }
      );
    });

    it('Property: refresh() returns undefined on subsequent refreshes that see the same invalid value', () => {
      fc.assert(
        fc.property(invalidLevelArb, (invalid) => {
          const resolver = new LogLevelResolver();

          writeLevel(invalid);
          const first = resolver.refresh();
          assert.strictEqual(
            first,
            invalid,
            'precondition: first refresh must report the invalid value'
          );

          // Second refresh with the same configured value must NOT
          // re-report — the de-dup `Set` inside the resolver already
          // contains it.
          const second = resolver.refresh();
          assert.strictEqual(
            second,
            undefined,
            `second refresh observing the same invalid value ${JSON.stringify(invalid)} must return undefined, got ${JSON.stringify(second)}`
          );

          // A third refresh — with the same value still configured —
          // must also return undefined. Pins the de-dup as monotonic
          // (warn-once-per-value) rather than alternating.
          const third = resolver.refresh();
          assert.strictEqual(
            third,
            undefined,
            `third refresh observing the same invalid value ${JSON.stringify(invalid)} must return undefined, got ${JSON.stringify(third)}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Distinct invalid values produce fresh signals (Requirement 2.5)', () => {
    it('Property: a DIFFERENT invalid value produces a fresh report', () => {
      fc.assert(
        fc.property(distinctInvalidPairArb, ([s1, s2]) => {
          const resolver = new LogLevelResolver();

          // Warn for s1 first.
          writeLevel(s1);
          const r1 = resolver.refresh();
          assert.strictEqual(
            r1,
            s1,
            'precondition: refresh must report the first invalid value'
          );

          // Different invalid value — must report.
          writeLevel(s2);
          const r2 = resolver.refresh();
          assert.strictEqual(
            r2,
            s2,
            `refresh observing a different invalid value ${JSON.stringify(s2)} (after ${JSON.stringify(s1)}) must return that new value, got ${JSON.stringify(r2)}`
          );

          // Re-observing s1 again must NOT re-report (still in the
          // de-dup set from the first call).
          writeLevel(s1);
          const r3 = resolver.refresh();
          assert.strictEqual(
            r3,
            undefined,
            `refresh observing previously-warned invalid value ${JSON.stringify(s1)} must return undefined, got ${JSON.stringify(r3)}`
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Property: reset() re-arms the de-dup set so a previously-warned value is reported again', () => {
      fc.assert(
        fc.property(invalidLevelArb, (invalid) => {
          const resolver = new LogLevelResolver();

          writeLevel(invalid);
          const first = resolver.refresh();
          assert.strictEqual(first, invalid, 'precondition: first refresh reports');

          const second = resolver.refresh();
          assert.strictEqual(second, undefined, 'precondition: second refresh deduped');

          // reset() drops the de-dup set; the next refresh must
          // therefore report the same invalid value as fresh. Pins
          // the test-isolation hook (`__resetLoggerForTest` flows
          // through to `resolver.reset()` per logger.ts).
          resolver.reset();

          writeLevel(invalid);
          const afterReset = resolver.refresh();
          assert.strictEqual(
            afterReset,
            invalid,
            `after reset, refresh observing ${JSON.stringify(invalid)} must report it again, got ${JSON.stringify(afterReset)}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('Recovery: transitioning to a valid threshold (Requirement 2.5)', () => {
    it('Property: writing a valid threshold after an invalid one updates the threshold and reports no further invalidity', () => {
      const validThresholdArb: fc.Arbitrary<LogThreshold> = fc.constantFrom(
        'trace',
        'debug',
        'info',
        'warn',
        'error',
        'off'
      );

      fc.assert(
        fc.property(invalidLevelArb, validThresholdArb, (invalid, valid) => {
          const resolver = new LogLevelResolver();

          writeLevel(invalid);
          const reportedInvalid = resolver.refresh();
          assert.strictEqual(
            reportedInvalid,
            invalid,
            'precondition: invalid value reported on first refresh'
          );

          writeLevel(valid);
          const reportedValid = resolver.refresh();
          assert.strictEqual(
            reportedValid,
            undefined,
            `refresh after writing valid threshold ${JSON.stringify(valid)} must return undefined (no invalidity to report), got ${JSON.stringify(reportedValid)}`
          );
          assert.strictEqual(
            resolver.threshold,
            valid,
            `cached threshold must reflect the newly-written valid value ${JSON.stringify(valid)}, got ${JSON.stringify(resolver.threshold)}`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
