/**
 * Property 9: Sanitizer determinism / idempotence.
 *
 *
 * The structured Logger funnels every emission through
 * `sanitizeRecord` (`src/utils/logger/sanitize.ts`) so credentials
 * and home-dir paths never reach a `LogSink`. Two algebraic
 * properties must hold for that scrub:
 *
 * **Determinism.** For any input value, repeated
 *   invocations of the sanitizer SHALL produce byte-identical output.
 *   Two calls to `sanitizeRecord(R)` on the same record MUST yield
 *   structurally identical sanitized records, regardless of when the
 *   calls happen or whether other records were sanitized in between.
 *
 * **Idempotence.** For any string `s` reachable
 *   as a field of any `LogRecord`,
 *   `sanitize(sanitize(s)) === sanitize(s)`. Lifting that to the
 *   record-shape sanitizer: feeding a sanitized record back through
 *   `sanitizeRecord` MUST produce a record structurally identical to
 *   the first pass. The redaction is fully-applied after one walk —
 *   re-running it never changes anything because every credential
 *   URL is already collapsed to `https://<redacted>@…` and every
 *   home-dir prefix is already collapsed to `~/`.
 *
 * Idempotence is the load-bearing property: log records can be
 * routed through multiple sinks, captured for tests, then re-routed
 * for printing. Without idempotence, a record that passed through
 * the sanitizer twice could differ from one that passed through
 * once — a footgun that would surface as flaky tests and unstable
 * captured fixtures.
 *
 * ### Strategy
 *
 * `fast-check` generates three kinds of inputs covering the surface
 * the sanitizer walks:
 *
 * 1. Arbitrary strings (sometimes containing the bait substrings
 *    `https://user:pass@host` and `/Users/<n>/`, `/home/<n>/`,
 *    `C:\Users\<n>\`, `C:/Users/<n>/`) — exercises the string-leaf
 *    path and the post-redaction "no further change" property.
 * 2. Arbitrary `JsonValue`-shaped trees (booleans, numbers, nulls,
 *    strings, arrays, plain objects, nested) — exercises the
 *    recursive walker and the object/array clone shape.
 * 3. Arbitrary `LogRecord` shapes covering every optional field
 *    (`context`, `correlationId`, `error.message`, `error.stack`)
 *    so the determinism / idempotence guarantee holds end-to-end on
 *    the public sanitizer entry-point, not just on a string leaf.
 *
 * For each generated input the test asserts:
 *
 * - **determinism**: two consecutive calls to `sanitizeRecord(input)`
 *   produce structurally equal records (`assert.deepStrictEqual`).
 * - **idempotence**: `sanitizeRecord(sanitizeRecord(input).record)`
 *   produces a record structurally equal to the first pass. Since
 *   the full ADR-005 redaction set is applied per leaf on the first
 *   walk, a second walk has nothing left to substitute.
 *
 * The test deliberately exercises only the SUCCESS branch
 * (`result.ok === true`). The sanitizer's failure path
 * is owned by `sanitizerFallback.test.ts`; mixing
 * the failure-sentinel into the determinism check would muddy what
 * "byte-identical" means for a failure result that captures a
 * `cause` field with an `Error` instance.
 *
 * ### No mocks
 *
 * The sanitizer is a pure function over a `LogRecord` shape — it has
 * no side effects, reads no global state, and depends only on
 * `sanitizeGitError` (which is itself pure). The test imports the
 * production `sanitizeRecord` directly without any test doubles.
 * Per the testing guidelines, `import '../setup'` is included so the
 * mock `vscode` module is registered if any transitive import ever
 * pulls it in; the sanitizer itself does not touch `vscode`.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { sanitizeRecord } from '../../utils/logger/sanitize';
import type { JsonValue, LogLevel, LogRecord } from '../../utils/logger/sinks/types';

// ── Arbitraries ────────────────────────────────────────────────────────

/**
 * String fragment that often contains the bait the sanitizer is
 * meant to redact. Mixing redaction-triggering substrings with
 * arbitrary content keeps the property non-trivial: if the
 * sanitizer were a no-op, determinism + idempotence would still
 * hold; we want inputs where the sanitizer actually does work, then
 * assert that further passes change nothing.
 *
 * The literals here are deliberately benign placeholders; they are
 * structurally identical to real credentials/home-dir paths but
 * carry no real secrets. The home-dir patterns include all four
 * shapes covered by `sanitizeGitError`:
 *  - POSIX `/Users/<name>/`
 *  - POSIX `/home/<name>/`
 *  - Windows backslash `C:\Users\<name>\`
 *  - Windows forward-slash `C:/Users/<name>/`
 */
const baitFragmentArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant('https://user:pass@github.com/owner/repo.git'),
  fc.constant('https://x-access-token:ghp_abc123@github.com/owner/repo.git'),
  fc.constant('/Users/alice/Documents/project/file.ts'),
  fc.constant('/home/bob/work/repo/index.ts'),
  fc.constant('C:\\Users\\carol\\dev\\thing.ts'),
  fc.constant('C:/Users/dave/dev/thing.ts'),
  fc.constant('plain text without any redaction triggers'),
  fc.string({ minLength: 0, maxLength: 30 })
);

/**
 * Mix of zero, one, or two bait fragments interleaved with random
 * filler. Collapsed via `join` so every generated string is a
 * single value the sanitizer treats as one leaf.
 */
const baitedStringArb: fc.Arbitrary<string> = fc
  .array(baitFragmentArb, { minLength: 0, maxLength: 3 })
  .map((parts) => parts.join(' '));

/**
 * Recursive `JsonValue` arbitrary. Bounded depth/width keeps the
 * test fast while still exercising the recursive walker. The
 * `letrec` form expresses the mutual reference between
 * primitives, arrays of `value`, and objects whose values are
 * `value`.
 *
 * Note on `null`: included as a primitive because the sanitizer
 * preserves `null` verbatim. Numbers and booleans are also
 * preserved verbatim. Strings are routed through the redaction
 * pass — these are the only leaf type whose value can change.
 */
const jsonValueArb: fc.Arbitrary<JsonValue> = fc.letrec((tie) => ({
  primitive: fc.oneof(
    baitedStringArb,
    fc.integer({ min: -1_000, max: 1_000 }),
    fc.boolean(),
    fc.constant(null)
  ),
  array: fc.array(tie('value') as fc.Arbitrary<JsonValue>, { maxLength: 4 }),
  object: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 8 }),
    tie('value') as fc.Arbitrary<JsonValue>,
    { maxKeys: 4 }
  ),
  value: fc.oneof(
    { depthSize: 'small' },
    tie('primitive') as fc.Arbitrary<JsonValue>,
    tie('array') as fc.Arbitrary<JsonValue>,
    tie('object') as fc.Arbitrary<JsonValue>
  ),
})).value;

/**
 * Top-level `context` map: dictionary of string keys to
 * `JsonValue` leaves. Distinct from the recursive `object` branch
 * because `LogRecord.context` is typed as
 * `{ readonly [k: string]: JsonValue | undefined }`, not as a
 * `JsonValue` itself.
 */
const contextArb: fc.Arbitrary<{ readonly [key: string]: JsonValue | undefined }> = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 8 }),
  jsonValueArb,
  { maxKeys: 5 }
);

/**
 * One of the five record-level severities. `'off'` is a threshold
 * value, never a record level — see `sinks/types.ts`.
 */
const levelArb: fc.Arbitrary<LogLevel> = fc.constantFrom<LogLevel>(
  'trace',
  'debug',
  'info',
  'warn',
  'error'
);

/**
 * ISO-8601 UTC timestamp arbitrary. The sanitizer preserves
 * `timestamp` verbatim (it is generated by the Logger, not
 * user-supplied), so the exact format only matters insofar as it
 * round-trips identity. Generating a fixed-shape ISO string keeps
 * the assertion targets crisp.
 */
const timestampArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 4_102_444_800_000 }) // up to year 2100
  .map((ms) => new Date(ms).toISOString());

