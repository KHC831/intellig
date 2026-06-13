/**
 * Property test for Logger bindings inheritance and override.
 *
 * Feature: logging-and-src-restructure, Property 2: Bindings inheritance
 *   and override
 *
 *
 * ### What this property pins
 *
 * The Logger's `child(bindings)` mechanism accumulates structured
 * fields across descendants. For any sequence of `child(bindings_i)`
 * calls applied to a root Logger and a final per-call `context`
 * argument supplied to a level method (`info`/`warn`/...), the
 * emitted record's effective bindings MUST equal the shallow-merge:
 *
 *     bindings_0 -> bindings_1 -> ... -> bindings_n -> per_call_context
 *
 * with later bag wins on key conflicts. In particular:
 *
 *  - per-call `context` shallow-merges on top of
 *    inherited bindings; per-call keys win on conflict.
 *  - chained `child(...)` calls: the most-recent
 *    `child(...)` binding wins for any key on conflict between
 *    ancestors.
 *
 * The two requirements together collapse to one universal property:
 * the effective merge is a left-fold where the *rightmost* writer to a
 * key wins.
 *
 * ### How the property is exercised
 *
 * Generators produce:
 *   1. A chain of 1–6 `Bindings` bags (arbitrary string keys, JSON-safe
 *      primitive values).
 *   2. A per-call `context` bag with the same shape.
 *
 * The test:
 *   - Builds a Logger by left-folding `child(bindings_i)` from the
 *     root.
 *   - Calls `info(message, perCallContext)` to emit one record.
 *   - Captures the rendered block via `OutputChannelSink` writing to
 *     the stubbed `IntelliG` channel (mock `_lines`).
 *   - Parses the block back into a `LogRecord` via `parseRecord`.
 *   - Builds the expected merge by walking the bag sequence
 *     left-to-right, last writer wins.
 *   - Asserts the parsed record's `context` deep-equals the expected
 *     merge for every non-special key, and the `component`
 *     (special-cased onto a top-level field) follows the same
 *     precedence rule.
 *
 * ### Why this approach (vs. a custom test sink)
 *
 * The Logger module exports no public hook for registering test
 * sinks. The existing logger-test pattern (`sinkLifecycle.test.ts`,
 * `sanitizerFallback.test.ts`) drives records through the real
 * `OutputChannelSink` against the mock channel from
 * `src/test/mocks/vscode.ts`. We follow the same pattern here so
 * the test exercises the production emit path end-to-end —
 * `child` -> `_buildRecord` -> `sanitizeRecord` -> sink -> `appendLine`
 * -> back through `parseRecord`. The `parseRecord`/`formatRecord`
 * pair is documented (in `render.ts`) to round-trip modulo
 * sanitization, and our generated values are alphanumeric ASCII so
 * `sanitizeGitError` is the identity on every leaf.
 *
 * ### Generator hygiene
 *
 *  - Keys are restricted to short alphanumeric strings, which avoids:
 *      * collisions with the special `component` / `correlationId`
 *        binding keys (handled in a separate sub-property),
 *      * sanitizer rewrites (no `/`, no `:`, no `@`, no `\`),
 *      * JSON-escape edge cases inside the rendered `ctx=` payload.
 *  - Values are JSON primitives only (string/number/boolean/null) —
 *    Property 2 is about merge order; nested-object handling is
 *    covered by other properties (sanitizer-non-leakage Property 8).
 *  - Each generated chain has at least one non-empty bag with at
 *    least one non-special key so the emitted record always carries
 *    a `context` field (the OutputChannel grammar omits `ctx=` when
 *    `context` is absent, which would break the round-trip read on
 *    "all bindings empty" cases — uninteresting for this property).
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';

import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../utils/outputChannel';
import { __resetLoggerForTest, getLogger, initLogger, type Bindings } from '../../utils/logger';
import { parseRecord } from '../../utils/logger/render';
import type { JsonValue, LogRecord } from '../../utils/logger/sinks/types';

/**
 * Minimal `ExtensionContext` stub — only `subscriptions` is exercised
 * by `initOutputChannel` and `initLogger`. Same shape as the existing
 * logger unit tests.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Read the lines captured by the mock OutputChannel. The mock from
 * `src/test/mocks/vscode.ts` exposes `_lines` on every channel; the
 * production `OutputChannelSink` writes through `appendLine`, so each
 * record renders as one entry in `_lines`.
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

/**
 * Reset both singletons. Order matters: drop the Logger first (which
 * detaches sinks) so the channel reset below does not race a sink
 * mid-emit.
 */
