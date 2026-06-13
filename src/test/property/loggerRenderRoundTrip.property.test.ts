import * as fc from 'fast-check';
import * as assert from 'assert';
import { formatRecord, parseRecord } from '../../utils/logger/render';
import { sanitizeRecord } from '../../utils/logger/sanitize';
import type { JsonValue, LogLevel, LogRecord } from '../../utils/logger/sinks/types';

/**
 * Property-based test for the OutputChannel render round-trip.
 *
 * Feature: logging-and-src-restructure
 *
 * Property 7: OutputChannel render round-trip via sanitization.
 *
 * For any Log_Record R, let S = formatRecord(R) and R' = parseRecord(S).
 * Then:
 *   - parseRecord SHALL succeed (no throw, no null), and
 *   - sanitize(R) deep-equal sanitize(R').
 *
 * That is, the OutputChannel rendering grammar is a faithful round-trip
 * modulo sanitization.
 *
 *
 * ### Generator constraints
 *
 * The grammar in `render.ts` has a few structural restrictions that the
 * generators below honour to keep the round-trip well-defined:
 *
 * - `timestamp` must not contain a literal `]` (the header regex uses
 *   `[^\]]+` to capture it).
 * - `component` must not contain the boundary literal `': '` and must
 *   not contain newlines (the header regex uses a lazy `(.+?): ` to
 *   delimit it from the message and writes a single header line).
 *   Components are short identifiers bound by `child({ component })`
 *   in production code, so this is consistent with real usage.
 * - `error.stack` lines must not start with `ctx=`, `cid=`, or `err=`
 *   after the two-space continuation indent is stripped — the parser
 *   would otherwise re-interpret a stack frame as a structural
 *   continuation line. Real Node stack frames start with whitespace
 *   (`'    at fn (…)'`) so the constraint matches reality.
 * - `error.stack` (when present) must be a non-empty string and must
 *   not end with `\n`. The renderer drops a trailing empty element
 *   produced by `String#split('\n')` so a `\n`-terminated stack would
 *   not survive the round-trip byte-for-byte; sanitization preserves
 *   the discrepancy. Real `Error.stack` strings do not carry a
 *   trailing newline.
 * - JSON-shaped `context` leaves use finite numbers only — `NaN` and
 *   `±Infinity` are emitted as `null` by `JSON.stringify`, breaking
 *   round-trip equality.
 */
