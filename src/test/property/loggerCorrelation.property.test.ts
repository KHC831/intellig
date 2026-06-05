/**
 * Property 10: correlation-id propagation and non-fabrication.
 *
 * Pins the operational contract of the structured Logger's
 * `AsyncLocalStorage`-backed correlation store
 * (`src/utils/logger/correlation.ts`) and the `registerLoggedCommand`
 * wrapper that establishes a fresh frame per command invocation:
 *
 * 1. **Wrapped-handler propagation.** Every record emitted from inside
 *    a `registerLoggedCommand` handler body carries a `correlationId`
 *    matching `/^[0-9a-f]{16}$/` — the 16-char lowercase hex string
 *    produced by `crypto.randomBytes(8).toString('hex')` per
 *    Requirement 5.1.
 * 2. **Per-invocation distinct cids.** Two consecutive invocations of
 *    the same registered command produce two distinct frames and
 *    therefore two distinct cids — Requirement 5.1's
 *    "fresh Correlation_Id … per top-level command-handler entry".
 * 3. **Non-fabrication outside any frame.** A record emitted while no
 *    command-handler frame is on the stack (e.g. a watcher callback
 *    firing outside `_store.run(...)`) carries no `correlationId`
 *    field at all — Requirement 5.5 / 14.9 forbid fabrication, so
 *    the field is **absent** rather than the empty string or a fresh
 *    id.
 * 4. **Cid read at emit time, not at child(...) time.** A child
 *    Logger constructed inside one command frame and then called
 *    inside a different command frame attributes its records to the
 *    *current* frame's cid — design.md → "Inheritance through child
 *    loggers" makes the read-at-emit-time guarantee explicit, and
 *    Requirement 5.2 requires `child(bindings)` to preserve the
 *    parent's correlation only "unless `bindings` explicitly supplies
 *    a new one" (i.e. the child does not capture a frozen cid at
 *    construction time).
 *
 * Requirement 5.3 (`safeFireAndForget` captures the cid at call time
 * and emits it on rejection) is asserted as Property 10.4 below.
 * Task 7.1 (`safeFireAndForget` rerouted through the structured Logger
 * with `getCurrentCorrelationId()` captured at call time) has landed —
 * see `src/utils/safeFireAndForget.ts:151`. The single-shot pin lives
 * in `src/test/unit/utils/safeFireAndForget.test.ts:141`; the property
 * generalises it across arbitrary commandIds and rejection-error
 * messages.
 *
 * ### Capture strategy
 *
 * Records are captured by parsing the `IntelliG` OutputChannel's
 * `_lines` array (populated by the production `OutputChannelSink` via
 * `appendLine`). The `parseRecord` inverse from
 * `src/utils/logger/render.ts` reconstructs a `LogRecord` whose
 * `correlationId` field is exactly what the Logger emitted — present
 * iff a `cid=` continuation line is present, absent otherwise. This
 * is the same boundary the production user sees in `Output → IntelliG`,
 * so the property test pins the user-observable behaviour.
 *
 * Test isolation follows the established logger-test pattern (see
 * `lifecycle.test.ts`, `circularContext.test.ts`,
 * `adr002Conformance.test.ts`): every test resets the Logger,
 * OutputChannel, and correlation store, then re-runs
 * `initOutputChannel(ctx)` + `initLogger(ctx)` to wire fresh sinks.
 *
 * ### registerLoggedCommand under test
 *
 * The mocked `vscode.commands.registerCommand` from
 * `src/test/mocks/vscode.ts` returns a no-op disposable and does NOT
 * store the registered callback. Per the established pattern in
 * `src/test/unit/services/StatusBarService.test.ts`, this test
 * monkey-patches `vscode.commands.registerCommand` for the duration
 * of each property to capture the wrapped callback so it can be
 * invoked synchronously to drive the `_store.run(...)` frame the
 * wrapper installs. The original is restored in the property's
 * `finally` block.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 14.9**
 */

import '../setup';
import * as assert from 'assert';
import * as fc from 'fast-check';
import * as vscode from 'vscode';

