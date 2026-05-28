/**
 * Task 4.13 — property test for the developer-only console mirror.
 *
 * Pins **Requirement 3.3**: when `intellig.log.console` is `true`, the
 * `ConsoleSink` invokes the matching `console.<level>` method (with
 * `trace` mapped to `console.debug`) with **the same rendered text**
 * the `OutputChannelSink` writes to the shared `IntelliG`
 * `vscode.OutputChannel`.
 *
 * The two sinks share a single `formatRecord(record)` call site
 * (`src/utils/logger/render.ts`) and, in `_multicast`, both receive
 * the same already-sanitized `LogRecord`. This property test
 * exercises that contract end-to-end across an arbitrary input space:
 *
 *   1. Drive `intellig.log.level = 'trace'` (admit every level) and
 *      `intellig.log.console = true` (activate the console mirror) via
 *      the `setMockConfigValue` seam from `src/test/mocks/vscode.ts`.
 *   2. Spy on `console.debug` / `info` / `warn` / `error` so each
 *      method's call arguments can be inspected per iteration.
 *   3. For each fast-check sample (`level`, `component`, `message`,
 *      optional `context`), call the matching `Logger` method exactly
 *      once and capture both the OutputChannel block (`_lines[0]` on
 *      the mock channel) and the console invocation argument.
 *   4. Assert byte-identity between the two strings, AND that the
 *      single non-empty console method is the one
 *      `LEVEL_TO_CONSOLE_METHOD[level]` predicts.
 *
 * The byte-identity assertion is the headline property — if a future
 * change ever splits the rendering between the two sinks (e.g. a
 * console-only colour-prefix), the assertion fires immediately. The
 * "exactly one console method invoked" assertion is the
 * complementary discipline that catches the trace→debug mapping bug
 * (Requirement 3.3 is explicit on this).
 *
 * #### Test isolation
 *
 * fast-check runs the property body many times in one Mocha test;
 * each iteration must start from a clean Logger and OutputChannel so
 * sink registrations from a prior iteration cannot pile up and turn
 * a single emit into multiple captured writes. The body resets all
 * three module-level singletons (`__resetLoggerForTest`,
 * `__resetOutputChannelForTest`, `resetMockConfiguration`) at the
 * top, then re-installs the configuration the test needs and
 * re-registers the console spies.
 *
 * **Validates: Requirement 3.3**
 */

import '../setup';
import * as fc from 'fast-check';
import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  __resetLoggerForTest,
  getLogger,
  initLogger,
  type LogLevel,
} from '../../utils/logger';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../utils/outputChannel';
import { resetMockConfiguration, setMockConfigValue } from '../mocks/vscode';

/**
 * Mirror of the production `LEVEL_TO_CONSOLE_METHOD` table from
 * `src/utils/logger/sinks/ConsoleSink.ts`. Duplicated here (rather
 * than re-imported) so the test pins the mapping itself — if the
 * production table is ever silently mutated, this duplicate fires
 * the regression on the next run rather than blindly tracking the
 * bug into the assertion.
 */
const LEVEL_TO_CONSOLE_METHOD: Readonly<
  Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'>
> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

const CONSOLE_METHODS: ReadonlyArray<'debug' | 'info' | 'warn' | 'error'> = [
  'debug',
  'info',
  'warn',
  'error',
];

/**
 * Minimal `ExtensionContext` stub. Matches the pattern used across
 * `src/test/unit/utils/logger/*.test.ts` — only `subscriptions` is
 * exercised by `initOutputChannel` and `initLogger`; the rest of the
 * surface stays undefined and is cast through `unknown`.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Per-iteration capture of console invocations. Each method records
 * the first argument (the rendered block string the `ConsoleSink`
 * passes through) into the matching array.
 */
interface ConsoleCapture {
  readonly debug: string[];
  readonly info: string[];
  readonly warn: string[];
  readonly error: string[];
}

/**
 * Install spies on `console.debug` / `info` / `warn` / `error`.
 *
 * Returns the capture object plus a `restore()` callback that puts
 * the original methods back. The capture stores the FIRST argument
 * to each call coerced to a string — the production `ConsoleSink`
 * always passes a single rendered string, so this is the only
 * argument we need.
 *
 * The Logger module's only sanctioned `console.*` reference is in
 * `ConsoleSink.emit`; the spy is therefore the exact boundary the
 * test wants to observe.
 */
function installConsoleSpy(): { capture: ConsoleCapture; restore: () => void } {
  const capture: ConsoleCapture = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };

  const original = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  console.debug = (...args: unknown[]): void => {
    capture.debug.push(String(args[0]));
  };
  console.info = (...args: unknown[]): void => {
    capture.info.push(String(args[0]));
  };
  console.warn = (...args: unknown[]): void => {
    capture.warn.push(String(args[0]));
  };
  console.error = (...args: unknown[]): void => {
    capture.error.push(String(args[0]));
  };

  return {
    capture,
    restore: (): void => {
      console.debug = original.debug;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

/**
 * Read the captured `_lines` array off the mock OutputChannel. The
 * mock's `appendLine` pushes the input string verbatim into `_lines`,
 * so the array length matches the number of records emitted to the
 * channel and the entries are the rendered blocks (no trailing
 * newline, per Requirement 3.2).
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

/**
 * Generator for `LogLevel`. The five record-side severities; the
 * threshold-only `'off'` is intentionally excluded — it is not a
 * valid argument to a Logger level method.
 */
const arbLevel: fc.Arbitrary<LogLevel> = fc.constantFrom<LogLevel>(
  'trace',
  'debug',
  'info',
  'warn',
  'error'
);

/**
 * Generator for the `component` binding. Allows arbitrary printable
 * strings of bounded length — the byte-identity property holds for
 * any string `formatRecord` accepts, so we deliberately stress
 * components that include spaces, punctuation, and unicode.
 */
const arbComponent: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 24,
});