describe('Logger Render Round-Trip Property Tests', () => {
  /**
   * ISO-8601-shaped UTC timestamp generator.
   *
   * The Logger emits `new Date().toISOString()` strings (e.g.
   * `'2024-01-02T03:04:05.678Z'`); the generator does not need to
   * reproduce that format byte-for-byte — `formatRecord` writes the
   * timestamp verbatim and `parseRecord` reads it back verbatim — but
   * staying close keeps shrunk counterexamples readable. The
   * `noInvalidDate` filter tolerates `fc.date()`'s rare invalid values.
   */
  const timestampArb: fc.Arbitrary<string> = fc
    .date({ noInvalidDate: true })
    .map((d) => d.toISOString());

  const levelArb: fc.Arbitrary<LogLevel> = fc.constantFrom(
    'trace',
    'debug',
    'info',
    'warn',
    'error'
  );

  /**
   * Component names: short identifiers, no `': '` boundary, no newlines.
   * Keeps the header line single-line and round-trippable.
   */
  const componentArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split('')
    ),
    { minLength: 1, maxLength: 20 }
  );

  /**
   * Arbitrary message contents. Includes the empty string and
   * arbitrary unicode plus literal newlines / carriage returns /
   * backslashes; `escapeInline`/`unescapeInline` is responsible for
   * keeping these single-line on the wire.
   */
  const messageArb: fc.Arbitrary<string> = fc.string({ maxLength: 200 });

  /**
   * 16-char lowercase hex correlation IDs, matching
   * `crypto.randomBytes(8).toString('hex')` in `correlation.ts`.
   */
  const correlationIdArb: fc.Arbitrary<string> = fc.stringOf(
    fc.constantFrom(...'0123456789abcdef'.split('')),
    { minLength: 16, maxLength: 16 }
  );

  /**
   * Object-key generator that excludes JavaScript's runtime-special
   * names. `JSON.parse` treats `__proto__` as a setter-style assignment
   * rather than a regular own-property write, so a context like
   * `{"__proto__": []}` round-trips through stringify→parse to an
   * object whose `__proto__` lives on the prototype chain rather than
   * as an own key — the round-trip property would then fail on a
   * latent JS-engine quirk that has nothing to do with the production
   * code under test. `constructor`, `toString`, and `hasOwnProperty`
   * are filtered defensively for the same class of surprise.
   */
  const safeKeyArb: fc.Arbitrary<string> = fc
    .string({ minLength: 1, maxLength: 12 })
    .filter(
      (k) => k !== '__proto__' && k !== 'constructor' && k !== 'toString' && k !== 'hasOwnProperty'
    );

  /**
   * Recursive JSON-value generator for `context` leaves. Depth-bounded
   * (fast-check's `letrec` budget defaults are tightened via
   * `withCrossShrink`-friendly `maxDepth`) and avoids the corner cases
   * that don't survive `JSON.stringify` round-trips.
   */
  const jsonValueArb: fc.Arbitrary<JsonValue> = fc.letrec((tie) => ({
    leaf: fc.oneof(
      fc.string({ maxLength: 80 }),
      // Finite numbers only — JSON.stringify emits `null` for
      // NaN/±Infinity, which sanitize() would not recognise as the
      // original number. Negative zero is normalised to positive
      // zero because `JSON.stringify(-0)` emits `"0"` and parsing
      // back yields `+0`; `Object.is` (and therefore
      // `deepStrictEqual`) distinguishes the two, so the round-trip
      // would fail on a JSON-spec quirk that has nothing to do with
      // the production code under test.
      fc
        .double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 })
        .map((n) => (Object.is(n, -0) ? 0 : n)),
      fc.integer({ min: -1_000_000, max: 1_000_000 }),
      fc.boolean(),
      fc.constant(null)
    ),
    json: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      tie('leaf'),
      fc.array(tie('json'), { maxLength: 5 }),
      fc.dictionary(safeKeyArb, tie('json'), { maxKeys: 5 })
    ),
  })).json as fc.Arbitrary<JsonValue>;

  /**
   * Top-level context map. The `LogRecord.context` type is a string-keyed
   * object whose values are `JsonValue | undefined`; we never generate
   * `undefined` here because `JSON.stringify` drops those keys before
   * `parseRecord` sees them.
   */
  const contextArb: fc.Arbitrary<{ readonly [k: string]: JsonValue }> = fc.dictionary(
    safeKeyArb,
    jsonValueArb,
    { maxKeys: 6 }
  );

  /**
   * Stack frame line generator.
   *
   * Each frame is a single non-empty alphanumeric-and-symbol string
   * starting with a non-keyword character so the rendered indented form
   * never looks like a `ctx=`, `cid=`, or `err=` continuation line to
   * the parser. The leading `at ` matches the shape Node emits in real
   * `Error.stack` strings; the rest is a free-form, newline-free body.
   */
  const stackFrameArb: fc.Arbitrary<string> = fc
    .stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ./()_-:'.split('')
      ),
      { minLength: 1, maxLength: 80 }
    )
    .map((body) => `at ${body}`);

  /**
   * Multi-line stack: 1-6 frames joined by `\n`, with no trailing `\n`.
   */
  const stackArb: fc.Arbitrary<string> = fc
    .array(stackFrameArb, { minLength: 1, maxLength: 6 })
    .map((frames) => frames.join('\n'));

  /**
   * Optional `error` payload. When present, `message` is non-empty and
   * `stack` is either absent or a non-empty multi-line string with no
   * trailing newline.
   */
  const errorArb: fc.Arbitrary<{
    message: string;
    stack?: string;
  }> = fc.record(
    {
      message: fc.string({ minLength: 1, maxLength: 200 }),
      stack: fc.option(stackArb, { nil: undefined }),
    },
    { requiredKeys: ['message'] }
  );

  /**
   * Compose the full `LogRecord`. Optional fields are toggled
   * independently so the property exercises all 2³ = 8 combinations of
   * `context`/`correlationId`/`error` presence/absence.
   */
  const logRecordArb: fc.Arbitrary<LogRecord> = fc
    .record(
      {
        timestamp: timestampArb,
        level: levelArb,
        component: componentArb,
        message: messageArb,
        context: fc.option(contextArb, { nil: undefined }),
        correlationId: fc.option(correlationIdArb, { nil: undefined }),
        error: fc.option(errorArb, { nil: undefined }),
      },
      { requiredKeys: ['timestamp', 'level', 'component', 'message'] }
    )
    .map((r) => {
      // Strip explicitly-undefined optional fields so the input record
      // matches the "optional fields omitted" shape produced by the
      // production Logger emit path. This keeps deep-equality after
      // round-trip honest — `parseRecord` likewise omits absent keys.
      const out: LogRecord = {
        timestamp: r.timestamp,
        level: r.level,
        component: r.component,
        message: r.message,
        ...(r.context !== undefined ? { context: r.context } : {}),
        ...(r.correlationId !== undefined ? { correlationId: r.correlationId } : {}),
        ...(r.error !== undefined ? { error: r.error } : {}),
      };
      return out;
    });

  describe('Property 7: OutputChannel render round-trip via sanitization', () => {
    /**
     *
     * For any LogRecord R:
     *   - parseRecord(formatRecord(R)) succeeds (no throw)
     *   - sanitize(parseRecord(formatRecord(R))) deep-equals sanitize(R)
     */
    it('Property: sanitize(parseRecord(formatRecord(R))) === sanitize(R)', () => {
      fc.assert(
        fc.property(logRecordArb, (record) => {
          const rendered = formatRecord(record);
          const reparsed = parseRecord(rendered);

          const sanitizedOriginal = sanitizeRecord(record);
          const sanitizedReparsed = sanitizeRecord(reparsed);

          // The sanitizer's `ok: false` sentinel signals an unexpected
          // throw in the walker. Neither the original nor the reparsed
          // record should trigger it for a well-formed input.
          assert.ok(
            sanitizedOriginal.ok,
            `sanitizer failed on original record: ${JSON.stringify(record)}`
          );
          assert.ok(
            sanitizedReparsed.ok,
            `sanitizer failed on reparsed record: ${JSON.stringify(reparsed)}`
          );

          assert.deepStrictEqual(
            sanitizedReparsed.record,
            sanitizedOriginal.record,
            'sanitize(R) must deep-equal sanitize(parseRecord(formatRecord(R)))'
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * Companion property: `parseRecord` itself must succeed (no throw,
     * no null) for every well-formed record, before sanitization is
     * even consulted. Stated separately so a regression in the parser
     * surfaces with a tighter counterexample than the deep-equal check
     * above.
     */
    it('Property: parseRecord(formatRecord(R)) does not throw', () => {
      fc.assert(
        fc.property(logRecordArb, (record) => {
          const rendered = formatRecord(record);
          // Throws would propagate and fail the property; the explicit
          // call documents the assertion intent.
          const reparsed = parseRecord(rendered);
          assert.ok(
            reparsed !== null && typeof reparsed === 'object',
            'parseRecord must return a LogRecord, not null/undefined'
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
