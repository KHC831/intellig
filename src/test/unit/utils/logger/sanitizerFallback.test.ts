/**
 * Unit test for the sanitizer fallback path.
 *
 * Pins when the `Log_Sanitizer` throws while
 * processing a `Log_Record`, the Logger SHALL emit a fallback
 * warn-level record with `message='log sanitization failed'` and
 * `component=` the original component, and SHALL drop the offending
 * record's payload.
 *
 * ### Strategy
 *
 * The production sanitizer (`src/utils/logger/sanitize.ts`) wraps its
 * top-level walk in a `try/catch`. If anything inside the walk throws
 * — including a thrown getter on a `context` leaf — the catch builds
 * a sentinel record at the same `component` / `timestamp` carrying
 * the fixed message `'log sanitization failed'` and no `context` /
 * `error` / `correlationId` payload. The Logger emit path forwards
 * that sentinel record to the sinks unchanged (the documented
 * fallback behaviour).
 *
 * To trigger the throw without monkey-patching the sanitize module,
 * we pass a `context` object whose property access *itself* throws
 * via `Object.defineProperty(...)` with a throwing getter. The
 * sanitizer's `Object.keys(value)` enumeration succeeds, but the
 * subsequent `value[key]` access raises — landing inside the
 * top-level `try/catch` and producing the sentinel result.
 *
 * The test exercises the production Logger end-to-end by registering
 * the real `OutputChannelSink` against the stubbed `IntelliG`
 * channel from `src/test/mocks/vscode.ts`, then asserting against
 * `outputChannel._lines` for the rendered fallback block.
 *
 * Test isolation follows the existing logger-test pattern (see
 * `circularContext.test.ts` and `lifecycle.test.ts`): every test
 * starts and ends with a clean Logger and OutputChannel via
 * `__resetLoggerForTest()` and `__resetOutputChannelForTest()`.
 *
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { __resetLoggerForTest, getLogger, initLogger } from '../../../../utils/logger';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../../utils/outputChannel';

/**
 * Sentinel substring that, were it ever to leak into a rendered
 * record, would prove the fallback path failed to drop the offending
 * payload. We embed it inside the throwing getter's "would-have-been"
 * value so any rendering bug that bypasses the fallback surfaces it.
 */
const PAYLOAD_LEAK_SENTINEL = 'PAYLOAD-MUST-NOT-APPEAR-IN-RENDERED-BLOCK';

/**
 * Minimal `ExtensionContext` stub matching the pattern used by sibling
 * logger tests. Only `subscriptions` is exercised by `initLogger`;
 * the rest of the surface is left undefined.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return {
    subscriptions,
  } as unknown as vscode.ExtensionContext;
}

/**
 * Capture the lines appended to the shared `IntelliG` OutputChannel.
 * The mock from `src/test/mocks/vscode.ts` exposes `_lines` on every
 * channel it creates; the production `OutputChannelSink` writes
 * through `outputChannel.appendLine`, so the rendered block lands in
 * `_lines` as a single entry per record.
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

/**
 * Build a `context` bag whose nested `poisoned` property access
 * throws when the sanitizer's recursive walker reads it.
 *
 * The throwing getter sits **one level below** the top-level context
 * (under `nested.poisoned`) so the Logger's own `_buildRecord` step —
 * which shallow-merges per-call `context` keys into `mergedContext`
 * via `value = context[key]` — only copies the inner-object reference
 * without invoking the getter. The `sanitizeRecord` walker is the
 * first reader to recurse into `nested`, enumerate its keys via
 * `Object.keys`, and read `inner[key]` — which invokes the getter
 * and throws. The sanitizer's top-level `try/catch` then converts
 * the throw into the documented `ok: false` sentinel result, which
 * the Logger forwards to the sinks as the section 4.5 fallback warn record.
 *
 * The thrown error message embeds {@link PAYLOAD_LEAK_SENTINEL} so
 * any test failure pointing at "leaked payload" is unambiguous.
 */
function makePoisonedContext(): Record<string, unknown> {
  const inner: Record<string, unknown> = { innocuous: 'inner-value' };
  Object.defineProperty(inner, 'poisoned', {
    enumerable: true,
    configurable: true,
    get(): never {
      throw new Error(`getter throws — ${PAYLOAD_LEAK_SENTINEL}`);
    },
  });
  return { harmless: 'visible-but-dropped', nested: inner };
}