function resetLoggerAndChannel(): void {
  __resetLoggerForTest();
  __resetOutputChannelForTest();
}

/**
 * The two binding keys the Logger special-cases onto top-level
 * `LogRecord` fields rather than the `context` map. Generators avoid
 * these names in the main property so the test asserts a clean
 * `context` merge; a separate sub-property covers `component`
 * precedence explicitly.
 */
const SPECIAL_BINDING_KEYS = new Set<string>(['component', 'correlationId']);

/**
 * Arbitrary alphanumeric key — short, lowercase, never matches the
 * special binding keys. The character set deliberately excludes
 * symbols that would either trigger sanitizer rewrites (`/`, `\`,
 * `:`, `@`) or complicate `parseRecord`'s `ctx=<json>` continuation
 * line (newlines, tabs).
 */
const keyArb: fc.Arbitrary<string> = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 1,
    maxLength: 6,
  })
  .filter((s) => !SPECIAL_BINDING_KEYS.has(s));

/**
 * JSON-safe primitive value. We deliberately keep this to leaves
 * (string / number / boolean / null) for Property 2 — the merge rule
 * is shallow, so testing "an inner-object value replaces an inner-
 * object value" adds no coverage. Strings draw from the same
 * sanitizer-safe alphabet as keys.
 */
const valueArb: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
    minLength: 0,
    maxLength: 8,
  }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
  fc.constant(null)
);

/**
 * One bag of arbitrary string-keyed bindings. `fc.dictionary` with
 * the alphanumeric `keyArb` produces small maps with unique keys per
 * bag (up to 5 entries). We pick a small upper bound because Property
 * 2 is about merge ordering, not stress-testing the merge with
 * hundreds of keys.
 */
const bindingsBagArb: fc.Arbitrary<Record<string, JsonValue>> = fc.dictionary(keyArb, valueArb, {
  minKeys: 0,
  maxKeys: 5,
});

/**
 * A non-empty bag — used as the per-call context (so the emitted
 * record always has a `context` field; see "Generator hygiene"
 * note above).
 */
const nonEmptyBagArb: fc.Arbitrary<Record<string, JsonValue>> = fc.dictionary(keyArb, valueArb, {
  minKeys: 1,
  maxKeys: 5,
});

/**
 * A chain of 1–5 child-binding bags applied left-to-right via
 * `child(bindings_0).child(bindings_1)...`. Each bag may be empty;
 * the per-call context (separate generator) is non-empty so the
 * resulting `context` field is guaranteed non-empty.
 */
const bindingsChainArb: fc.Arbitrary<Record<string, JsonValue>[]> = fc.array(bindingsBagArb, {
  minLength: 1,
  maxLength: 5,
});

/**
 * Compute the expected shallow-merge of the chain + per-call context.
 * Mirrors the Logger contract: walk left-to-right, last writer wins.
 * `undefined` values are dropped (the Logger does the same — see
 * `_buildRecord` in `logger.ts`).
 */
