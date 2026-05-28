/**
 * Property 4 — Sink multicast filtered by threshold.
 *
 * **Validates: Requirement 1.7**
 *
 * For any registered sink S whose `admits(record)` returns `true`,
 * `emit(record)` is called exactly once per Logger emission. For any
 * sink whose `admits` returns `false`, `emit` is not called.
 *
 * The Logger module's `_sinks` array is module-level/private — there
 * is no public API to inject arbitrary test sinks. Per the task hints
 * in `tasks.md` (task 4.4), this test exercises the property through
 * the **two production sinks** (`OutputChannelSink`, `ConsoleSink`)
 * registered by `initLogger(context)`, controlling their per-record
 * `admits` behaviour through the configuration knobs:
 *
 * - `intellig.log.level` (drives the shared `LogLevelResolver`
 *   threshold consulted by both sinks).
 * - `intellig.log.console` (gates the `ConsoleSink` independently of
 *   the threshold).
 *
 * The test counts `emit` calls indirectly via the observable side
 * effect of each sink:
 *
 * - `OutputChannelSink.emit` calls `outputChannel.appendLine(block)`
 *   exactly once per record, so a wrapper around `appendLine` on the
 *   cached `IntelliG` channel counts emit dispatches.
 * - `ConsoleSink.emit` calls `console[method]` (with `trace` →
 *   `console.debug`) exactly once per record, so swapping the four
 *   methods for counting stubs counts emit dispatches.
 *
 * This is the exact correspondence Requirement 1.7 asserts: one emit
 * per admitting sink, zero per rejecting sink.
 *
 * @see Requirement 1.7
 * @see design.md → "Logger emission flow"
 */

import '../setup';

import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';

import { ConfigurationTarget, setMockConfigValue } from '../mocks/vscode';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../utils/outputChannel';
import {
  __resetLoggerForTest,
  getLogger,
  initLogger,
} from '../../utils/logger/logger';
import { LEVEL_RANK, type LogThreshold } from '../../utils/logger/levels';
import type { LogLevel } from '../../utils/logger/sinks/types';

// ─── Generators ─────────────────────────────────────────────────────────────

/** The five record-level severities, matching `LogLevel`. */
const RECORD_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

/** All six configurable threshold values, matching `LogThreshold`. */
const THRESHOLDS: readonly LogThreshold[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'off',
];

/**
 * Mapping that mirrors `LEVEL_TO_CONSOLE_METHOD` inside
 * `ConsoleSink`. We do not import the sink's private table; pinning
 * a duplicate here keeps the property test independent of the sink's
 * internal grammar (a future change to the sink that re-routes
 * `trace` to a different `console` method would correctly fail this
 * test).
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Counting spy that replaces `console.debug/info/warn/error` with
 * stubs that increment a per-method counter. Returns a `restore()`
 * to put the originals back. We do NOT spy on `console.trace` or
 * `console.log` — `ConsoleSink` only ever calls the four methods
 * the property test cares about.
 */
interface IConsoleSpy {
  counts: { debug: number; info: number; warn: number; error: number };
  restore(): void;
}