describe('logger — sanitizer fallback path', () => {
  beforeEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  it('emits one warn-level fallback record when the sanitizer throws on the payload', () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);

    const componentName = 'SanitizerFallbackTest';
    const logger = getLogger().child({ component: componentName });

    // The poisoned context will throw inside the sanitizer's walk;
    // the sanitizer catches the throw and returns a sentinel record.
    // The Logger forwards the sentinel record to the sinks unchanged.
    const poisoned = makePoisonedContext();

    assert.doesNotThrow(
      () => logger.info('triggering sanitize failure', poisoned as never),
      'Logger.info with a sanitizer-throwing context must not propagate the throw'
    );

    const lines = getCapturedLines();
    assert.strictEqual(
      lines.length,
      1,
      `expected exactly one rendered block (the warn-level fallback); got ${lines.length}`
    );

    const block = lines[0];

    // The rendered block must be at the warn level. `formatRecord`
    // right-pads the level token to 5 chars, so `WARN ` is the
    // expected literal in the header column.
    assert.ok(
      / WARN {2}/.test(block),
      `fallback record must be at warn level (header must contain ' WARN  '); got:\n${block}`
    );

    // The fallback must preserve the component bound on the logger
    // that emitted the record (`component =` the
    // original component).
    assert.ok(
      block.includes(`${componentName}: `),
      `fallback record must preserve the original component '${componentName}'; got:\n${block}`
    );

    // The fixed fallback message must appear verbatim.
    assert.ok(
      block.includes('log sanitization failed'),
      `fallback record must carry message 'log sanitization failed'; got:\n${block}`
    );
  });

  it('drops the offending payload — no context, error, or original message in the fallback', () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);

    const componentName = 'SanitizerFallbackTest';
    const logger = getLogger().child({ component: componentName });

    const originalMessage = 'original-message-must-be-dropped';
    const poisoned = makePoisonedContext();

    logger.info(originalMessage, poisoned as never);

    const lines = getCapturedLines();
    assert.strictEqual(
      lines.length,
      1,
      `expected exactly one rendered block (the warn-level fallback); got ${lines.length}`
    );

    const block = lines[0];

    // The original message must NOT appear in the fallback — the
    // sanitizer never produced a clean version of it, so it must be
    // dropped entirely ("drops the offending
    // record's payload").
    assert.ok(
      !block.includes(originalMessage),
      `fallback record must NOT contain the original message; got:\n${block}`
    );

    // The poisoned getter's thrown-error sentinel must NOT leak into
    // the rendered block. If it appears, the fallback path forwarded
    // the offending payload (or its cause) to the sink.
    assert.ok(
      !block.includes(PAYLOAD_LEAK_SENTINEL),
      `fallback record must NOT leak the offending payload; got:\n${block}`
    );

    // The sibling 'harmless' field on the poisoned context must also
    // NOT appear — the fallback drops the whole context, not just the
    // throwing leaf.
    assert.ok(
      !block.includes('harmless'),
      `fallback record must NOT carry any context fields from the offending payload; got:\n${block}`
    );
    assert.ok(
      !block.includes('visible-but-dropped'),
      `fallback record must NOT carry context values from the offending payload; got:\n${block}`
    );

    // Nested non-throwing leaves under the offending payload must
    // also not appear — the fallback drops the entire context tree,
    // not just the branch containing the throwing getter.
    assert.ok(
      !block.includes('innocuous'),
      `fallback record must NOT carry nested context keys; got:\n${block}`
    );
    assert.ok(
      !block.includes('inner-value'),
      `fallback record must NOT carry nested context values; got:\n${block}`
    );

    // No `ctx=`, `cid=`, or `err=` continuation lines: the sentinel
    // record carries only the header line.
    assert.ok(
      !/^\s\sctx=/m.test(block),
      `fallback record must NOT carry a ctx= continuation line; got:\n${block}`
    );
    assert.ok(
      !/^\s\scid=/m.test(block),
      `fallback record must NOT carry a cid= continuation line; got:\n${block}`
    );
    assert.ok(
      !/^\s\serr=/m.test(block),
      `fallback record must NOT carry an err= continuation line; got:\n${block}`
    );
  });

  it('does not propagate the underlying sanitizer error to the caller', () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);

    const logger = getLogger().child({ component: 'SanitizerFallbackTest' });
    const poisoned = makePoisonedContext();

    // The Logger MUST swallow the sanitizer's throw and replace it
    // with the fallback record. A caller logging in a hot path cannot
    // be expected to wrap every `logger.info(...)` call in a
    // try/catch — the Logger boundary is the contract.
    assert.doesNotThrow(
      () => logger.info('still must not throw', poisoned as never),
      'Logger emission must swallow sanitizer-side throws'
    );

    // And the sentinel record must still have landed on the sink so
    // the caller's intent is observable in the channel.
    const lines = getCapturedLines();
    assert.strictEqual(
      lines.length,
      1,
      `fallback record must still be emitted on a sanitizer throw; got ${lines.length}`
    );
    assert.ok(
      lines[0].includes('log sanitization failed'),
      `fallback record must carry the documented message; got:\n${lines[0]}`
    );
  });
});
