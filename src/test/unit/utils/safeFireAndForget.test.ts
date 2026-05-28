/**
 * Unit tests for the `safeFireAndForget` Logger routing (task 7.1).
 *
 * Pins the post-consolidation contract:
 *
 *   1. The legacy `console.error` path is gone — a rejected promise no
 *      longer writes to `console.error`. The rejection is now routed
 *      through `getLogger().error(context, { correlationId }, err)`,
 *      which lands the record in the OutputChannel sink (and, when
 *      `intellig.log.console` is on, in the Console sink as well).
 *   2. The current Correlation_Id is captured **at call time** — the
 *      cid that was active when the helper was invoked is the cid that
 *      ends up on the rejection log, even when the
 *      `AsyncLocalStorage` frame has popped before the promise
 *      settles.
 *   3. `options.outputChannel` is preserved on the public signature
 *      for back-compat but no longer does anything: the per-call
 *      OutputChannel mirror was the helper's own and the consolidated
 *      Logger sink is now the single mirror path
 *      (`docs/adr/ADR-011-structured-logger.md`).
 *
 * Tests use the production Logger module against the stubbed VS Code
 * surface from `src/test/mocks/vscode.ts` (loaded by
 * `src/test/setup.ts`); no mocking of the helper itself. Each test
 * resets the Logger and OutputChannel singletons so cross-test state
 * cannot leak.
 */

import '../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';

import { safeFireAndForget } from '../../../utils/safeFireAndForget';
import {
  __resetLoggerForTest,
  getLogger,
  initLogger,
  registerLoggedCommand,
} from '../../../utils/logger';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../utils/outputChannel';
import { parseRecord } from '../../../utils/logger/render';