function spyOnConsole(): IConsoleSpy {
  const counts = { debug: 0, info: 0, warn: 0, error: 0 };
  const original = {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.debug = ((..._args: unknown[]): void => {
    counts.debug++;
  }) as Console['debug'];
  console.info = ((..._args: unknown[]): void => {
    counts.info++;
  }) as Console['info'];
  console.warn = ((..._args: unknown[]): void => {
    counts.warn++;
  }) as Console['warn'];
  console.error = ((..._args: unknown[]): void => {
    counts.error++;
  }) as Console['error'];
  return {
    counts,
    restore(): void {
      console.debug = original.debug;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

/**
 * Minimal `ExtensionContext` stub. `initOutputChannel` and
 * `initLogger` only exercise `subscriptions`; everything else is
 * left undefined and cast through `unknown`.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Drop both module-level singletons (Logger + OutputChannel) AND
 * clear any user-scope configuration values written by previous
 * iterations. Order matters: the Logger reset detaches sinks first
 * (so a stray emit during teardown writes nowhere), then the
 * channel reset disposes the underlying mock.
 */
function fullReset(): void {
  __resetLoggerForTest();
  __resetOutputChannelForTest();
  setMockConfigValue('intellig', 'log.level', undefined, ConfigurationTarget.Global);
  setMockConfigValue('intellig', 'log.console', undefined, ConfigurationTarget.Global);
}

// ─── Property test ──────────────────────────────────────────────────────────

describe('Logger sink multicast filtered by threshold (Property 4 / Requirement 1.7)', () => {
  beforeEach(() => {
    fullReset();
  });

  afterEach(() => {
    fullReset();
  });

  /**
   * Drive the cross-product (record level × threshold × console
   * mirror flag × message content) and assert per-sink emit counts
   * exactly match the admit predicate Requirement 1.7 specifies:
   *
   * - OutputChannelSink admits ⇔ resolver admits the record's level.
   * - ConsoleSink admits ⇔ resolver admits AND `intellig.log.console`
   *   is `true`.
   *
   * For every admitting sink the corresponding side-effect counter
   * MUST be exactly `1`; for every rejecting sink it MUST be `0`.
   */
  it('Property 4: each emission produces exactly one emit per admitting sink and zero per rejecting sink', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RECORD_LEVELS),
        fc.constantFrom(...THRESHOLDS),
        fc.boolean(),
        fc.string({ maxLength: 80 }),
        (recordLevel, threshold, consoleEnabled, message) => {
          // Reset between iterations so each sample sees a fresh
          // resolver, fresh channel, and fresh sinks. fast-check has
          // no per-iteration hooks, so we do this inline.
          fullReset();

          // Drive the configuration BEFORE initLogger so the
          // resolver's initial refresh() picks up the desired
          // threshold + console-mirror state. (setMockConfigValue
          // does not fire onDidChangeConfiguration; we lean on
          // pre-init refresh instead.)
          setMockConfigValue(
            'intellig',
            'log.level',
            threshold,
            ConfigurationTarget.Global
          );
          setMockConfigValue(
            'intellig',
            'log.console',
            consoleEnabled,
            ConfigurationTarget.Global
          );

          const ctx = makeFakeContext();
          initOutputChannel(ctx);

          // Wrap the cached channel's appendLine so we can count
          // OutputChannelSink.emit dispatches. The sink calls
          // appendLine exactly once per record, so writes.length is
          // a faithful per-emit counter.
          const channel = getOutputChannel();
          const writes: string[] = [];
          const originalAppendLine = channel.appendLine.bind(channel);
          channel.appendLine = (value: string): void => {
            writes.push(value);
            originalAppendLine(value);
          };

          // Spy on the four console methods the ConsoleSink uses.
          const consoleSpy = spyOnConsole();

          try {
            initLogger(ctx);

            // Drive one Logger emission. The Logger short-circuits
            // BEFORE allocation when no sink admits the record
            // (Requirement 7.1, 7.3); emit counts of 0 are still
            // observable through the spies.
            getLogger()[recordLevel](message);

            // Compute expected admission per Requirement 1.7.
            const recordAdmittedByThreshold =
              LEVEL_RANK[recordLevel] >= LEVEL_RANK[threshold];
            const expectedOutputChannelEmits = recordAdmittedByThreshold ? 1 : 0;
            const expectedConsoleEmits =
              recordAdmittedByThreshold && consoleEnabled ? 1 : 0;

            assert.strictEqual(
              writes.length,
              expectedOutputChannelEmits,
              `OutputChannelSink emit-count mismatch for ` +
                `level=${recordLevel} threshold=${threshold} ` +
                `consoleEnabled=${String(consoleEnabled)}: ` +
                `expected ${expectedOutputChannelEmits}, got ${writes.length}`
            );

            // Sum every console method count. The sink only ever
            // calls one method per record, so the total equals the
            // ConsoleSink emit count.
            const totalConsoleEmits =
              consoleSpy.counts.debug +
              consoleSpy.counts.info +
              consoleSpy.counts.warn +
              consoleSpy.counts.error;

            assert.strictEqual(
              totalConsoleEmits,
              expectedConsoleEmits,
              `ConsoleSink emit-count mismatch for ` +
                `level=${recordLevel} threshold=${threshold} ` +
                `consoleEnabled=${String(consoleEnabled)}: ` +
                `expected ${expectedConsoleEmits}, got ${totalConsoleEmits} ` +
                `(per-method: ${JSON.stringify(consoleSpy.counts)})`
            );

            // When the ConsoleSink admits, the SPECIFIC console
            // method matching the record's level must have received
            // the call (per `LEVEL_TO_CONSOLE_METHOD`, with `trace`
            // routed to `console.debug`). The sibling methods must
            // have received zero. This pins down the per-record
            // dispatch shape, not just the total.
            if (expectedConsoleEmits === 1) {
              const expectedMethod = LEVEL_TO_CONSOLE_METHOD[recordLevel];
              assert.strictEqual(
                consoleSpy.counts[expectedMethod],
                1,
                `expected console.${expectedMethod} to be called exactly once ` +
                  `for record level ${recordLevel}; counts=${JSON.stringify(
                    consoleSpy.counts
                  )}`
              );
              for (const method of ['debug', 'info', 'warn', 'error'] as const) {
                if (method === expectedMethod) {
                  continue;
                }
                assert.strictEqual(
                  consoleSpy.counts[method],
                  0,
                  `expected console.${method} to receive zero calls ` +
                    `for record level ${recordLevel}; got ${consoleSpy.counts[method]}`
                );
              }
            }
          } finally {
            // Always restore console before the next iteration so
            // assertion failures in this iteration's mocha runner
            // surface through the real console.
            consoleSpy.restore();
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