function expectedMerge(
  chain: Record<string, JsonValue>[],
  perCall: Record<string, JsonValue>
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const bag of chain) {
    for (const [k, v] of Object.entries(bag)) {
      if (v === undefined) {
        continue;
      }
      out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(perCall)) {
    if (v === undefined) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

describe('Logger bindings inheritance and override (Property 2)', () => {
  beforeEach(() => {
    resetLoggerAndChannel();
  });

  afterEach(() => {
    resetLoggerAndChannel();
  });

  it('Property: per-call context shallow-merges on top of inherited bindings; later writer wins', () => {
    fc.assert(
      fc.property(bindingsChainArb, nonEmptyBagArb, (chain, perCall) => {
        // Each iteration starts from a clean Logger + channel so prior
        // iterations cannot leak emitted lines or cached resolver state
        // into this one.
        resetLoggerAndChannel();
        const ctx = makeFakeContext();
        initOutputChannel(ctx);
        initLogger(ctx);

        // Build the descendant Logger by left-folding child(...) over
        // the chain. `as Bindings` is safe because the generator only
        // produces non-special string-keyed bindings.
        let logger = getLogger();
        for (const bag of chain) {
          logger = logger.child(bag as Bindings);
        }

        // Emit one info-level record. The default threshold is 'info'
        // so the record is admitted by the OutputChannelSink.
        logger.info('binding-merge-property', perCall as Bindings);

        const lines = getCapturedLines();
        assert.strictEqual(
          lines.length,
          1,
          `expected exactly one rendered block from one info() call; got ${lines.length}`
        );

        const parsed: LogRecord = parseRecord(lines[0]);

        // Header pins: level, message, default component (no special
        // 'component' binding was generated for this property).
        assert.strictEqual(parsed.level, 'info', 'level must match the called method name');
        assert.strictEqual(
          parsed.message,
          'binding-merge-property',
          'message must round-trip verbatim through formatRecord/parseRecord'
        );
        assert.strictEqual(
          parsed.component,
          'root',
          "component must default to 'root' when no child(...) binding overrode it"
        );

        // The core property: parsed `context` deep-equals the expected
        // shallow-merge. parseRecord returns the context as a
        // string-keyed object; we compare via deepStrictEqual so any
        // missing key, extra key, or value mismatch fails loudly with
        // both maps printed.
        const expected = expectedMerge(chain, perCall);

        // The Logger may emit a record with `context` absent only when
        // the merge is empty. nonEmptyBagArb guarantees the per-call
        // bag has ≥1 key, so the merge cannot be empty.
        assert.ok(
          parsed.context !== undefined,
          'emitted record must carry a context field when the merge is non-empty'
        );

        assert.deepStrictEqual(
          parsed.context,
          expected,
          `merged context must equal the shallow-merge with last-writer-wins precedence.\n` +
            `chain=${JSON.stringify(chain)}\n` +
            `perCall=${JSON.stringify(perCall)}\n` +
            `expected=${JSON.stringify(expected)}\n` +
            `actual=${JSON.stringify(parsed.context)}`
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property: most-recent child() component binding wins on conflict', () => {
    // The `component` key is special-cased onto a top-level
    // `LogRecord` field rather than `context`. Property 1.5 names it
    // explicitly: the most-recent child(...) component wins. We test
    // this dimension in its own property because the bag-merge test
    // above deliberately excludes the special keys to keep the
    // context-merge assertion clean.
    const componentNameArb: fc.Arbitrary<string> = fc.stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
      ),
      { minLength: 1, maxLength: 12 }
    );

    fc.assert(
      fc.property(fc.array(componentNameArb, { minLength: 1, maxLength: 5 }), (componentChain) => {
        resetLoggerAndChannel();
        const ctx = makeFakeContext();
        initOutputChannel(ctx);
        initLogger(ctx);

        // Apply each component name as a successive child(...) so
        // the most-recent name is the one bound at emit time.
        let logger = getLogger();
        for (const name of componentChain) {
          logger = logger.child({ component: name });
        }
        logger.info('component-precedence-property');

        const lines = getCapturedLines();
        assert.strictEqual(
          lines.length,
          1,
          `expected exactly one rendered block; got ${lines.length}`
        );

        const parsed: LogRecord = parseRecord(lines[0]);
        const expectedComponent = componentChain[componentChain.length - 1];

        assert.strictEqual(
          parsed.component,
          expectedComponent,
          `component must equal the most-recent child(...) component binding.\n` +
            `chain=${JSON.stringify(componentChain)}\n` +
            `expected='${expectedComponent}'\n` +
            `actual='${parsed.component}'`
        );
      }),
      { numRuns: 100 }
    );
  });

  it('Property: per-call component override wins over every inherited child binding', () => {
    // Per-call `context.component` is the last writer in the merge
    // chain. It must override even the most-recent
    // child(...) binding. The Logger routes `component` to the
    // top-level record field rather than the `context` map.
    const componentNameArb: fc.Arbitrary<string> = fc.stringOf(
      fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
      ),
      { minLength: 1, maxLength: 12 }
    );

    fc.assert(
      fc.property(
        fc.array(componentNameArb, { minLength: 1, maxLength: 5 }),
        componentNameArb,
        (componentChain, perCallComponent) => {
          resetLoggerAndChannel();
          const ctx = makeFakeContext();
          initOutputChannel(ctx);
          initLogger(ctx);

          let logger = getLogger();
          for (const name of componentChain) {
            logger = logger.child({ component: name });
          }
          // Per-call context overrides the inherited component.
          logger.info('per-call-component-override', { component: perCallComponent });

          const lines = getCapturedLines();
          assert.strictEqual(
            lines.length,
            1,
            `expected exactly one rendered block; got ${lines.length}`
          );

          const parsed: LogRecord = parseRecord(lines[0]);
          assert.strictEqual(
            parsed.component,
            perCallComponent,
            `per-call component must override every inherited child(...) component.\n` +
              `chain=${JSON.stringify(componentChain)}\n` +
              `perCall='${perCallComponent}'\n` +
              `actual='${parsed.component}'`
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
