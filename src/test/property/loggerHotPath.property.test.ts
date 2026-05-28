/**
 * Task 4.11 — property test for the Logger's below-threshold short-circuit.
 *
 * **Property 11: Below-threshold short-circuit**
 *
 * When the configured threshold rejects a record's level, the Logger MUST
 * NOT allocate the record, merge the context, or invoke the sanitizer.
 * In other words: the only work the Logger may perform on a rejected
 * call is the level admission check itself.
 *
 * **Validates: Requirements 7.1, 7.3**
 *
 * ### Detection strategy
 *
 * We detect Logger-side context inspection by attaching an enumerable
 * **getter** to the per-call `context` argument via
 * `Object.defineProperty`. The getter records (or throws on) every
 * access. The Logger's emission path — both `_buildRecord` and the
 * downstream sanitizer — reach into `context[key]` to merge values, so
 * an admitted call WILL trigger the getter at least once. A rejected
 * call MUST NOT.
 *
 * Two variants are exercised:
 *
 * 1. A *counting* getter that simply increments an access counter; the
 *    test asserts the counter is zero whenever the configured threshold
 *    rejects the called level.
 * 2. A *throwing* getter; the test asserts the level call returns
 *    without throwing for every below-threshold combination — including
 *    the dedicated `'off'` threshold case which rejects every level.
 *
 * ### Scope
 *
 * The property is asserted across the full Cartesian product of the
 * five record levels and the six configurable thresholds (including
 * `'off'`). The mock-vscode configuration store is reset between
 * iterations and the Logger's cached singleton is dropped via
 * `__resetLoggerForTest()` to keep iterations independent.
 */

import '../setup';

import * as assert from 'assert';
import * as fc from 'fast-check';

import { __resetLoggerForTest, getLogger, type Bindings } from '../../utils/logger';
import { LEVEL_RANK, type LogLevel, type LogThreshold } from '../../utils/logger/levels';
import { resetMockConfiguration, setMockConfigValue } from '../mocks/vscode';

/**
 * The five record-level severities. The Logger exposes one method per
 * entry; rejection at the threshold returns before the method allocates
 * a record.
 */
const LOG_LEVELS: ReadonlyArray<LogLevel> = ['trace', 'debug', 'info', 'warn', 'error'];

/**
 * The six configurable thresholds, including the dedicated `'off'`
 * value that rejects every record level (Requirement 2.4).
 */
const LOG_THRESHOLDS: ReadonlyArray<LogThreshold> = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'off',
];

/**
 * `true` iff a record at `level` is admitted by `threshold`. Mirrors
 * `LogLevelResolver.admits()` so the property check stays decoupled
 * from the resolver's implementation — if the resolver's admission
 * formula ever drifts, this comparator and the resolver disagree on
 * the boundary case and the test fails loudly rather than tracking
 * the drift silently.
 */
function isAdmitted(level: LogLevel, threshold: LogThreshold): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}

/**
 * Re-cast `Logger` so we can dispatch a level method by name without
 * a five-way `if/else` ladder in every property body. The runtime
 * surface matches `Logger`'s declared method signatures (Requirement
 * 1.1), so the cast is sound.
 */
type LevelDispatchableLogger = Record<LogLevel, (message: string, context?: Bindings) => void>;

