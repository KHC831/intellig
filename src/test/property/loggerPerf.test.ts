/**
 * Logger emission-path microbenchmark.
 *
 * Pins the performance budget from Requirement 7.2:
 *
 *   THE Logger emission path at `intellig.log.level = "info"` SHALL
 *   complete in under 1ms per record on a typical developer machine,
 *   measured with a hand-rolled microbenchmark.
 *
 * The benchmark drives `Logger.info(...)` calls through the full
 * production emission path — hot-path level check, record
 * construction (timestamp + bindings merge + correlation read),
 * sanitization, and OutputChannel/Console sink multicast — and
 * asserts the mean per-call wall-clock duration sits under the 1 ms
 * budget.
 *
 * ### File-naming note
 *
 * Despite living under `src/test/property/`, this file uses the
 * `.test.ts` suffix (not `.property.test.ts`) so the existing
 * `test:property` mocha glob (`src/test/property/**\/*.property.test.ts`)
 * does NOT pick it up. The benchmark is wall-clock-sensitive and
 * not a property test, so it runs on its own (e.g. via a direct
 * mocha invocation or as part of a future `test:perf` script). This
 * matches the task's explicit guidance for the file name.
 *
 * ### Methodology
 *
 * Microbenchmarks on a JIT'd runtime are noisy. The test mitigates
 * the usual sources of bias as follows:
 *
 * - **Warm-up.** A large untimed warm-up loop runs first so the V8
 *   tiering compiler has already promoted the hot functions to
 *   optimised code by the time measurement starts. The warm-up
 *   sample size is excluded from the reported mean.
 * - **Mean over a fixed N.** The assertion is on the mean wall-clock
 *   per call, not per-call max. A single GC pause or context switch
 *   would otherwise dominate the result.
 * - **`process.hrtime.bigint()`.** Nanosecond-resolution monotonic
 *   timer; immune to wall-clock skew that `Date.now()` exhibits.
 * - **Production sinks attached.** The test runs with the real
 *   `OutputChannelSink` and `ConsoleSink` registered against the
 *   mocked `vscode.OutputChannel` (which captures `appendLine` calls
 *   into an in-memory array) so the benchmark measures the realistic
 *   production emission path — not a sink-less idealised loop.
 * - **Fixed log level.** The threshold is the default `'info'`
 *   (the level the requirement names) so the hot-path check admits
 *   every emitted record. Driving the path at the threshold avoids
 *   the §7.1 short-circuit win that would otherwise inflate
 *   throughput artificially.
 *
 * The CI generosity factor below (`PER_CALL_BUDGET_MS`) is set to
 * the requirement's 1 ms — measurements on the developer machines
 * that drafted this test sit well under 100 µs/record, so the budget
 * has roughly an order-of-magnitude margin against typical CI noise.
 *
 * ### Isolation
 *
 * `__resetLoggerForTest()` runs before and after the test so neither
 * a sibling test's leaked sinks nor leftover resolver state can bias
 * the measurement.
 *
 * @see Requirement 7.2 (the named budget) and 7.1, 7.3 (the
 *   short-circuit invariants this test does NOT directly assert
 *   but which the emission-path shape depends on).
 */

import '../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';

import { __resetLoggerForTest, getLogger, initLogger } from '../../utils/logger';
import { __resetOutputChannelForTest, initOutputChannel } from '../../utils/outputChannel';

/**
 * Number of warm-up records emitted before the timed loop. Discarded.
 * Sized large enough to let V8's tiering compiler promote
 * `Logger._emit`, `_buildRecord`, `sanitizeRecord`, `formatRecord`,
 * and the sink `emit` paths into optimised code before measurement
 * starts.
 */
const WARMUP_ITERATIONS = 1_000;

/**
 * Number of timed records. The mean is taken over this sample.
 * 1000 is the lower bound suggested by the task; large enough that a
 * single GC pause does not dominate the mean while still keeping the
 * test's wall-clock under a second on any reasonable machine.
 */
const TIMED_ITERATIONS = 1_000;

/**
 * Per-record wall-clock budget from Requirement 7.2. The assertion is
 * on the mean — a single slow record (e.g. caught in a GC pause) is
 * absorbed by the average across {@link TIMED_ITERATIONS} samples.
 */
const PER_CALL_BUDGET_MS = 1;

/**
 * Minimal `ExtensionContext` stub. Only `subscriptions` is exercised
 * by `initOutputChannel` and `initLogger`; everything else is left
 * undefined and cast through `unknown`.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

describe('Logger emission-path performance (Task 4.14 / Requirement 7.2)', () => {
  beforeEach(() => {
    // Drop both singletons so this benchmark starts from a clean
    // module-level state. Order matters — drop the Logger first so
    // detached sinks cannot race a channel reset mid-emit.
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  it(`mean wall-clock per Logger.info(...) call stays under ${PER_CALL_BUDGET_MS}ms at threshold "info"`, () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);

    // Bind a child logger with a representative component name so
    // the emission path walks the same `_buildRecord` branches the
    // real services do (component override skipped, inherited
    // bindings empty, correlation store undefined).
    const logger = getLogger().child({ component: 'PerfBenchmark' });

    // ----- Warm-up (untimed) ---------------------------------------------
    // Drive the hot path enough times that V8's tiering compiler
    // promotes the relevant functions to optimised code. The warm-up
    // sample is intentionally larger than the smallest threshold for
    // tier-up so the timed loop runs against optimised code from the
    // first iteration.
    for (let i = 0; i < WARMUP_ITERATIONS; i++) {
      logger.info('warmup record', { iteration: i });
    }

    // ----- Timed window --------------------------------------------------
    // `process.hrtime.bigint()` returns a monotonic nanosecond
    // counter; immune to wall-clock skew. We measure the whole loop
    // (rather than per-call) so the timer-read overhead does not
    // dominate; the mean is `total / TIMED_ITERATIONS` afterwards.
    const start = process.hrtime.bigint();
    for (let i = 0; i < TIMED_ITERATIONS; i++) {
      logger.info('timed record', { iteration: i });
    }
    const end = process.hrtime.bigint();

    const totalNs = end - start;
    const totalMs = Number(totalNs) / 1_000_000;
    const meanMsPerCall = totalMs / TIMED_ITERATIONS;

    assert.ok(
      meanMsPerCall < PER_CALL_BUDGET_MS,
      `Logger.info emission path mean per-call duration was ${meanMsPerCall.toFixed(4)}ms ` +
        `(${TIMED_ITERATIONS} samples, total ${totalMs.toFixed(2)}ms); ` +
        `Requirement 7.2 budget is ${PER_CALL_BUDGET_MS}ms`
    );
  });
});
