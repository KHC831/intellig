/**
 * Property test for Logger non-mutation of caller bags.
 *
 * **Property 3: Logger does not mutate caller bags**
 *
 * From requirements.md → Requirement 1.6:
 *
 * > THE Logger SHALL NOT mutate any object passed as a `context`
 * > argument or as a `bindings` argument.
 *
 * Validates: Requirement 1.6.
 *
 * ### Approach
 *
 * The property is structural: every object reference handed to the
 * Logger across a call must come back byte-identical to its
 * pre-call shape. We exercise this against the production Logger by
 *
 *   1. Generating an arbitrary JSON-shaped bag (string, number,
 *      boolean, null, plus arrays and plain objects of the same).
 *   2. Snapshotting the bag with `JSON.parse(JSON.stringify(bag))` —
 *      a structural deep clone that captures the pre-call state
 *      independent of any `===` reference.
 *   3. Passing the **original** bag (not the snapshot) to a Logger
 *      method — `info`, `error`, or `child(...)`.
 *   4. After the call returns, asserting that the original bag is
 *      still `deepStrictEqual` to the snapshot.
 *
 * Both per-call `context` arguments and `child(bindings)` arguments
 * are exercised. The `child(...)` cases additionally drive an
 * emission through the resulting child Logger before snapshotting
 * the post-call state — so any mutation that happens lazily at emit
 * time (e.g. the bindings being aliased into a record's
 * `context` field and then mutated by the sanitizer) is caught.
 *
 * The arbitrary deliberately covers nested structures so cycles
 * through arrays and objects exercise the full sanitizer walk
 * (`sanitizeRecord` recurses through the same shape and MUST clone
 * containers rather than mutate them in place).
 *
 * ### Setup
 *
 * The Logger is initialized once per test against a stubbed
 * `ExtensionContext` so the OutputChannel and Console sinks are
 * registered and the full emit path runs. An admitted level
 * (`info`, `warn`, `error`) is used so the hot-path short-circuit
 * (Requirement 7.1) does NOT skip the merge / sanitize step — that
 * skip would trivially preserve the bag and hide a real mutation
 * bug. The default threshold (`'info'`) admits all three.
 *
 * Each iteration runs against the same Logger singleton; inputs are
 * fresh per iteration so cross-iteration state in the resolver or
 * sinks cannot affect the property under test.
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';

import { __resetLoggerForTest, getLogger, initLogger } from '../../utils/logger';
import { __resetOutputChannelForTest, initOutputChannel } from '../../utils/outputChannel';
import { resetMockConfiguration } from '../mocks/vscode';

/**
 * Minimal `ExtensionContext` stub. Only `subscriptions` is exercised
 * by `initLogger`; everything else is left undefined. Mirrors the
 * pattern used by the sibling logger unit tests
 * (`circularContext.test.ts`, `lifecycle.test.ts`).
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Structural deep clone via JSON round-trip. Captures every
 * primitive leaf, array shape, and plain-object shape; ignores
 * `undefined` leaves (which JSON.stringify drops anyway). The
 * generators below deliberately do NOT produce `undefined` so the
 * snapshot and original are byte-identical pre-call.
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Arbitrary over JSON-shaped values: scalars (string/number/boolean/
 * null), arrays of values, and objects keyed by short strings.
 *
 * We constrain string keys to alphanumerics and depth/breadth via
 * `maxLength` / `maxKeys` so the generated trees stay small enough
 * for the JSON walker to traverse quickly while still exercising
 * nested arrays and nested objects. The generator never emits
 * `undefined` leaves so `JSON.parse(JSON.stringify(...))` is a
 * faithful structural clone.
 *
 * `fc.letrec` builds the recursive shape; the `depthSize` knob keeps
 * the average tree shallow (fast-check 3.x default depth growth would
 * occasionally produce 6-deep nests that slow shrinking to a crawl).
 */