describe('Logger hot-path short-circuit — Property 11 (Task 4.11)', () => {
  beforeEach(() => {
    __resetLoggerForTest();
    resetMockConfiguration();
  });

  afterEach(() => {
    __resetLoggerForTest();
    resetMockConfiguration();
  });

  it('Property 11: below-threshold level calls do not access context getters', () => {
    // Validates: Requirements 7.1, 7.3
    fc.assert(
      fc.property(
        fc.constantFrom(...LOG_LEVELS),
        fc.constantFrom(...LOG_THRESHOLDS),
        (level, threshold) => {
          // Per-iteration isolation. Resetting the Logger drops its
          // cached resolver so the next `getLogger()` re-reads the
          // mock configuration we are about to write.
          __resetLoggerForTest();
          resetMockConfiguration();
          setMockConfigValue('intellig', 'log.level', threshold);

          let getterCalls = 0;
          const sentinelKey = 'sentinelField';

          // Build a context with one enumerable getter-backed property.
          // The Logger emit path iterates `Object.keys(context)` and
          // reads `context[key]` to merge values — that read triggers
          // the getter. The getter is only on a non-special key
          // (component / correlationId are top-level binding fields)
          // so we are unambiguously measuring context-walk activity.
          const ctx = {} as Record<string, unknown>;
          Object.defineProperty(ctx, sentinelKey, {
            enumerable: true,
            configurable: true,
            get: (): string => {
              getterCalls += 1;
              return 'admitted-payload';
            },
          });

          const logger = getLogger();
          (logger as unknown as LevelDispatchableLogger)[level]('hot-path probe', ctx as Bindings);

          if (!isAdmitted(level, threshold)) {
            // The whole point of Requirement 7.1 / 7.3: a rejected call
            // performs zero context-side work. Sanitizer never runs;
            // record is never allocated; getters are not touched.
            assert.strictEqual(
              getterCalls,
              0,
              `Logger.${level}() must not access context when threshold='${threshold}' rejects ` +
                `(observed ${getterCalls} getter access(es))`
            );
          }
          // Admitted-case behaviour is covered by other property tests
          // (loggerRecord, loggerSanitizerLeakage, etc.). Property 11 is
          // specifically about the rejection short-circuit, so we make
          // no claim here when the call is admitted.
        }
      ),
      { numRuns: 200 }
    );
  });

  it('Property 11: threshold "off" rejects every level — context is never inspected', () => {
    // Validates: Requirements 7.1, 7.3 (with explicit Requirement 2.4
    // coverage for the 'off' boundary).
    fc.assert(
      fc.property(fc.constantFrom(...LOG_LEVELS), (level) => {
        __resetLoggerForTest();
        resetMockConfiguration();
        setMockConfigValue('intellig', 'log.level', 'off');

        let getterCalls = 0;
        const ctx = {} as Record<string, unknown>;
        Object.defineProperty(ctx, 'sentinelField', {
          enumerable: true,
          configurable: true,
          get: (): string => {
            getterCalls += 1;
            return 'never-read';
          },
        });

        const logger = getLogger();
        (logger as unknown as LevelDispatchableLogger)[level]('off-threshold probe', ctx as Bindings);

        assert.strictEqual(
          getterCalls,
          0,
          `Logger.${level}() must not access context when threshold='off' ` +
            `(observed ${getterCalls} getter access(es))`
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property 11: a throwing context getter is never tripped on below-threshold calls', () => {
    // Validates: Requirements 7.1, 7.3 (stronger formulation — the
    // getter signals access by throwing, so a successful call
    // operationally PROVES the Logger never reached for the value).
    fc.assert(
      fc.property(
        fc.constantFrom(...LOG_LEVELS),
        fc.constantFrom(...LOG_THRESHOLDS),
        (level, threshold) => {
          // Constrain the input space to the rejection cases. The
          // admitted-case behaviour (where the throwing getter WOULD
          // legitimately fire when the sanitizer walks the context) is
          // not in scope for Property 11.
          fc.pre(!isAdmitted(level, threshold));

          __resetLoggerForTest();
          resetMockConfiguration();
          setMockConfigValue('intellig', 'log.level', threshold);

          const ctx = {} as Record<string, unknown>;
          Object.defineProperty(ctx, 'tripwire', {
            enumerable: true,
            configurable: true,
            get: (): never => {
              throw new Error('context getter invoked despite below-threshold rejection');
            },
          });

          const logger = getLogger();
          assert.doesNotThrow(
            () => {
              (logger as unknown as LevelDispatchableLogger)[level](
                'tripwire probe',
                ctx as Bindings
              );
            },
            `Logger.${level}() with threshold='${threshold}' must short-circuit before ` +
              `reading context (the throwing getter signalled it was reached)`
          );
        }
      ),
      { numRuns: 200 }
    );
  });
});