import {
  __resetLoggerForTest,
  getCurrentCorrelationId,
  getLogger,
  initLogger,
  registerLoggedCommand,
} from '../../utils/logger';
import { __resetCorrelationStoreForTest } from '../../utils/logger/correlation';
import { parseRecord } from '../../utils/logger/render';
import type { LogRecord } from '../../utils/logger';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../utils/outputChannel';
import { safeFireAndForget } from '../../utils/safeFireAndForget';

/**
 * 16-char lowercase hex string — the format
 * `crypto.randomBytes(8).toString('hex')` produces and the format
 * Requirement 5.1 pins for `Correlation_Id`.
 */
const HEX16_RE = /^[0-9a-f]{16}$/;

/**
 * Build a minimal `ExtensionContext` stub. Only `subscriptions` is
 * exercised by `initOutputChannel` and `initLogger`; everything else
 * is left undefined. Same pattern used across the logger unit tests.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Snapshot of the currently-captured rendered blocks from the shared
 * `IntelliG` OutputChannel. The mock from `src/test/mocks/vscode.ts`
 * exposes `_lines` on every channel; the production
 * `OutputChannelSink` writes through `appendLine`, so each record
 * lands as a single entry.
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

/**
 * Parse every captured line into a `LogRecord` via the inverse
 * grammar exposed by `render.ts`. The Logger sanitizes records before
 * rendering, so the parsed records carry exactly the fields the user
 * would see in `Output → IntelliG`.
 */
function getCapturedRecords(): LogRecord[] {
  return getCapturedLines().map((block) => parseRecord(block));
}

/**
 * Drop both module-level singletons so each fast-check run starts
 * from a clean state. The correlation store has no global state to
 * reset (its per-frame data lives inside `_store.run(...)` callbacks
 * that are off the stack by the time we reset), but we call its
 * test-only seam for symmetry with the rest of the Logger module.
 */
function resetAll(): void {
  __resetLoggerForTest();
  __resetOutputChannelForTest();
  __resetCorrelationStoreForTest();
}

/**
 * Wire a fresh activation sequence: clean reset, then the
 * `extension.ts` ordering of `initOutputChannel(ctx)` followed by
 * `initLogger(ctx)`. Returns the stubbed context so the caller can
 * tear it down via `dispose()` if needed.
 */
function freshActivation(): vscode.ExtensionContext {
  resetAll();
  const ctx = makeFakeContext();
  initOutputChannel(ctx);
  initLogger(ctx);
  return ctx;
}

/**
 * Patch `vscode.commands.registerCommand` for the duration of the
 * caller. Returns a `restore()` thunk and a `Map` populated with
 * every callback the production wrapper passes to
 * `vscode.commands.registerCommand` (i.e. the ALS-frame-establishing
 * inner callback that `registerLoggedCommand` constructs).
 *
 * This pattern mirrors the existing harness in
 * `src/test/unit/services/StatusBarService.test.ts`: the mocked API
 * does not retain callbacks by default, so tests that need to drive
 * the registered handler must intercept the registration call itself.
 */
function patchRegisterCommand(): {
  registered: Map<string, (...args: unknown[]) => unknown>;
  restore: () => void;
} {
  const registered = new Map<string, (...args: unknown[]) => unknown>();
  const original = vscode.commands.registerCommand;
  (
    vscode.commands as unknown as {
      registerCommand: (id: string, cb: (...args: unknown[]) => unknown) => { dispose: () => void };
    }
  ).registerCommand = (id, cb) => {
    registered.set(id, cb);
    return {
      dispose: (): void => {
        registered.delete(id);
      },
    };
  };
  return {
    registered,
    restore: (): void => {
      (vscode.commands as unknown as { registerCommand: unknown }).registerCommand = original;
    },
  };
}

/**
 * Generator for VS Code-style command identifiers
 * (`<extension>.<verb>` shape). Constrained to the punctuation the
 * production extension actually uses so the inverse parser's
 * `<component>` group cannot collide with a literal `': '` in a
 * generated id (the parser splits the header line on the first
 * `': '`, so a component name containing the same separator would
 * be ambiguous — but command ids are only ever bound as
 * `Bindings.commandId` here, never as a component name).
 */