/**
 * 16-char lowercase hex string — matches the shape generated by
 * `crypto.randomBytes(8).toString('hex')` in
 * `registerLoggedCommand`. Used both directly and through the
 * baited-string variant so determinism on already-clean ids is
 * also covered.
 */
const correlationIdArb: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'0123456789abcdef'.split('')),
  { minLength: 16, maxLength: 16 }
);

/**
 * Optional `error` shape matching `LogRecord.error`. Both
 * `message` and the optional `stack` are baited strings so the
 * sanitizer has work to do on those leaves on the first pass and
 * nothing on the second.
 */
const errorArb: fc.Arbitrary<NonNullable<LogRecord['error']>> = fc.record(
  {
    message: baitedStringArb,
    stack: baitedStringArb,
  },
  { requiredKeys: ['message'] }
);

/**
 * Full `LogRecord` arbitrary covering every optional field. Every
 * generated record represents an in-flight emission the Logger
 * would hand to `sanitizeRecord`.
 */
const logRecordArb: fc.Arbitrary<LogRecord> = fc.record(
  {
    timestamp: timestampArb,
    level: levelArb,
    component: fc.string({ minLength: 1, maxLength: 24 }),
    message: baitedStringArb,
    context: contextArb,
    correlationId: correlationIdArb,
    error: errorArb,
  },
  { requiredKeys: ['timestamp', 'level', 'component', 'message'] }
);

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Run `sanitizeRecord` and unwrap the success branch. The sanitizer
 * may return a sentinel `ok: false` result if the walk throws on
 * the input; those inputs are out of scope for this property (see
 * file-level comment) and the test fails loudly so they are
 * obvious in shrunk counterexamples rather than silently skewing
 * the assertions.
 */
function sanitizeOrFail(record: LogRecord): LogRecord {
  const result = sanitizeRecord(record);
  assert.strictEqual(
    result.ok,
    true,
    'sanitizer unexpectedly returned the ok:false sentinel for an input ' +
      'this property test does not cover (no throwing getters expected)'
  );
  // Type narrowing — unreachable when ok is false because of the assert above.
  return (result as { readonly ok: true; readonly record: LogRecord }).record;
}

// ── Properties ─────────────────────────────────────────────────────────

