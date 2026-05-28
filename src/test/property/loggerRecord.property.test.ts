/**
 * Task 4.1 — property test for Logger record construction shape and content.
 *
 * **Property 1: Record construction shape and content**
 *
 * From design.md → "Property 1: Record construction shape and content":
 *
 * > For any level method (`trace`/`debug`/`info`/`warn`/`error`),
 * > component binding (or absence thereof), message string, and
 * > optional `Bindings` context bag, the resulting `Log_Record`
 * > admitted to a test sink SHALL have:
 * >
 * > - `timestamp` matching the ISO-8601 UTC pattern
 * >   `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`,
 * > - `level` exactly equal to the called method's name,
 * > - `component` equal to the most-recent `child(...)` `component`
 * >   binding (or `'root'` when no binding has applied),
 * > - `message` equal to `sanitize(input)` for the input message,
 * > - `context` (when supplied) deep-equal to `deepSanitize(input)`.
 *
 * **Validates: Requirements 1.2, 1.3**
 *
 * ### Capture mechanism
 *
 * The Logger module exposes no public seam for registering a
 * custom test sink. We therefore capture emissions through the
 * production `OutputChannelSink` registered by `initLogger(context)`
 * — it writes one rendered block per record into the stubbed
 * `IntelliG` channel's `_lines` array, and `parseRecord` from
 * `src/utils/logger/render.ts` reconstructs the `LogRecord` we
 * assert against. This is the same approach the sibling
 * `loggerCorrelation.property.test.ts` uses for the same reason.
 *
 * ### Generator discipline
 *
 * Two design choices keep the property under test independent of
 * unrelated subsystems:
 *
 * 1. **Threshold pinned to `'trace'`.** Set
 *    `intellig.log.level = 'trace'` BEFORE `initLogger` so every
 *    generated level is admitted. The threshold-admission property
 *    is task 4.5 / Property 5; this test must not co-mingle.
 *
 * 2. **Sanitization computed from the production helper.** We do
 *    NOT constrain inputs to "safe" strings and assume sanitize is
 *    identity. Instead, we run the same `sanitizeRecord` the Logger
 *    runs to compute the expected post-sanitization message and
 *    context, then compare against the parsed record. That way a
 *    future change to the sanitizer's rule set does not silently
 *    regress this property.
 *
 * Strings and component names are constrained only to avoid the two
 * structural pitfalls of the rendered grammar: components must not
 * contain the `': '` separator (which `parseRecord`'s lazy match
 * uses as the boundary), and the message must not begin with
 * characters the OutputChannel's stub `_lines` storage corrupts.
 * Beyond those, arbitrary JSON-shaped trees are exercised.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';

import { __resetLoggerForTest, getLogger, initLogger } from '../../utils/logger';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../utils/outputChannel';
import { parseRecord } from '../../utils/logger/render';
import { sanitizeRecord } from '../../utils/logger/sanitize';
import { sanitizeGitError } from '../../utils/gitError';
import type { LogRecord } from '../../utils/logger';
import { resetMockConfiguration, setMockConfigValue } from '../mocks/vscode';

/**
 * The five record-level severities. Pinned in this order so the
 * generator and the assertion message read consistently with
 * `LogLevel`'s declaration in `src/utils/logger/sinks/types.ts`.
 */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

/**
 * ISO-8601 UTC pattern with millisecond precision, exactly as
 * documented by Property 1 in design.md. Anchored at both ends so a
 * stray prefix or suffix would fail the regex.
 */
const ISO_UTC_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Minimal `ExtensionContext` stub. `initOutputChannel` and
 * `initLogger` only exercise `subscriptions`; everything else stays
 * undefined. Same pattern as the other logger property tests.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Snapshot of the rendered blocks captured by the production
 * `OutputChannelSink` against the stubbed `IntelliG` channel from
 * `src/test/mocks/vscode.ts`. One block per emitted record.
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

