/**
 * Unit tests for the structured Logger's lifecycle accessors.
 *
 * Pins the three lifecycle invariants (also covered by the ADR-002
 * conformance table):
 *
 * 1. **Lazy singleton** — `getLogger()` constructs the
 *    underlying root Logger on first call and returns the SAME instance
 *    on every subsequent call until `__resetLoggerForTest()` drops the
 *    cache.
 *
 * 2. **Disposable registration** — `initLogger(context)`
 *    pushes the configuration-change listener disposable AND the sink
 *    subscription disposables onto `context.subscriptions` so VS Code
 *    detaches them at deactivate time. Idempotent re-init does not push
 *    a second copy.
 *
 * 3. **Test-only reset** — `__resetLoggerForTest()`
 *    drops the cached root Logger AND detaches every registered sink
 *    (so subsequent emissions do not write through stale references).
 *    Idempotent: calling it twice does not throw.
 *
 * The test exercises the production Logger module against the stubbed
 * VS Code surface from `src/test/mocks/vscode.ts` (loaded by
 * `src/test/setup.ts`). No mocking of the Logger itself — the module's
 * own `__resetLoggerForTest` seam keeps each test isolated.
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { getLogger, initLogger, __resetLoggerForTest } from '../../../../utils/logger';
import {
  getOutputChannel,
  __resetOutputChannelForTest,
  initOutputChannel,
} from '../../../../utils/outputChannel';

/**
 * Minimal `ExtensionContext` stub. Only `subscriptions` is exercised by
 * `initLogger`; the rest of the surface is left undefined and cast
 * through `unknown` (same pattern as `outputChannelInit.test.ts`).
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return {
    subscriptions,
  } as unknown as vscode.ExtensionContext;
}

describe('logger — lifecycle accessors', () => {
  beforeEach(() => {
    // Each test starts from a clean Logger singleton AND a clean
    // OutputChannel singleton so cross-test state cannot leak.
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  describe('getLogger() — lazy singleton', () => {
    it('lazily constructs the root logger on first call', () => {
      const logger = getLogger();
      assert.ok(logger, 'first getLogger() must return a Logger instance');
      assert.strictEqual(
        typeof logger.info,
        'function',
        'returned logger must expose the info method'
      );
      assert.strictEqual(
        typeof logger.child,
        'function',
        'returned logger must expose the child method'
      );
    });

    it('returns the same instance on every subsequent call', () => {
      const first = getLogger();
      const second = getLogger();
      const third = getLogger();

      assert.strictEqual(
        first,
        second,
        'getLogger() must return the cached singleton on the second call'
      );
      assert.strictEqual(
        second,
        third,
        'getLogger() must return the cached singleton on subsequent calls'
      );
    });

    it('returns the cached instance even after initLogger registers sinks', () => {
      // Pre-init access seeds the singleton; post-init access must not
      // construct a new one — sinks attach to the existing root.
      const preInit = getLogger();
      const ctx = makeFakeContext();
      // `initOutputChannel` must run first because the OutputChannelSink
      // borrows the channel from this module; it is
      // also what extension.ts does at activation time.
      initOutputChannel(ctx);
      initLogger(ctx);
      const postInit = getLogger();

      assert.strictEqual(
        preInit,
        postInit,
        'initLogger must not replace the root Logger constructed before init'
      );
    });
  });

  describe('initLogger(context) — disposable registration', () => {
    it('pushes the configuration listener and sink subscriptions onto context.subscriptions', () => {
      const ctx = makeFakeContext();
      initOutputChannel(ctx); // pushes the channel itself (one disposable)
      const channelOnlyCount = ctx.subscriptions.length;
      assert.strictEqual(
        channelOnlyCount,
        1,
        'precondition: initOutputChannel registers exactly one disposable'
      );

      initLogger(ctx);

      // initLogger registers (per logger.ts):
      //   - the onDidChangeConfiguration listener disposable
      //   - the OutputChannelSink dispose-wrapper
      //   - the ConsoleSink dispose-wrapper
      // We assert at least 2 new entries (configuration listener +
      // sink subscription) without pinning the exact count, so the
      // sink-count detail is not over-constrained.
      const added = ctx.subscriptions.length - channelOnlyCount;
      assert.ok(
        added >= 2,
        `initLogger must push at least the configuration listener and sink subscription onto context.subscriptions; saw ${added} new entries`
      );

      // Every pushed entry must satisfy the Disposable shape so VS
      // Code's deactivate-loop can call dispose() on each.
      for (let i = channelOnlyCount; i < ctx.subscriptions.length; i++) {
        assert.strictEqual(
          typeof ctx.subscriptions[i].dispose,
          'function',
          `subscription at index ${i} must be a Disposable`
        );
      }
    });

    it('is idempotent — a second initLogger does not push a second copy', () => {
      const ctx = makeFakeContext();
      initOutputChannel(ctx);
      initLogger(ctx);
      const afterFirstInit = ctx.subscriptions.length;
      assert.ok(afterFirstInit > 1, 'precondition: first init pushed disposables');

      initLogger(ctx);

      assert.strictEqual(
        ctx.subscriptions.length,
        afterFirstInit,
        'second initLogger on the same context must be a no-op (no additional pushes)'
      );
    });

    it('disposing a pushed subscription does not throw', () => {
      const ctx = makeFakeContext();
      initOutputChannel(ctx);
      initLogger(ctx);

      // Walk every subscription and dispose it — VS Code does this
      // at deactivate time. None of them must throw, including the
      // sink dispose wrappers (idempotent disposal).
      for (const sub of ctx.subscriptions) {
        assert.doesNotThrow(
          () => sub.dispose(),
          'every disposable pushed by initLogger must dispose without throwing'
        );
      }
    });
  });

  describe('__resetLoggerForTest() — singleton drop and sink detach', () => {
    it('drops the cached singleton so the next getLogger() yields a fresh instance', () => {
      const before = getLogger();
      __resetLoggerForTest();
      const after = getLogger();

      assert.notStrictEqual(
        before,
        after,
        '__resetLoggerForTest must drop the cached root Logger so the next getLogger() returns a fresh instance'
      );
    });

    it('detaches every registered sink so subsequent emissions do not reach the OutputChannel', () => {
      // Wire up sinks via initLogger so we have something to detach.
      const ctx = makeFakeContext();
      initOutputChannel(ctx);
      initLogger(ctx);

      // Sanity check: an emission BEFORE reset reaches the channel.
      const channel = getOutputChannel() as unknown as { _lines: string[] };
      const linesBeforeEmit = channel._lines.length;
      getLogger().info('pre-reset emission');
      assert.ok(
        channel._lines.length > linesBeforeEmit,
        'precondition: emissions before reset must reach the OutputChannel sink'
      );

      // Reset detaches every registered sink.
      __resetLoggerForTest();

      // Re-acquire a fresh logger (the cache was dropped). This new
      // logger MUST NOT emit through the previously-registered sinks
      // — the sink list was cleared during reset.
      const linesBeforeSecondEmit = channel._lines.length;
      getLogger().info('post-reset emission');

      assert.strictEqual(
        channel._lines.length,
        linesBeforeSecondEmit,
        '__resetLoggerForTest must detach every registered sink so emissions after reset reach no sink'
      );
    });

    it('is idempotent — a second call does not throw', () => {
      const ctx = makeFakeContext();
      initOutputChannel(ctx);
      initLogger(ctx);

      __resetLoggerForTest();
      assert.doesNotThrow(
        () => __resetLoggerForTest(),
        'second __resetLoggerForTest call must be idempotent (no throw)'
      );
    });

    it('clears the initialization flag so a fresh context can re-init cleanly', () => {
      const ctxA = makeFakeContext();
      initOutputChannel(ctxA);
      initLogger(ctxA);
      const ctxAAfterInit = ctxA.subscriptions.length;
      assert.ok(ctxAAfterInit > 1, 'precondition: ctxA received init disposables');

      __resetLoggerForTest();

      // Fresh context must accept registration again — the
      // _initialized guard should have been cleared by the reset.
      const ctxB = makeFakeContext();
      initOutputChannel(ctxB);
      initLogger(ctxB);

      assert.ok(
        ctxB.subscriptions.length > 1,
        'after reset, a fresh context must re-receive init disposables (initialization flag cleared)'
      );
      // The earlier context remains untouched by the second init.
      assert.strictEqual(
        ctxA.subscriptions.length,
        ctxAAfterInit,
        'reset followed by re-init must not mutate the prior ExtensionContext stub'
      );
    });
  });
});