describe('Property 9 — Sanitizer determinism / idempotence', () => {
  // ── String-leaf level ────────────────────────────────────────────────

  it('determinism: sanitize(record-with-string-leaf) is byte-identical across repeated calls', () => {
    fc.assert(
      fc.property(baitedStringArb, (s) => {
        // Lift the string into a minimal LogRecord so the property
        // exercises the public sanitizer entry-point (not the
        // private `sanitizeString` helper). Two consecutive calls
        // on the same input must yield deeply-equal records.
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level: 'info',
          component: 'StringLeafTest',
          message: s,
        };

        const first = sanitizeOrFail(record);
        const second = sanitizeOrFail(record);

        assert.deepStrictEqual(
          second,
          first,
          'sanitizer is non-deterministic on a string-leaf record: two calls produced different output'
        );
      }),
      { numRuns: 200 }
    );
  });

  it('idempotence: sanitize(sanitize(s)) === sanitize(s) for any string-leaf message', () => {
    fc.assert(
      fc.property(baitedStringArb, (s) => {
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level: 'info',
          component: 'StringLeafTest',
          message: s,
        };

        const once = sanitizeOrFail(record);
        // Re-feed the sanitized record. The redaction has already
        // collapsed every credential URL / home-dir prefix on the
        // first pass, so the second pass MUST be a no-op.
        const twice = sanitizeOrFail(once);

        assert.deepStrictEqual(
          twice,
          once,
          'sanitizer is not idempotent: a second pass changed the sanitized message'
        );
        // Belt and braces: pin the message-level invariant directly,
        // so a future regression that breaks idempotence at the
        // string-leaf only (without affecting the rest of the
        // record) still surfaces a clear assertion.
        assert.strictEqual(
          twice.message,
          once.message,
          'sanitizer message-leaf is not idempotent: second pass produced a different string'
        );
      }),
      { numRuns: 200 }
    );
  });

  // ── JsonValue tree level ─────────────────────────────────────────────

  it('determinism: sanitize over a context tree is byte-identical across repeated calls', () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level: 'debug',
          component: 'ContextTreeTest',
          message: 'context-only',
          context: ctx,
        };

        const first = sanitizeOrFail(record);
        const second = sanitizeOrFail(record);

        assert.deepStrictEqual(
          second,
          first,
          'sanitizer is non-deterministic on a context tree: two calls produced different output'
        );
      }),
      { numRuns: 100 }
    );
  });

  it('idempotence: sanitize(sanitize(record)) === sanitize(record) over a context tree', () => {
    fc.assert(
      fc.property(contextArb, (ctx) => {
        const record: LogRecord = {
          timestamp: '2026-05-12T14:03:11.482Z',
          level: 'debug',
          component: 'ContextTreeTest',
          message: 'context-only',
          context: ctx,
        };

        const once = sanitizeOrFail(record);
        const twice = sanitizeOrFail(once);

        assert.deepStrictEqual(
          twice,
          once,
          'sanitizer is not idempotent on a context tree: a second pass produced different output'
        );
      }),
      { numRuns: 100 }
    );
  });

  // ── Full LogRecord level (every optional field) ──────────────────────

  it('determinism: sanitize(LogRecord) is byte-identical across repeated calls (every optional field exercised)', () => {
    fc.assert(
      fc.property(logRecordArb, (record) => {
        const first = sanitizeOrFail(record);
        const second = sanitizeOrFail(record);

        assert.deepStrictEqual(
          second,
          first,
          'sanitizer is non-deterministic on a full LogRecord: two calls produced different output'
        );
      }),
      { numRuns: 200 }
    );
  });

  it('idempotence: sanitize(sanitize(LogRecord)) === sanitize(LogRecord) (every optional field exercised)', () => {
    fc.assert(
      fc.property(logRecordArb, (record) => {
        const once = sanitizeOrFail(record);
        const twice = sanitizeOrFail(once);

        assert.deepStrictEqual(
          twice,
          once,
          'sanitizer is not idempotent on a full LogRecord: a second pass produced different output'
        );
      }),
      { numRuns: 200 }
    );
  });

  // ── Pinned regression seed ───────────────────────────────────────────

  it('pinned regression: a record carrying every redaction-trigger across every field is fully-stable after one pass', () => {
    // Hand-crafted record exercising all four home-path shapes plus
    // a credentialed URL, distributed across `message`, `context`
    // (nested), `correlationId`, and `error.{message,stack}`. The
    // first sanitize pass collapses every trigger; the second pass
    // MUST be a structural no-op.
    const record: LogRecord = {
      timestamp: '2026-05-12T14:03:11.482Z',
      level: 'error',
      component: 'PinnedRegressionTest',
      message: 'fatal: unable to access https://user:pass@github.com/owner/repo.git',
      context: {
        path: '/Users/alice/project/file.ts',
        nested: {
          home: '/home/bob/work/x.ts',
          win: 'C:\\Users\\carol\\dev\\thing.ts',
          winSlash: 'C:/Users/dave/dev/thing.ts',
        },
        list: ['https://x:y@example.com', '/Users/alice/x', 42, true, null] satisfies JsonValue[],
      },
      correlationId: 'abcdef0123456789',
      error: {
        message: 'cloned from https://u:p@github.com/owner/repo.git',
        stack:
          'Error: clone failed\n' +
          '    at fn (/Users/alice/code/intellig/src/extension.ts:42:10)\n' +
          '    at next (C:\\Users\\carol\\code\\intellig\\src\\extension.ts:7:5)',
      },
    };

    const once = sanitizeOrFail(record);
    const twice = sanitizeOrFail(once);

    assert.deepStrictEqual(
      twice,
      once,
      'pinned regression: re-sanitizing a fully-redacted record changed it'
    );

    // Sanity-check: the first pass actually performed work — the
    // fully-clean output must NOT equal the original baited input.
    assert.notDeepStrictEqual(
      once,
      record,
      'pinned regression: first sanitize pass was a no-op, so the property is vacuous'
    );
  });
});
