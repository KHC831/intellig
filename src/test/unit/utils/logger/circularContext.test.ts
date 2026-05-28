/**
 * Task 3.6 — unit test for circular reference handling in `context`.
 *
 * Pins Requirement 7.4: when a `Logger` method is called with a
 * `context` argument that contains a circular reference, the Logger
 * must render the offending sub-value as the literal string
 * `'[Circular]'` without throwing and without entering an infinite
 * loop.
 *
 * The sanitizer (`src/utils/logger/sanitize.ts`) substitutes
 * `'[Circular]'` for revisited objects and arrays via a `WeakSet`-
 * backed cycle detector. This test exercises the production
 * Logger end-to-end:
 *
 *   - register the production sinks via `initLogger(context)` so a
 *     real `OutputChannelSink` writes through to the stubbed
 *     `IntelliG` channel from `src/test/mocks/vscode.ts`,
 *   - emit a record whose `context` carries a self-referential
 *     object (and a self-referential array, in a separate case),
 *   - capture the channel's `_lines` to assert the rendered block
 *     contains the `'[Circular]'` marker for the offending sub-value
 *     and does NOT contain any infinite-recursion artifact (e.g. a
 *     `RangeError` or a runaway block).
 *
 * Test isolation follows the existing logger-test pattern
 * (see `lifecycle.test.ts`): every test starts and ends with a clean
 * Logger and OutputChannel via `__resetLoggerForTest()` and
 * `__resetOutputChannelForTest()`.
 *
 * _Validates: Requirement 7.4_
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  __resetLoggerForTest,
  getLogger,
  initLogger,
} from '../../../../utils/logger';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../../utils/outputChannel';

/**
 * Minimal `ExtensionContext` stub matching the pattern used by the
 * sibling logger tests. Only `subscriptions` is exercised by
 * `initLogger`; the rest of the surface is left undefined.
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
 * `_lines` as a single entry per record (Requirement 3.2).
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

describe('logger — circular reference handling (task 3.6 / Requirement 7.4)', () => {
  beforeEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  it('renders [Circular] for a self-referential object in context without throwing', () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);

    // Build a self-referential object: `circular.self === circular`.
    // Typed as `Record<string, unknown>` and forced through `unknown`
    // when handed to the Logger so the JSON-shaped `Bindings` type
    // does not refuse the cycle at compile time. The runtime
    // sanitizer is what we actually exercise here.
    const circular: Record<string, unknown> = { name: 'outer' };
    circular.self = circular;

    const logger = getLogger().child({ component: 'CircularTest' });

    // Assert no throw and no infinite loop. The test runner's
    // overall timeout (30s, see `.mocharc.json`) is the loop-bound
    // safety net; the sanitizer's `WeakSet` cycle detector should
    // make the call complete in microseconds.
    assert.doesNotThrow(
      () => logger.info('self-ref object', circular as never),
      'Logger.info with a self-referential context must not throw'
    );

    const lines = getCapturedLines();
    assert.strictEqual(
      lines.length,
      1,
      `expected exactly one rendered block, got ${lines.length}`
    );

    const block = lines[0];

    // The header line carries the message; the `ctx=` continuation
    // line carries the JSON-rendered context. The offending sub-
    // value (`self`) must have been substituted with `'[Circular]'`
    // by the sanitizer before reaching `formatRecord`.
    assert.ok(
      block.includes('[Circular]'),
      `rendered block must contain '[Circular]' marker; got:\n${block}`
    );

    // Belt-and-braces: the marker must appear inside the `ctx=`
    // line specifically (not on some unrelated continuation).
    assert.ok(
      /ctx=.*\[Circular\]/.test(block),
      `'[Circular]' must appear inside the ctx= continuation line; got:\n${block}`
    );

    // The non-circular sibling key must survive the walk verbatim
    // so we know the cycle detection didn't collapse the whole
    // object tree into the marker.
    assert.ok(
      block.includes('"name":"outer"'),
      `non-circular sibling field must be preserved; got:\n${block}`
    );
  });

  it('renders [Circular] for a self-referential array in context without throwing', () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);

    // Build a self-referential array: `circular[1] === circular`.
    // The first element is a primitive so the rendered form
    // distinguishes the cycle from any literal array stringification
    // bug.
    const circular: unknown[] = ['head'];
    circular.push(circular);

    const logger = getLogger().child({ component: 'CircularTest' });

    assert.doesNotThrow(
      () => logger.info('self-ref array', { items: circular } as never),
      'Logger.info with a self-referential array in context must not throw'
    );

    const lines = getCapturedLines();
    assert.strictEqual(
      lines.length,
      1,
      `expected exactly one rendered block, got ${lines.length}`
    );

    const block = lines[0];

    assert.ok(
      block.includes('[Circular]'),
      `rendered block must contain '[Circular]' marker for the cyclic array; got:\n${block}`
    );
    assert.ok(
      block.includes('"head"'),
      `non-circular leading element must be preserved; got:\n${block}`
    );
  });

  it('renders [Circular] for a nested self-referential object without throwing', () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);

    // Build a deeper cycle: `inner.parent === outer` where `outer`
    // owns `inner`. This exercises the recursive walk's `WeakSet`
    // threading — the cycle is detected one frame below the root
    // rather than at the root itself.
    const inner: Record<string, unknown> = { tag: 'inner' };
    const outer: Record<string, unknown> = { tag: 'outer', child: inner };
    inner.parent = outer;

    const logger = getLogger().child({ component: 'CircularTest' });

    assert.doesNotThrow(
      () => logger.info('nested self-ref', outer as never),
      'Logger.info with a nested self-referential context must not throw'
    );

    const lines = getCapturedLines();
    assert.strictEqual(
      lines.length,
      1,
      `expected exactly one rendered block, got ${lines.length}`
    );

    const block = lines[0];

    assert.ok(
      block.includes('[Circular]'),
      `rendered block must contain '[Circular]' marker for the nested cycle; got:\n${block}`
    );
    // Both tags survive the walk — neither sub-object collapses
    // wholesale into the marker.
    assert.ok(
      block.includes('"tag":"outer"'),
      `outer tag must be preserved; got:\n${block}`
    );
    assert.ok(
      block.includes('"tag":"inner"'),
      `inner tag must be preserved; got:\n${block}`
    );
  });
});