/**
 * Generator for the `message` argument. Includes empty strings,
 * embedded newlines, backslashes, and unicode so the inline-escape
 * pass in `formatRecord` is exercised across a realistic input space.
 */
const arbMessage: fc.Arbitrary<string> = fc.string({ maxLength: 64 });

/**
 * Generator for an optional context bag. Keys are short ASCII
 * identifiers — the `Bindings` shape special-cases `component` and
 * `correlationId`, so we filter those out to keep the test focused
 * on the byte-identity property rather than re-deriving the
 * binding-merge rules. Values cover the JSON-serializable
 * primitives the sanitizer's walker is expected to handle.
 */
const arbContext: fc.Arbitrary<Record<string, unknown> | undefined> = fc.option(
  fc.dictionary(
    fc
      .string({ minLength: 1, maxLength: 8 })
      .filter((s) => s !== 'component' && s !== 'correlationId'),
    fc.oneof(
      fc.string({ maxLength: 16 }),
      fc.integer(),
      fc.boolean(),
      fc.constant(null)
    ),
    { maxKeys: 4 }
  ),
  { nil: undefined }
);

describe('logger console mirror — property test (task 4.13 / Requirement 3.3)', () => {
  beforeEach(() => {
    // Order: drop the Logger first so any in-flight emit cannot race
    // a torn-down channel; then drop the channel; then clear every
    // user-set configuration so iteration #1's `intellig.log.console`
    // write doesn't leak.
    __resetLoggerForTest();
    __resetOutputChannelForTest();
    resetMockConfiguration();
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
    resetMockConfiguration();
  });

  it('Property: console.<level> receives the same rendered string as the OutputChannel block when intellig.log.console=true', () => {
    fc.assert(
      fc.property(arbLevel, arbComponent, arbMessage, arbContext, (level, component, message, context) => {
        // Fresh module-level state per iteration. fast-check runs the
        // property body many times — without this reset, sink
        // registrations and channel writes from prior iterations
        // would pile up and break the per-iteration "exactly one
        // capture" assertions below.
        __resetLoggerForTest();
        __resetOutputChannelForTest();
        resetMockConfiguration();

        // Drive the two settings the resolver reads on
        // `initLogger(context)`:
        //   - `log.level = 'trace'` admits every level we generate.
        //   - `log.console = true` activates the ConsoleSink mirror.
        // The resolver re-reads via
        // `vscode.workspace.getConfiguration('intellig').get(...)`,
        // so the writes must happen BEFORE `initLogger` runs.
        setMockConfigValue('intellig', 'log.level', 'trace');
        setMockConfigValue('intellig', 'log.console', true);

        const ctx = makeFakeContext();
        initOutputChannel(ctx);
        initLogger(ctx);

        const spy = installConsoleSpy();
        try {
          // Emit one record at the generated level via a child
          // Logger bound to the generated component. The Logger's
          // `_multicast` then hands the same record to BOTH sinks —
          // OutputChannelSink and ConsoleSink — each of which
          // independently calls `formatRecord(record)`. The byte
          // identity of those two calls is the property we assert.
          const logger = getLogger().child({ component });
          // Cast through `unknown` because the per-call `context`
          // type is `Bindings` (a constrained JSON shape); the
          // generated dictionary covers a strictly looser space and
          // is safe at runtime under the sanitizer's walker.
          logger[level](message, context as unknown as undefined);

          // ----- OutputChannel side -----
          const channelLines = getCapturedLines();
          assert.strictEqual(
            channelLines.length,
            1,
            `expected exactly one OutputChannel block for level=${level}; got ${channelLines.length} (lines=${JSON.stringify(channelLines)})`
          );
          const channelBlock = channelLines[0];

          // ----- Console side -----
          const expectedMethod = LEVEL_TO_CONSOLE_METHOD[level];
          const expectedCalls = spy.capture[expectedMethod];

          assert.strictEqual(
            expectedCalls.length,
            1,
            `expected exactly one console.${expectedMethod} call for level=${level}; got ${expectedCalls.length}`
          );

          // No other console method may be invoked for this single
          // record. This is the "trace→debug mapping" guarantee:
          // a record at level `trace` MUST land on `console.debug`
          // and not on `console.trace` (which the production sink
          // does not use).
          for (const method of CONSOLE_METHODS) {
            if (method === expectedMethod) {
              continue;
            }
            assert.strictEqual(
              spy.capture[method].length,
              0,
              `console.${method} must not be called for level=${level} (which maps to console.${expectedMethod}); got ${spy.capture[method].length} extra calls`
            );
          }

          // The headline property: byte-identity. Both sinks call
          // `formatRecord(record)` on the same sanitized record, so
          // the rendered strings MUST be identical. A diff here
          // means the rendering pipeline has split between sinks.
          assert.strictEqual(
            expectedCalls[0],
            channelBlock,
            `console.${expectedMethod} arg must equal OutputChannel block byte-for-byte\n--- console (${expectedCalls[0].length} chars) ---\n${expectedCalls[0]}\n--- channel (${channelBlock.length} chars) ---\n${channelBlock}`
          );
        } finally {
          spy.restore();
        }
      }),
      { numRuns: 100 }
    );
  });
});