/**
 * Drop every Logger-adjacent module-level singleton AND any
 * user-scope mock-config value written by previous iterations.
 * Order matters: detach the Logger's sinks first (so a stray emit
 * during teardown writes nowhere), then dispose the channel, then
 * clear the configuration store.
 */
function fullReset(): void {
  __resetLoggerForTest();
  __resetOutputChannelForTest();
  resetMockConfiguration();
}

/**
 * Wire a fresh Logger with `intellig.log.level = 'trace'` so every
 * generated level is admitted. The configuration write happens
 * BEFORE `initLogger` so the resolver's initial `refresh()` reads
 * the trace threshold (the listener fires only on later changes).
 */
function setupLoggerWithTraceThreshold(): vscode.ExtensionContext {
  setMockConfigValue('intellig', 'log.level', 'trace');
  const ctx = makeFakeContext();
  initOutputChannel(ctx);
  initLogger(ctx);
  return ctx;
}

/**
 * Compute the expected sanitized form of a context bag by running
 * it through the production `sanitizeRecord`. The Logger applies
 * the same walk to every emitted record (with `correlationId`
 * absent under our generator), so the returned shape is exactly
 * what we expect on the parsed record.
 *
 * Returns `undefined` when the input context is undefined or
 * sanitizes to an empty object — in either case the Logger omits
 * the `context` field entirely from the emitted record (see
 * `Logger._buildRecord`'s `hasContext` check).
 */
function expectedContext(
  inputContext: Record<string, unknown> | undefined,
): unknown {
  if (inputContext === undefined) {
    return undefined;
  }
  const result = sanitizeRecord({
    timestamp: '2024-01-01T00:00:00.000Z',
    level: 'info',
    component: 'test',
    message: '',
    context: inputContext as never,
  });
  if (!result.ok) {
    throw new Error('expectedContext: sanitizeRecord unexpectedly failed');
  }
  if (result.record.context === undefined) {
    return undefined;
  }
  if (Object.keys(result.record.context).length === 0) {
    return undefined;
  }
  return result.record.context;
}

// ─── Generators ─────────────────────────────────────────────────────────────

/**
 * Arbitrary message string. We exercise the printable-ASCII range
 * plus newlines (which `formatRecord` escapes as `\n` literals) so
 * the rendered block remains parseable. Unicode and other control
 * characters are out of scope for this property — the
 * render-round-trip property (task 4.7) covers them separately.
 */
const messageArb: fc.Arbitrary<string> = fc.string({ minLength: 0, maxLength: 64 });

/**
 * Arbitrary component identifier. Constrained to ASCII letters,
 * digits, and a few harmless punctuation characters so the rendered
 * header line's `<component>` field cannot contain the `': '`
 * separator that `parseRecord`'s lazy match uses as the boundary.
 * This is a structural concern of the renderer, not of the property
 * being tested — the renderer's grammar is asserted by task 4.7.
 */
const componentArb: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.'.split(''),
  ),
  { minLength: 1, maxLength: 24 },
);

/**
 * Arbitrary level method name. Drawn uniformly from the five
 * record-level severities (the configured threshold is `'trace'` so
 * every generated level is admitted by every sink).
 */
const levelArb: fc.Arbitrary<Level> = fc.constantFrom(...LEVELS);

/**
 * Arbitrary JSON-shaped value — string, number, boolean, null,
 * arrays of values, plain objects keyed by short strings. The shape
 * mirrors the `JsonValue` type in `src/utils/logger/sinks/types.ts`.
 *
 * `fc.letrec` with the `depthSize: 'small'` knob keeps generated
 * trees shallow so iteration cost stays low while still exercising
 * the recursive sanitizer walk.
 */
const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.string({ maxLength: 16 }),
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value') as fc.Arbitrary<unknown>, { maxLength: 4 }),
    fc.dictionary(
      fc
        .string({ minLength: 1, maxLength: 6 })
        .filter((k) => k !== 'component' && k !== 'correlationId'),
      tie('value') as fc.Arbitrary<unknown>,
      { maxKeys: 4 },
    ),
  ),
})).value;

