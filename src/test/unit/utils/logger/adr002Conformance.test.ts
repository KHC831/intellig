/**
 * ADR-002 conformance for the structured Logger
 * (`src/utils/logger/`).
 *
 * ADR-002 (`docs/adr/ADR-002-module-level-singletons-in-utils.md`)
 * permits a module-level singleton in `src/utils/` only when **all
 * four** of these criteria hold:
 *
 *   1. **Cross-cutting sink** — the module is a logging / telemetry /
 *      error-routing surface every layer of the extension writes
 *      into. Not business state, not cached data, not a config
 *      projection.
 *   2. **Needs early access** — at least one real consumer calls the
 *      module BEFORE `ExtensionServices.initialize()` finishes wiring
 *      the service graph (the canonical case is a service constructor
 *      that emits its first record during construction).
 *   3. **Test-isolation hook** — the module exposes a reset/dispose
 *      helper following the `__<name>ForTest` prefix idiom so unit
 *      tests run against a fresh singleton each time (no order-
 *      dependent flakiness from leaked state).
 *   4. **Registered for disposal** — the module exposes an
 *      `initX(context)` function that registers the cached instance
 *      against `context.subscriptions` so VS Code drops it on
 *      deactivate (callers of `getX()` don't think about lifetime).
 *
 * design.md → "Logger module location" lists how `src/utils/logger/`
 * satisfies each criterion. This test is the executable counterpart
 * of that table — a pin so a future refactor cannot quietly break one
 * of the criteria without the build going red.
 *
 * The test is deliberately complementary to `lifecycle.test.ts`
 * (which pins the lifecycle accessors in operational detail) and
 * `sinkLifecycle.test.ts` (which pins the channel-ownership
 * boundary). This file groups the four criteria together under the
 * ADR-002 framing so a reviewer reading the ADR can read this test
 * straight across.
 *
 * _Validates: Requirements 8.5, 11.2_
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  __resetLoggerForTest,
  getCurrentCorrelationId,
  getLogger,
  initLogger,
  registerLoggedCommand,
  type Logger,
} from '../../../../utils/logger';
import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../../utils/outputChannel';

/**
 * Minimal `ExtensionContext` stub. Only `subscriptions` is exercised
 * by `initOutputChannel` and `initLogger`; everything else is left
 * undefined and cast through `unknown` (same pattern as the sibling
 * logger tests).
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

/**
 * Capture the rendered blocks appended to the shared `IntelliG`
 * OutputChannel. The mock from `src/test/mocks/vscode.ts` exposes
 * `_lines` on every channel it creates; the production
 * `OutputChannelSink` writes through `outputChannel.appendLine`, so
 * each record lands as a single entry.
 */
function getCapturedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