/**
 * Minimal `ExtensionContext` stub — only `subscriptions` is exercised by
 * `initOutputChannel` and `initLogger`. Same shape used across the
 * sibling logger tests.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Read the rendered blocks the OutputChannelSink wrote to the shared
 * `IntelliG` channel. The mock from `src/test/mocks/vscode.ts` exposes
 * `_lines` on every channel; the production sink writes one rendered
 * block per record via `outputChannel.appendLine`.
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

/**
 * Flush two microtask ticks so the promise chain in `safeFireAndForget`
 * completes. `Promise.resolve(promise)` introduces one turn; the `.catch`
 * handler runs on the next.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('safeFireAndForget — Logger routing (task 7.1)', () => {
  beforeEach(() => {
    // Drop the Logger first (which detaches sinks) before resetting
    // the channel so a stray emission cannot race a half-disposed
    // channel.
    __resetLoggerForTest();
    __resetOutputChannelForTest();

    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  it('emits an error-level Log_Record through the Logger when the promise rejects', async () => {
    const err = new Error('boom');
    safeFireAndForget(Promise.reject(err), 'TestClass.method: context');
    await flushMicrotasks();

    const lines = getCapturedLines();
    assert.strictEqual(lines.length, 1, 'expected exactly one rendered record');

    const record = parseRecord(lines[0]);
    assert.strictEqual(record.level, 'error', 'rejection must emit at error level');
    assert.strictEqual(
      record.message,
      'TestClass.method: context',
      'context string must be the rendered message'
    );
    assert.strictEqual(record.error?.message, 'boom', 'Error.message must reach the err= block');
    assert.ok(
      record.error?.stack && record.error.stack.includes('at '),
      'Error.stack must reach the err= continuation lines'
    );
  });

  it('emits no Log_Record when the promise resolves successfully', async () => {
    safeFireAndForget(Promise.resolve(), 'TestClass.method: success');
    await flushMicrotasks();

    assert.strictEqual(getCapturedLines().length, 0, 'no log on success');
  });

  it('routes non-Error rejections through the Logger without a stack block', async () => {
    safeFireAndForget(Promise.reject('plain string reason'), 'TestClass.method: context');
    await flushMicrotasks();

    const lines = getCapturedLines();
    assert.strictEqual(lines.length, 1, 'expected exactly one rendered record');

    const record = parseRecord(lines[0]);
    assert.strictEqual(record.level, 'error');
    assert.strictEqual(record.message, 'TestClass.method: context');
    assert.strictEqual(
      record.error,
      undefined,
      'non-Error rejections must not synthesise an err= block'
    );
  });

  it('captures the current Correlation_Id at call time and emits it on rejection', async () => {
    // Drive the helper from inside a `registerLoggedCommand` frame so
    // a fresh Correlation_Id is on the AsyncLocalStorage stack at the
    // moment the helper is invoked. The cid the Logger emits must
    // equal the one captured at call time, even though the frame has
    // popped by the time the rejection settles.
    const commandId = 'intellig.test.cidCapture';
    let registeredHandler: ((...args: unknown[]) => unknown) | undefined;
    const originalRegisterCommand = vscode.commands.registerCommand;
    (vscode.commands as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand = (
      _id: string,
      handler: (...args: unknown[]) => unknown
    ): vscode.Disposable => {
      registeredHandler = handler;
      return { dispose: (): void => undefined };
    };

    try {
      const disposable = registerLoggedCommand(commandId, () => {
        // Fire the rejection from inside the frame. The frame will
        // pop the moment this synchronous handler returns.
        safeFireAndForget(Promise.reject(new Error('cid-test')), 'TestClass.method: cid');
      });

      assert.ok(registeredHandler !== undefined, 'registerLoggedCommand must register a handler');
      registeredHandler();
      disposable.dispose();
    } finally {
      (vscode.commands as { registerCommand: typeof vscode.commands.registerCommand }).registerCommand =
        originalRegisterCommand;
    }

    await flushMicrotasks();

    const lines = getCapturedLines();
    assert.strictEqual(lines.length, 1, 'expected exactly one rendered record');

    const record = parseRecord(lines[0]);
    assert.ok(
      record.correlationId !== undefined,
      'correlationId must appear on the record (cid was captured inside the frame)'
    );
    assert.match(
      record.correlationId,
      /^[0-9a-f]{16}$/,
      'correlationId must be a 16-char hex string from the registerLoggedCommand frame'
    );
  });

  it('omits the correlationId field when called outside any command frame', async () => {
    // No frame on the AsyncLocalStorage stack — `getCurrentCorrelationId()`
    // returns undefined and the helper must NOT fabricate a cid.
    safeFireAndForget(Promise.reject(new Error('no-frame')), 'TestClass.method: outside');
    await flushMicrotasks();

    const lines = getCapturedLines();
    assert.strictEqual(lines.length, 1, 'expected exactly one rendered record');

    const record = parseRecord(lines[0]);
    assert.strictEqual(
      record.correlationId,
      undefined,
      'correlationId must be omitted when no frame is on the stack (Requirement 5.5)'
    );
  });

  it('ignores options.outputChannel — the per-call channel mirror is no longer wired', async () => {
    // Back-compat: the field is still on the public signature so existing
    // callers compile; the value is unused. Capture this with a hand-rolled
    // OutputChannel that records every write — it must stay empty.
    const lines: string[] = [];
    const sideChannel = {
      name: 'unused',
      append(_v: string): void {
        lines.push(_v);
      },
      appendLine(v: string): void {
        lines.push(v);
      },
      clear(): void {
        lines.length = 0;
      },
      show(): void {
        /* no-op */
      },
      hide(): void {
        /* no-op */
      },
      dispose(): void {
        /* no-op */
      },
      replace(v: string): void {
        lines.length = 0;
        lines.push(v);
      },
    } as unknown as vscode.OutputChannel;

    safeFireAndForget(Promise.reject(new Error('boom')), 'TestClass.method: ignored', {
      outputChannel: sideChannel,
    });
    await flushMicrotasks();

    assert.strictEqual(
      lines.length,
      0,
      'the side OutputChannel must receive nothing — options.outputChannel is unused'
    );
    // The rejection still reaches the Logger's shared OutputChannel sink.
    assert.strictEqual(
      getCapturedLines().length,
      1,
      'the shared IntelliG channel still receives the record via the Logger sink'
    );
  });

  it('does not call console.error on rejection (legacy path is removed)', async () => {
    const errorLogs: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]): void => {
      errorLogs.push(args);
    };

    try {
      safeFireAndForget(Promise.reject(new Error('boom')), 'TestClass.method: legacy-removed');
      await flushMicrotasks();
    } finally {
      console.error = originalConsoleError;
    }

    // Defensive: when `intellig.log.console` is enabled the ConsoleSink
    // does mirror error records to `console.error`, but the default
    // VS Code mock leaves the setting off. Either way, the helper
    // itself must not be the source of a `console.error` call.
    // The strongest pin is "no [intellig] <context>: <err>" tag —
    // the literal prefix used by the legacy code path.
    for (const args of errorLogs) {
      const head = args[0];
      assert.ok(
        typeof head !== 'string' || !head.startsWith('[intellig] TestClass.method: legacy-removed'),
        'legacy "[intellig] <context>:" console.error tag must no longer be emitted'
      );
    }

    // The Logger record must still have landed.
    assert.strictEqual(getCapturedLines().length, 1, 'rejection still reaches the Logger sink');
  });

  it('keeps `getLogger()` resolution lazy — does not throw when invoked before initLogger', async () => {
    // Reset both singletons so the helper has to resolve `getLogger()`
    // against an un-initialised module. The Logger's lazy seam means
    // `getLogger()` returns a working root instance even without
    // `initLogger`; emissions land nowhere (no sinks attached) but the
    // helper itself must not throw.
    __resetLoggerForTest();
    __resetOutputChannelForTest();

    assert.doesNotThrow(() => {
      safeFireAndForget(Promise.reject(new Error('pre-init')), 'TestClass.method: pre-init');
    }, 'helper must tolerate a pre-init Logger (lazy singleton)');

    await flushMicrotasks();
    // No sinks are attached pre-init, so `getCapturedLines()` returns the
    // freshly-recreated channel's empty buffer.
    assert.strictEqual(
      getCapturedLines().length,
      0,
      'no record should land when no sinks are attached'
    );

    // Re-init for the afterEach reset to run cleanly.
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    initLogger(ctx);
    void getLogger();
  });
});