/**
 * Arbitrary non-empty context bag. Reserved binding keys are
 * filtered out so they do not collide with the special-case
 * top-level fields (`component`, `correlationId`) — that resolution
 * is the subject of the bindings-inheritance property (task 4.2),
 * not this one.
 *
 * `minKeys: 1` ensures the Logger emits a `context` field on the
 * record (the emit path drops empty contexts entirely).
 */
const nonEmptyContextArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc
    .string({ minLength: 1, maxLength: 8 })
    .filter((k) => k !== 'component' && k !== 'correlationId'),
  jsonValueArb,
  { minKeys: 1, maxKeys: 6 },
);

/**
 * Arbitrary optional context: either `undefined` (no context
 * argument passed) or a non-empty bag. Both branches are
 * meaningful — Property 1 distinguishes "context present when
 * supplied" from "context absent when not supplied".
 */
const optionalContextArb: fc.Arbitrary<Record<string, unknown> | undefined> = fc.option(
  nonEmptyContextArb,
  { nil: undefined, freq: 3 },
);

/**
 * Arbitrary optional component binding. `undefined` exercises the
 * "no child() applied" branch where `component` defaults to
 * `'root'`; a defined string exercises the bound-component branch.
 */
const optionalComponentArb: fc.Arbitrary<string | undefined> = fc.option(componentArb, {
  nil: undefined,
  freq: 2,
});

// ─── Property tests ─────────────────────────────────────────────────────────