describe('logger — ADR-002 conformance (task 3.8 / Requirements 8.5, 11.2)', () => {
  beforeEach(() => {
    // Clean both singletons before every test so cross-test state
    // cannot leak. Order matters: drop the Logger first (which
    // detaches sinks) before the channel resets, so a stray
    // emission cannot race a half-disposed channel.
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  // ---------------------------------------------------------------
  // Criterion 1 — cross-cutting sink
  // ---------------------------------------------------------------
  // The module is a logging surface every layer writes into. The
  // executable pins for that are: (a) the public barrel exports
  // `getLogger`, `initLogger`, `__resetLoggerForTest`, and the
  // command-wrapping helper `registerLoggedCommand` — the four
  // pieces every layer (services, providers, command handlers,
  // safeFireAndForget) needs; (b) the returned Logger exposes the
  // five level methods + `child(...)` so each consumer can bind
  // its own component without further plumbing.

  describe('Criterion 1 — cross-cutting sink (ADR-002 §1)', () => {
    it('the public barrel exports the cross-cutting surface every layer needs', () => {
      // Each accessor MUST be a function — no class constructors
      // exposed, no factories that need configuration before use.
      // Together they are the entry points the rest of the
      // extension calls (cf. design.md → "Logger module location"
      // → public barrel surface).
      assert.strictEqual(
        typeof getLogger,
        'function',
        'public barrel must export getLogger() — the cross-cutting accessor'
      );
      assert.strictEqual(
        typeof initLogger,
        'function',
        'public barrel must export initLogger(context) — the disposal-registration entry point'
      );
      assert.strictEqual(
        typeof __resetLoggerForTest,
        'function',
        'public barrel must export __resetLoggerForTest() — the test-isolation hook'
      );
      assert.strictEqual(
        typeof registerLoggedCommand,
        'function',
        'public barrel must export registerLoggedCommand() — the command-handler boundary that threads correlation ids'
      );
      assert.strictEqual(
        typeof getCurrentCorrelationId,
        'function',
        'public barrel must export getCurrentCorrelationId() — the cross-cutting correlation read'
      );
    });

    it('getLogger() returns the canonical structured-log boundary every layer uses', () => {
      const root = getLogger();

      // The five level methods + child(): the surface every
      // service / provider / command handler binds against
      // (Requirement 1.1).
      for (const name of ['trace', 'debug', 'info', 'warn', 'error', 'child'] as const) {
        const method = (root as unknown as Record<string, unknown>)[name];
        assert.strictEqual(
          typeof method,
          'function',
          `Logger must expose ${name}() — required by every layer that writes structured records`
        );
      }

      // `child(bindings)` returns a Logger — the per-component
      // binding pattern services use (e.g. `getLogger().child({
      // component: 'GitService' })`). Without this, the singleton
      // would not be cross-cutting in practice.
      const child = root.child({ component: 'AdrConformanceTest' });
      assert.strictEqual(
        typeof child.info,
        'function',
        'Logger.child(...) must return a Logger so each layer can bind its own component'
      );
      assert.notStrictEqual(
        child,
        root,
        'Logger.child(...) must return a fresh Logger, not the parent reference'
      );
    });
  });

  // ---------------------------------------------------------------
  // Criterion 2 — needs early access
  // ---------------------------------------------------------------
  // At least one real consumer calls `getLogger()` BEFORE
  // `ExtensionServices.initialize()` finishes (e.g. a service
  // constructor that emits a record). The pins:
  // (a) `getLogger()` is safe to call before `initLogger(context)`
  //     has run — no throw, returns a usable Logger.
  // (b) Calling level methods on that pre-init Logger does not
  //     throw, so a service constructor that emits during
  //     construction does not race a missing sink.
  // (c) AFTER `initLogger(context)` registers sinks, the SAME
  //     Logger instance starts emitting through them — services
  //     constructed pre-init don't need to re-fetch a logger.

  describe('Criterion 2 — needs early access (ADR-002 §2)', () => {
    it('getLogger() is safe before initLogger(context) — no throw, no allocation requirement', () => {
      // Reset has already cleared all module-level state. Calling
      // getLogger() now mimics a service constructor that fires
      // during ExtensionServices.initialize() before initLogger
      // could have run. The call must succeed.
      let logger: Logger | undefined;
      assert.doesNotThrow(() => {
        logger = getLogger();
      }, 'getLogger() must succeed even before initLogger(context) has run');

      assert.ok(logger, 'getLogger() must return a Logger instance pre-init');
      assert.strictEqual(
        typeof logger?.info,
        'function',
        'pre-init Logger must expose info() — services emit during construction'
      );
    });

    it('level methods do not throw when called before initLogger(context)', () => {
      const logger = getLogger().child({ component: 'EarlyAccessTest' });

      // Each call mimics a service constructor's first emission.
      // None must throw — the resolver's defaults (`'info'` /
      // `false`) keep emissions safely filtered, and calls land
      // on the empty `_sinks` array (no-op multicast) rather
      // than a missing-sink error.
      assert.doesNotThrow(() => logger.trace('pre-init trace'), 'trace() pre-init must not throw');
      assert.doesNotThrow(() => logger.debug('pre-init debug'), 'debug() pre-init must not throw');
      assert.doesNotThrow(() => logger.info('pre-init info'), 'info() pre-init must not throw');
      assert.doesNotThrow(() => logger.warn('pre-init warn'), 'warn() pre-init must not throw');
      assert.doesNotThrow(
        () => logger.error('pre-init error', new Error('boom')),
        'error() pre-init must not throw'
      );
    });

    it('the same Logger instance keeps working after initLogger(context) registers sinks', () => {
      // Get a Logger pre-init (mimics a service constructor).
      const preInit = getLogger();
      const childPreInit = preInit.child({ component: 'EarlyAccessTest' });

      // Then run the activation order from extension.ts:
      // initOutputChannel(context) → initLogger(context).
      const ctx = makeFakeContext();
      initOutputChannel(ctx);
      initLogger(ctx);

      // The pre-init root Logger reference is still the singleton.
      assert.strictEqual(
        getLogger(),
        preInit,
        'initLogger must NOT replace the root Logger constructed before init — services constructed pre-init keep the same reference'
      );

      // Emitting through the pre-init child Logger now reaches
      // the sinks that initLogger registered. This is the
      // operational meaning of "early access works": a service
      // captured the Logger reference before init and still gets
      // its records routed.
      const linesBefore = getCapturedLines().length;
      childPreInit.info('post-init emission via pre-init Logger');
      const linesAfter = getCapturedLines().length;

      assert.strictEqual(
        linesAfter,
        linesBefore + 1,
        'a Logger captured pre-init must emit through the post-init sinks (early access remains useful after initLogger runs)'
      );
    });
  });

  // ---------------------------------------------------------------
  // Criterion 3 — test-isolation hook
  // ---------------------------------------------------------------
  // The module exposes `__resetLoggerForTest()` following the
  // `__<name>ForTest` prefix idiom (docs/testing.md §3). The hook
  // drops the cached singleton AND detaches every registered sink.
  // Without this, sibling tests would inherit each other's sinks
  // and the resolver state, and a `_lines` assertion would mix
  // bleed-through writes with the test's own emissions.

  describe('Criterion 3 — test-isolation hook (ADR-002 §3)', () => {
    it('__resetLoggerForTest follows the __<name>ForTest prefix idiom', () => {
      // Pin the literal name. The structural CI guard
      // `scripts/check-test-only-surface.sh` enforces that no
      // production caller references this symbol; this test pins
      // the public-barrel side of the contract — that the symbol
      // exists at the documented name with the documented arity.
      assert.strictEqual(
        typeof __resetLoggerForTest,
        'function',
        '__resetLoggerForTest must be exported from the public barrel'
      );
      assert.strictEqual(
        __resetLoggerForTest.length,
        0,
        '__resetLoggerForTest must take no arguments (test-only seam)'
      );
      assert.ok(
        __resetLoggerForTest.name.startsWith('__'),
        '__resetLoggerForTest must follow the __<name>ForTest prefix idiom (docs/testing.md §3)'
      );
      assert.ok(
        __resetLoggerForTest.name.endsWith('ForTest'),
        '__resetLoggerForTest must follow the __<name>ForTest suffix idiom (docs/testing.md §3)'
      );
    });

    it('drops the cached singleton AND detaches every registered sink', () => {
      // Wire up a real Logger with sinks pointing at the cached
      // OutputChannel. An emission BEFORE reset must reach the
      // channel; an emission AFTER reset (from a fresh logger)
      // must NOT — the sinks were detached.
      const ctx = makeFakeContext();
      initOutputChannel(ctx);
      initLogger(ctx);

      const before = getLogger();
      const linesBeforeEmit = getCapturedLines().length;
      before.info('pre-reset emission');
      assert.ok(
        getCapturedLines().length > linesBeforeEmit,
        'precondition: pre-reset emissions must reach the OutputChannel sink'
      );

      // The reset hook does both jobs: drop the singleton + detach sinks.
      __resetLoggerForTest();

      const after = getLogger();
      assert.notStrictEqual(
        after,
        before,
        '__resetLoggerForTest must drop the cached singleton (next getLogger() yields a fresh instance)'
      );

      const linesBeforeSecondEmit = getCapturedLines().length;
      after.info('post-reset emission');
      assert.strictEqual(
        getCapturedLines().length,
        linesBeforeSecondEmit,
        '__resetLoggerForTest must detach every registered sink (post-reset emissions reach no sink)'
      );
    });
  });

  // ---------------------------------------------------------------
  // Criterion 4 — registered for disposal
  // ---------------------------------------------------------------
  // `initLogger(context)` pushes disposables onto
  // `context.subscriptions` so VS Code drops the configuration
  // listener and the sink wrappers on deactivate. Callers of
  // getLogger() don't think about lifetime — the host
  // ExtensionContext owns it.

  describe('Criterion 4 — registered for disposal (ADR-002 §4)', () => {
    it('initLogger(context) pushes disposables onto context.subscriptions', () => {
      const ctx = makeFakeContext();
      // initOutputChannel already pushed the channel itself onto
      // subscriptions[0] — that's a separate disposable owned by
      // a sibling singleton. Take its count as the baseline so
      // we are only counting the Logger's contribution.
      initOutputChannel(ctx);
      const baseline = ctx.subscriptions.length;
      assert.strictEqual(
        baseline,
        1,
        'precondition: initOutputChannel registered exactly one disposable'
      );

      initLogger(ctx);

      // initLogger must register at least the configuration
      // listener AND a sink wrapper (the design.md sequence
      // diagram shows three: listener + OutputChannelSink wrapper
      // + ConsoleSink wrapper — but we pin "at least 2" here so
      // the sink-count detail is not over-constrained).
      const added = ctx.subscriptions.length - baseline;
      assert.ok(
        added >= 2,
        `initLogger must push at least the configuration listener and a sink subscription onto context.subscriptions; saw ${added} new entries`
      );

      // Every pushed entry must satisfy the Disposable shape so
      // VS Code's deactivate-loop can call dispose() on each.
      for (let i = baseline; i < ctx.subscriptions.length; i++) {
        assert.strictEqual(
          typeof ctx.subscriptions[i].dispose,
          'function',
          `subscription at index ${i} must be a Disposable`
        );
      }
    });

    it('disposing every Logger-registered subscription does not throw and does not destroy the underlying channel', () => {
      // The ExtensionContext owns the lifetime — VS Code calls
      // dispose() on every subscription at deactivate. The
      // Logger's sink wrappers MUST be idempotent (Requirement
      // 3.4) and MUST NOT dispose the underlying channel (which
      // is owned by initOutputChannel's separate subscription).
      const ctx = makeFakeContext();
      initOutputChannel(ctx);
      const channel = getOutputChannel();

      let channelDisposeCount = 0;
      const originalDispose = channel.dispose.bind(channel);
      channel.dispose = function (): void {
        channelDisposeCount++;
        originalDispose();
      };

      initLogger(ctx);

      // Walk every Logger-owned subscription (skip index 0, which
      // is the channel registration owned by initOutputChannel)
      // and dispose it. None must throw; the channel must
      // survive.
      const channelSubscription = ctx.subscriptions[0];
      const loggerOwnedSubscriptions = ctx.subscriptions.slice(1);
      assert.ok(
        loggerOwnedSubscriptions.length >= 2,
        `precondition: initLogger registered ≥2 disposables; got ${loggerOwnedSubscriptions.length}`
      );

      for (const sub of loggerOwnedSubscriptions) {
        assert.doesNotThrow(
          () => sub.dispose(),
          'every Logger-owned subscription must dispose without throwing (VS Code deactivate-loop runs them blindly)'
        );
      }
      assert.strictEqual(
        channelDisposeCount,
        0,
        'disposing the Logger-owned subscriptions must NOT dispose the channel — Requirement 3.4 (sink borrows; initOutputChannel owns)'
      );

      // Now VS Code disposes the channel via initOutputChannel's
      // own subscription, exactly once.
      channelSubscription.dispose();
      assert.strictEqual(
        channelDisposeCount,
        1,
        "channel disposal happens via initOutputChannel's registered subscription, not the Logger sink wrapper"
      );
    });
  });

  // ---------------------------------------------------------------
  // All four criteria together — the ADR-002 conformance summary.
  // This case exercises the complete activation sequence end-to-
  // end so a reviewer reading the ADR can trace the conformance
  // through one operational scenario.
  // ---------------------------------------------------------------

  it('all four criteria — end-to-end activation/deactivation respects ADR-002', () => {
    // §2 — pre-init access works. Mimics a service constructor
    // capturing the Logger before initLogger runs.
    const earlyLogger = getLogger().child({ component: 'EndToEndTest' });
    assert.strictEqual(typeof earlyLogger.info, 'function', '§2 — pre-init Logger must be usable');

    // §4 — initLogger registers disposables for VS Code teardown.
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    const baseline = ctx.subscriptions.length;
    initLogger(ctx);
    assert.ok(
      ctx.subscriptions.length - baseline >= 2,
      '§4 — initLogger must push ≥2 disposables (listener + sink wrappers)'
    );

    // §1 — emissions through the cross-cutting Logger reach the
    // OutputChannel sink. The pre-init Logger captured at top of
    // this case still works, proving §2 stays operational once
    // sinks are wired.
    const linesBefore = getCapturedLines().length;
    earlyLogger.info('end-to-end conformance message');
    assert.strictEqual(
      getCapturedLines().length,
      linesBefore + 1,
      '§1 + §2 — pre-init Logger emits through post-init sinks'
    );

    // §3 — the test-isolation hook tears it all down. Subsequent
    // emissions reach no sink.
    __resetLoggerForTest();
    const freshLogger = getLogger().child({ component: 'EndToEndTest' });
    const linesAfterReset = getCapturedLines().length;
    freshLogger.info('post-reset emission must not reach any sink');
    assert.strictEqual(
      getCapturedLines().length,
      linesAfterReset,
      '§3 — __resetLoggerForTest detaches every sink'
    );
  });
});