const jsonValueArb: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.string({ maxLength: 16 }),
    fc.integer({ min: -1000, max: 1000 }),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), tie('value'), { maxKeys: 4 })
  ),
})).value;

/**
 * Arbitrary for a top-level `context` bag: a string-keyed object of
 * JSON-shaped values. The two reserved binding keys (`component`,
 * `correlationId`) are filtered out so `context` and `bindings`
 * arbitraries don't overlap on the special-case behaviour pinned by
 * the binding-resolution properties (task 4.2).
 */
const contextArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc
    .string({ minLength: 1, maxLength: 8 })
    .filter((k) => k !== 'component' && k !== 'correlationId'),
  jsonValueArb,
  { maxKeys: 6 }
);

/**
 * Arbitrary for a `bindings` bag passed to `child(...)`. Includes
 * occasional `component` and `correlationId` keys so the special-
 * case binding-resolution path (most-recent-wins and explicit
 * correlation-id override per Requirement 1.5 and 5.2) is exercised
 * without mutation. The base shape is the same as `contextArb`.
 */
const bindingsArb: fc.Arbitrary<Record<string, unknown>> = fc
  .record({
    base: contextArb,
    component: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: undefined }),
    correlationId: fc.option(fc.hexaString({ minLength: 16, maxLength: 16 }), { nil: undefined }),
  })
  .map(({ base, component, correlationId }) => {
    const out: Record<string, unknown> = { ...base };
    if (component !== undefined) {
      out.component = component;
    }
    if (correlationId !== undefined) {
      out.correlationId = correlationId;
    }
    return out;
  });