describe('Logger record construction (Property 1 / Task 4.1 / Requirements 1.2, 1.3)', () => {
  beforeEach(() => {
    fullReset();
  });

  afterEach(() => {
    fullReset();
  });

  /**
   * Property 1: Record construction shape and content.
   *
   * For every (level method, optional component binding, message,
   * optional context) tuple, the emitted record must satisfy the
   * five sub-properties listed in the file header.
   *
   * Each iteration runs against a freshly-reset Logger so neither
   * the sink list nor the channel can accumulate state across runs.
   */
  it('Property: every emitted record carries the expected timestamp / level / component / message / context', () => {
    fc.assert(
      fc.property(
        levelArb,
        optionalComponentArb,
        messageArb,
        optionalContextArb,
        (level, componentBinding, message, context) => {
          // Per-iteration reset — fast-check has no per-shrink hook,
          // so we do this inline. `setupLoggerWithTraceThreshold`
          // wires `log.level='trace'` so every generated level is
          // admitted by the OutputChannelSink.
          fullReset();
          setupLoggerWithTraceThreshold();

          // Build the Logger we're emitting through. `child()` with
          // no `component` key still returns a fresh Logger whose
          // `_component` falls through to the parent's binding —
          // but since we always start at the cached root logger, an
          // unbound case stays at `'root'`.
          const baseLogger = getLogger();
          const emitter =
            componentBinding !== undefined
              ? baseLogger.child({ component: componentBinding })
              : baseLogger;

          // Drive the emission via the dynamically-named level
          // method. The cast through `Record<string, ...>` keeps
          // TypeScript out of the way without changing runtime
          // semantics.
          const methodTable = emitter as unknown as Record<
            Level,
            (msg: string, ctx?: Record<string, unknown>) => void
          >;
          if (context !== undefined) {
            methodTable[level](message, context);
          } else {
            methodTable[level](message);
          }

          // Capture and parse the emitted block. Exactly one block
          // is expected — Requirement 1.7 (multicast) is the next
          // property's concern.
          const lines = getCapturedLines();
          assert.strictEqual(
            lines.length,
            1,
            `expected exactly one rendered block per emission; got ${lines.length}`,
          );

          let record: LogRecord;
          try {
            record = parseRecord(lines[0]);
          } catch (cause) {
            throw new Error(
              `parseRecord failed on captured block ${JSON.stringify(lines[0])}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
            );
          }

          // Sub-property 1: timestamp matches the ISO-8601 UTC ms
          // pattern. The Logger constructs the field via
          // `new Date().toISOString()`, which always produces this
          // shape — but we pin the regex so a future change (e.g.
          // a swap to `toLocaleString`) is loud.
          assert.match(
            record.timestamp,
            ISO_UTC_MS_RE,
            `record.timestamp must match ISO-8601 UTC ms pattern; got ${JSON.stringify(
              record.timestamp,
            )}`,
          );

          // Sub-property 2: level equals the called method's name.
          assert.strictEqual(
            record.level,
            level,
            `record.level must equal the called method name '${level}'; got '${record.level}'`,
          );

          // Sub-property 3: component equals the bound child
          // component, or 'root' when no binding applied.
          const expectedComponent = componentBinding ?? 'root';
          assert.strictEqual(
            record.component,
            expectedComponent,
            `record.component must equal '${expectedComponent}'; got '${record.component}'`,
          );

          // Sub-property 4: message equals sanitize(input). The
          // sanitizer is a no-op on inputs that don't contain
          // credentialed URLs or home-dir paths; we apply it here so
          // the assertion remains correct even when the generator
          // produces a string that DOES match a sanitization rule.
          const expectedMessage = sanitizeGitError(message);
          assert.strictEqual(
            record.message,
            expectedMessage,
            `record.message must equal sanitize(input); ` +
              `expected ${JSON.stringify(expectedMessage)}, ` +
              `got ${JSON.stringify(record.message)}`,
          );

          // Sub-property 5: context is present iff supplied (and
          // non-empty post-sanitization), and equals
          // deepSanitize(input).
          const expected = expectedContext(context);
          if (expected === undefined) {
            assert.strictEqual(
              record.context,
              undefined,
              `record.context must be absent when no context (or an empty context) was supplied; got ${JSON.stringify(
                record.context,
              )}`,
            );
          } else {
            assert.deepStrictEqual(
              record.context,
              expected,
              `record.context must deep-equal sanitize(input context); ` +
                `expected ${JSON.stringify(expected)}, ` +
                `got ${JSON.stringify(record.context)}`,
            );
          }

          // Belt-and-braces: no `correlationId` field when no
          // command-handler frame is on the stack (Requirement 5.5
          // / 14.9 — pinned more thoroughly by task 4.10, here we
          // only ensure our generator's lack of any `child(...)`
          // correlation override doesn't accidentally produce one).
          assert.strictEqual(
            record.correlationId,
            undefined,
            `record.correlationId must be absent outside a command-handler frame; got ${JSON.stringify(
              record.correlationId,
            )}`,
          );

          // Belt-and-braces: no `error` field — the generator only
          // exercises the (message, context) overload.
          assert.strictEqual(
            record.error,
            undefined,
            `record.error must be absent for non-error overloads; got ${JSON.stringify(
              record.error,
            )}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Companion: when no `child()` binding has been applied, every
   * record's `component` is exactly `'root'` regardless of the
   * called method or message. Stated separately so a regression in
   * the default-component path surfaces independently of a
   * regression in the child-binding path.
   */
  it("Property: records emitted from the root Logger carry component='root'", () => {
    fc.assert(
      fc.property(levelArb, messageArb, (level, message) => {
        fullReset();
        setupLoggerWithTraceThreshold();

        const methodTable = getLogger() as unknown as Record<
          Level,
          (msg: string) => void
        >;
        methodTable[level](message);

        const lines = getCapturedLines();
        assert.strictEqual(
          lines.length,
          1,
          `expected exactly one rendered block; got ${lines.length}`,
        );
        const record = parseRecord(lines[0]);
        assert.strictEqual(
          record.component,
          'root',
          `unbound Logger emissions must carry component='root'; got '${record.component}'`,
        );
      }),
      { numRuns: 50 },
    );
  });
});