const commandIdArb: fc.Arbitrary<string> = fc
  .stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
    { minLength: 3, maxLength: 12 }
  )
  .chain((ext) =>
    fc
      .stringOf(
        fc.constantFrom(
          ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
        ),
        { minLength: 3, maxLength: 12 }
      )
      .map((verb) => `${ext}.${verb}`)
  );

/**
 * Generator for component names bound by `child({ component })`.
 * Constrained to ASCII identifiers so the rendered header line's
 * `<component>` field does not contain a literal `': '` (which would
 * confuse `parseRecord`'s lazy-match on the separator).
 */
const componentArb: fc.Arbitrary<string> = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
  { minLength: 1, maxLength: 16 }
);

/**
 * Generator for log messages. We constrain to printable ASCII
 * without `\n` / `\r` / `\\` so the captured-then-parsed records
 * round-trip byte-for-byte (the inline-escape pass is exercised by
 * task 4.7's render round-trip property; here we focus on the
 * cid plumbing only).
 */
const messageArb: fc.Arbitrary<string> = fc.stringOf(
  fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
  { minLength: 1, maxLength: 40 }
);

describe('Logger correlation-id propagation (task 4.10 / Property 10)', () => {
  beforeEach(() => {
    resetAll();
  });

  afterEach(() => {
    resetAll();
  });

  it('Property 10.1: every record emitted from inside a registerLoggedCommand handler carries a 16-char hex correlationId', () => {
    fc.assert(
      fc.property(
        commandIdArb,
        componentArb,
        fc.array(messageArb, { minLength: 1, maxLength: 5 }),
        (commandId, component, messages) => {
          freshActivation();
          const patch = patchRegisterCommand();
          try {
            // Register a handler that emits one info record per
            // generated message. The wrapper installs an ALS frame
            // around the handler body, so every emission inside the
            // body must carry the frame's correlationId.
            const disposable = registerLoggedCommand(commandId, (..._args: unknown[]) => {
              const childLogger = getLogger().child({ component });
              for (const m of messages) {
                childLogger.info(m);
              }
              // Returning undefined explicitly — the wrapper preserves
              // the handler's return value, but this property only
              // cares about the emitted records.
              return undefined;
            });

            // Pull the wrapper-installed callback out of the patched
            // registry and invoke it; this is how VS Code itself would
            // dispatch the command.
            const dispatched = patch.registered.get(commandId);
            assert.ok(
              dispatched !== undefined,
              `registerLoggedCommand must register the inner ALS-wrapping callback under id '${commandId}'`
            );
            dispatched();

            // Every captured record (one per generated message) must
            // carry a 16-char lowercase hex correlationId — the
            // signature of crypto.randomBytes(8).toString('hex')
            // (Requirement 5.1).
            const records = getCapturedRecords();
            assert.strictEqual(
              records.length,
              messages.length,
              `expected ${messages.length} record(s) emitted from inside the handler; got ${records.length}`
            );

            // The cid is fixed for the lifetime of one frame; capture
            // it from the first record and assert every subsequent
            // record carries the same value.
            const firstCid = records[0].correlationId;
            assert.ok(
              firstCid !== undefined,
              `record emitted inside the handler must carry a correlationId field (Requirement 5.1)`
            );
            assert.ok(
              HEX16_RE.test(firstCid),
              `correlationId must match /^[0-9a-f]{16}$/; got ${JSON.stringify(firstCid)}`
            );
            for (const r of records) {
              assert.strictEqual(
                r.correlationId,
                firstCid,
                'every record emitted inside one frame must carry the same cid (Requirement 5.4)'
              );
              assert.strictEqual(
                r.component,
                component,
                'child(...) component binding must propagate to every record emitted inside the frame'
              );
            }

            disposable.dispose();
          } finally {
            patch.restore();
            resetAll();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 10.2: two consecutive invocations of the same registered command produce two distinct cids', () => {
    fc.assert(
      fc.property(commandIdArb, componentArb, messageArb, (commandId, component, message) => {
        freshActivation();
        const patch = patchRegisterCommand();
        try {
          const disposable = registerLoggedCommand(commandId, () => {
            getLogger().child({ component }).info(message);
          });

          const dispatched = patch.registered.get(commandId);
          assert.ok(
            dispatched !== undefined,
            `registerLoggedCommand must register the inner ALS-wrapping callback under id '${commandId}'`
          );

          // Two independent invocations. Each MUST establish its own
          // frame with a freshly-generated cid (Requirement 5.1's
          // "fresh Correlation_Id … per top-level command-handler
          // entry").
          dispatched();
          dispatched();

          const records = getCapturedRecords();
          assert.strictEqual(
            records.length,
            2,
            `expected exactly 2 records (one per invocation); got ${records.length}`
          );

          const cidA = records[0].correlationId;
          const cidB = records[1].correlationId;

          assert.ok(
            cidA !== undefined && HEX16_RE.test(cidA),
            'first invocation must produce a valid hex cid'
          );
          assert.ok(
            cidB !== undefined && HEX16_RE.test(cidB),
            'second invocation must produce a valid hex cid'
          );
          assert.notStrictEqual(
            cidA,
            cidB,
            'two consecutive command invocations must produce two distinct cids (Requirement 5.1)'
          );

          disposable.dispose();
        } finally {
          patch.restore();
          resetAll();
        }
      }),
      { numRuns: 50 }
    );
  });

  it('Property 10.3: a record emitted from outside any command frame has correlationId absent (not fabricated)', () => {
    fc.assert(
      fc.property(
        componentArb,
        fc.array(messageArb, { minLength: 1, maxLength: 5 }),
        (component, messages) => {
          freshActivation();
          try {
            // Establish no frame at all — every emission below runs on
            // the bare stack. `getCurrentCorrelationId()` MUST return
            // `undefined` here (Requirement 5.5 / 14.9: no
            // fabrication).
            assert.strictEqual(
              getCurrentCorrelationId(),
              undefined,
              'precondition: no frame on the stack means getCurrentCorrelationId() returns undefined'
            );

            const childLogger = getLogger().child({ component });
            for (const m of messages) {
              childLogger.info(m);
            }

            const records = getCapturedRecords();
            assert.strictEqual(
              records.length,
              messages.length,
              `expected ${messages.length} record(s); got ${records.length}`
            );

            for (const r of records) {
              // The Logger MUST omit the field rather than emit an
              // empty string or a fresh id — Property 14.9 explicitly
              // forbids fabrication. The `parseRecord` inverse mirrors
              // this: when no `cid=` continuation line is present, the
              // reconstructed record has no `correlationId` key at all,
              // so `r.correlationId` is the literal `undefined`.
              assert.strictEqual(
                r.correlationId,
                undefined,
                `record emitted outside any command frame must have correlationId absent; got ${JSON.stringify(r.correlationId)}`
              );
              assert.notStrictEqual(
                r.correlationId,
                '',
                'the absent-cid case must be undefined, not the empty string (Requirement 14.9)'
              );
            }
          } finally {
            resetAll();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it("Property 10.5: a child Logger constructed inside one frame and called inside another emits the current frame's cid (read at emit time)", () => {
    fc.assert(
      fc.property(
        commandIdArb,
        commandIdArb,
        componentArb,
        messageArb,
        (commandIdA, commandIdB, component, message) => {
          // Avoid the degenerate case where both ids are equal — the
          // property is most informative when the two frames are
          // observably distinct.
          fc.pre(commandIdA !== commandIdB);

          freshActivation();
          const patch = patchRegisterCommand();
          try {
            // The child Logger is constructed inside frame A but
            // captured here so it can be invoked from inside frame B.
            // The store is read at *emit time* (design.md →
            // "Inheritance through child loggers"), so the recorded
            // cid must be frame B's, not frame A's.
            let capturedChildLogger: ReturnType<typeof getLogger> | undefined;
            let cidObservedDuringFrameA: string | undefined;

            const disposableA = registerLoggedCommand(commandIdA, () => {
              cidObservedDuringFrameA = getCurrentCorrelationId();
              capturedChildLogger = getLogger().child({ component });
              // Deliberately do NOT emit anything here. We only want
              // the child Logger reference; emission happens inside
              // frame B below.
            });
            const disposableB = registerLoggedCommand(commandIdB, () => {
              // The captured child Logger from frame A emits a record
              // here, while frame B is the one currently on the
              // stack.
              capturedChildLogger?.info(message);
            });

            const dispatchA = patch.registered.get(commandIdA);
            const dispatchB = patch.registered.get(commandIdB);
            assert.ok(dispatchA !== undefined, 'frame A handler must be registered');
            assert.ok(dispatchB !== undefined, 'frame B handler must be registered');

            // Run frame A first to capture the child Logger. No
            // record is emitted during this dispatch.
            dispatchA();
            assert.ok(
              capturedChildLogger !== undefined,
              'frame A handler must have run and captured a child Logger reference'
            );
            assert.ok(
              cidObservedDuringFrameA !== undefined && HEX16_RE.test(cidObservedDuringFrameA),
              `frame A must have established a valid cid; got ${JSON.stringify(cidObservedDuringFrameA)}`
            );

            // Run frame B; this is the dispatch that emits the
            // record via the captured child Logger from frame A.
            dispatchB();

            const records = getCapturedRecords();
            assert.strictEqual(
              records.length,
              1,
              `expected exactly 1 record (emitted from inside frame B); got ${records.length}`
            );

            const cidEmitted = records[0].correlationId;
            assert.ok(
              cidEmitted !== undefined && HEX16_RE.test(cidEmitted),
              `emitted record must carry a valid hex cid; got ${JSON.stringify(cidEmitted)}`
            );

            // The key invariant: the emitted cid MUST be a NEW value
            // distinct from frame A's cid. Frame A is off the stack
            // by the time the child Logger is asked to emit, so the
            // store read at emit time returns frame B's cid (or
            // undefined if the child captured anything frozen — but
            // since the child does not capture cids, it returns
            // frame B's).
            assert.notStrictEqual(
              cidEmitted,
              cidObservedDuringFrameA,
              "child Logger from frame A called inside frame B must NOT emit frame A's cid (cid is read at emit time, not at child(...) time)"
            );
            assert.strictEqual(
              records[0].component,
              component,
              'child(...) component binding must still propagate even when called across frames'
            );

            disposableA.dispose();
            disposableB.dispose();
          } finally {
            patch.restore();
            resetAll();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Property 10 (sub): getCurrentCorrelationId() reports undefined outside any frame and a 16-char hex inside one', () => {
    // Operational pin for the readability of the store from arbitrary
    // synchronous call sites — the same primitive `safeFireAndForget`
    // (task 7.1) will close over at call time. This sub-property
    // covers the spirit of Requirement 5.3 today; the full
    // safeFireAndForget rejection-log pin lifts in a follow-up once
    // task 7.1 lands.
    fc.assert(
      fc.property(commandIdArb, (commandId) => {
        freshActivation();
        const patch = patchRegisterCommand();
        try {
          // Outside any frame the store is empty.
          assert.strictEqual(
            getCurrentCorrelationId(),
            undefined,
            'no frame on stack ⇒ undefined (Requirement 5.5 / 14.9)'
          );

          let cidInsideFrame: string | undefined;
          const disposable = registerLoggedCommand(commandId, () => {
            cidInsideFrame = getCurrentCorrelationId();
          });
          const dispatch = patch.registered.get(commandId);
          assert.ok(dispatch !== undefined, 'registered handler must be retrievable');
          dispatch();

          assert.ok(
            cidInsideFrame !== undefined && HEX16_RE.test(cidInsideFrame),
            `getCurrentCorrelationId() inside a frame must return a 16-char hex string; got ${JSON.stringify(cidInsideFrame)}`
          );

          // After the frame pops the store is empty again — frames
          // are run-scoped so AsyncLocalStorage drops them
          // automatically.
          assert.strictEqual(
            getCurrentCorrelationId(),
            undefined,
            'frame must be off the stack after the synchronous handler returns'
          );

          disposable.dispose();
        } finally {
          patch.restore();
          resetAll();
        }
      }),
      { numRuns: 50 }
    );
  });

  // Requirement 5.3 — `safeFireAndForget` cid capture. Task 7.1
  // (safeFireAndForget rerouted through the structured Logger and
  // capturing `getCurrentCorrelationId()` at call time) has landed:
  // see `src/utils/safeFireAndForget.ts:151` (`const cid =
  // getCurrentCorrelationId()`). The single-shot pin lives in
  // `src/test/unit/utils/safeFireAndForget.test.ts:141`. This property
  // generalizes the pin across arbitrary commandIds and arbitrary
  // rejection-error messages: every record emitted by a rejection
  // fired inside a `registerLoggedCommand` frame must carry the
  // frame's correlationId, even though the AsyncLocalStorage frame
  // pops the moment the synchronous handler returns (well before the
  // rejection settles on the microtask queue).
  describe('Property 10.4: safeFireAndForget captures cid at call time and emits it on rejection', () => {
    /**
     * Yield two microtask ticks so the promise chain inside
     * `safeFireAndForget` (rejection → handler → Logger emit) settles
     * before assertions run. Mirrors the pattern in
     * `safeFireAndForget.test.ts`'s `flushMicrotasks`.
     */
    async function flushMicrotasks(): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
    }

    /**
     * Generator for rejection-error messages. Constrained to printable
     * ASCII without backslash / `\n` / `\r` so the captured-then-parsed
     * record round-trips byte-for-byte through the renderer (the
     * cross-module render-roundtrip property pins the inline-escape
     * pass elsewhere — here we focus on the cid).
     */
    const errorMessageArb: fc.Arbitrary<string> = fc.stringOf(
      fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
      { minLength: 1, maxLength: 40 }
    );

    it('emits the captured cid on every rejection record from inside a registerLoggedCommand frame', async () => {
      await fc.assert(
        fc.asyncProperty(commandIdArb, errorMessageArb, async (commandId, errorMessage) => {
          freshActivation();
          const patch = patchRegisterCommand();
          try {
            const disposable = registerLoggedCommand(commandId, () => {
              // The frame is on the AsyncLocalStorage stack right now.
              // `safeFireAndForget` reads `getCurrentCorrelationId()`
              // at call time and closes over the value for its
              // rejection-log emit. The frame will pop the moment this
              // synchronous handler returns; the captured cid still
              // propagates to the Logger.
              safeFireAndForget(Promise.reject(new Error(errorMessage)), 'PropertyTest.10.4: cid');
            });

            const dispatch = patch.registered.get(commandId);
            assert.ok(dispatch !== undefined, 'registered handler must be retrievable');
            dispatch();

            await flushMicrotasks();

            const records = getCapturedRecords();
            assert.strictEqual(
              records.length,
              1,
              `expected exactly one rendered record per safeFireAndForget rejection; got ${records.length}`
            );

            const record = records[0];
            assert.ok(
              record.correlationId !== undefined,
              'correlationId must appear on the record (cid was captured inside the frame)'
            );
            assert.match(
              record.correlationId,
              HEX16_RE,
              `correlationId must be a 16-char hex string (Requirement 5.1); got ${JSON.stringify(record.correlationId)}`
            );

            disposable.dispose();
          } finally {
            patch.restore();
            resetAll();
          }
        }),
        { numRuns: 50 }
      );
    });

    it('omits the cid field when safeFireAndForget is invoked outside any command frame', async () => {
      // Negative pin: at the boundary, no frame on the stack ⇒ the
      // helper must NOT fabricate a cid (Requirement 5.5 / 14.9). This
      // covers the watcher / activation / event-handler call sites
      // that land outside any `registerLoggedCommand` body.
      await fc.assert(
        fc.asyncProperty(errorMessageArb, async (errorMessage) => {
          freshActivation();
          // No frame on the AsyncLocalStorage stack — invoke directly.
          safeFireAndForget(
            Promise.reject(new Error(errorMessage)),
            'PropertyTest.10.4: outside-frame'
          );
          await flushMicrotasks();

          const records = getCapturedRecords();
          assert.strictEqual(
            records.length,
            1,
            `expected exactly one rendered record; got ${records.length}`
          );
          assert.strictEqual(
            records[0].correlationId,
            undefined,
            'correlationId must be undefined when no frame is on the stack (no fabrication)'
          );
          resetAll();
        }),
        { numRuns: 50 }
      );
    });
  });
});