describe('Logger non-mutation (Property 3 / Task 4.3 / Requirement 1.6)', () => {
  beforeEach(() => {
    // Reset every module-level singleton so each test starts from a
    // clean Logger / OutputChannel / mock-config state. Order
    // matters: drop the Logger first (which detaches sinks) so a
    // subsequent channel reset doesn't tear down a channel a sink
    // is still pointing at.
    __resetLoggerForTest();
    __resetOutputChannelForTest();
    resetMockConfiguration();

    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
    resetMockConfiguration();
  });

  describe('per-call `context` bag is not mutated', () => {
    it('Property: Logger.info(message, context) does not mutate the context bag', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 32 }), contextArb, (message, ctx) => {
          const snapshot = deepClone(ctx);

          // The bag the caller passes in is the SAME reference
          // — not the snapshot. If the Logger writes through it
          // anywhere along the emit path, the post-call
          // `deepStrictEqual` will catch it.
          getLogger().info(message, ctx as never);

          assert.deepStrictEqual(
            ctx,
            snapshot,
            'Logger.info must not mutate the context bag passed by the caller'
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Property: Logger.warn(message, context) does not mutate the context bag', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 32 }), contextArb, (message, ctx) => {
          const snapshot = deepClone(ctx);
          getLogger().warn(message, ctx as never);
          assert.deepStrictEqual(
            ctx,
            snapshot,
            'Logger.warn must not mutate the context bag passed by the caller'
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Property: Logger.error(message, context, error) does not mutate the context bag', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 32 }),
          contextArb,
          fc.string({ minLength: 0, maxLength: 32 }),
          (message, ctx, errorMessage) => {
            const snapshot = deepClone(ctx);
            const err = new Error(errorMessage);
            getLogger().error(message, ctx as never, err);
            assert.deepStrictEqual(
              ctx,
              snapshot,
              'Logger.error must not mutate the context bag passed by the caller'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property: repeated emissions across all admitted levels leave the same context bag intact', () => {
      // Caller pattern: build one context bag and reuse it across
      // multiple log lines. The Logger must not mutate it on any
      // call, even after several admitted-level emissions in a row
      // sharing the same bag reference.
      fc.assert(
        fc.property(contextArb, (ctx) => {
          const snapshot = deepClone(ctx);
          const logger = getLogger();

          logger.info('first', ctx as never);
          logger.warn('second', ctx as never);
          logger.error('third', ctx as never);

          assert.deepStrictEqual(
            ctx,
            snapshot,
            'consecutive Logger emissions sharing the same context bag must not mutate it'
          );
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('`child(bindings)` does not mutate the bindings bag', () => {
    it('Property: Logger.child(bindings) leaves the bindings bag intact after construction', () => {
      fc.assert(
        fc.property(bindingsArb, (bindings) => {
          const snapshot = deepClone(bindings);

          // Even before the child Logger is used, `child(...)`
          // walks the bindings bag to compute the new component /
          // correlationId / merged-context state. None of that
          // walk is allowed to write through the caller's
          // reference.
          getLogger().child(bindings as never);

          assert.deepStrictEqual(
            bindings,
            snapshot,
            'Logger.child must not mutate the bindings bag passed by the caller'
          );
        }),
        { numRuns: 100 }
      );
    });

    it('Property: emitting through a child Logger does not retroactively mutate the bindings bag', () => {
      // Lazy mutation guard: a faithful child Logger captures the
      // bindings at construction time, but the *captured* state is
      // re-walked at every emit (timestamp, sanitization,
      // multicast). If the emit path aliased the captured shape
      // back to the caller's reference, a mutation would surface
      // only AFTER the first emission. We snapshot post-child(),
      // emit, then snapshot again to catch that case.
      fc.assert(
        fc.property(
          bindingsArb,
          fc.string({ minLength: 0, maxLength: 32 }),
          contextArb,
          (bindings, message, perCallCtx) => {
            const snapshotBefore = deepClone(bindings);
            const child = getLogger().child(bindings as never);

            assert.deepStrictEqual(
              bindings,
              snapshotBefore,
              'child(bindings) must not mutate the bindings bag at construction time'
            );

            // Drive an admitted-level emission through the child.
            // The per-call context is a fresh bag; the bindings bag
            // is what we're guarding against.
            child.info(message, perCallCtx as never);

            assert.deepStrictEqual(
              bindings,
              snapshotBefore,
              'emitting through a child must not retroactively mutate the bindings bag'
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it('Property: nested child(...) calls do not mutate any ancestor bindings bag', () => {
      // Multi-level chain: a grandchild constructed from a child
      // must not mutate the parent's bindings bag, the child's
      // bindings bag, OR the grandchild's bindings bag — at any
      // point during construction or subsequent emission.
      fc.assert(
        fc.property(bindingsArb, bindingsArb, bindingsArb, (b1, b2, b3) => {
          const s1 = deepClone(b1);
          const s2 = deepClone(b2);
          const s3 = deepClone(b3);

          const c1 = getLogger().child(b1 as never);
          const c2 = c1.child(b2 as never);
          const c3 = c2.child(b3 as never);

          c3.info('chained');

          assert.deepStrictEqual(
            b1,
            s1,
            'first-level bindings bag must remain intact across the chain'
          );
          assert.deepStrictEqual(
            b2,
            s2,
            'second-level bindings bag must remain intact across the chain'
          );
          assert.deepStrictEqual(
            b3,
            s3,
            'third-level bindings bag must remain intact across the chain'
          );
        }),
        { numRuns: 50 }
      );
    });
  });

  describe('combined: child(bindings) followed by emission with per-call context', () => {
    it('Property: both bindings AND per-call context survive an emission unchanged', () => {
      fc.assert(
        fc.property(
          bindingsArb,
          fc.string({ minLength: 0, maxLength: 32 }),
          contextArb,
          (bindings, message, perCallCtx) => {
            const bindingsSnapshot = deepClone(bindings);
            const ctxSnapshot = deepClone(perCallCtx);

            const child = getLogger().child(bindings as never);
            child.info(message, perCallCtx as never);

            assert.deepStrictEqual(
              bindings,
              bindingsSnapshot,
              'bindings bag must remain intact through child(...) + emission'
            );
            assert.deepStrictEqual(
              perCallCtx,
              ctxSnapshot,
              'per-call context bag must remain intact through child(...) + emission'
            );
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
