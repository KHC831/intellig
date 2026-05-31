/**
 * Logger OutputChannel sink lifecycle.
 *
 * Pins two boundary properties of the structured Logger's
 * `OutputChannelSink` (see `src/utils/logger/sinks/OutputChannelSink.ts`)
 * and the way `initLogger(context)` plumbs it into the shared
 * `IntelliG` `vscode.OutputChannel`:
 *
 * 1. **Single channel.** `initLogger(context)` must register exactly
 *    one OutputChannel-backed sink whose underlying channel is the
 *    singleton returned by `getOutputChannel()`. A second
 *    `createOutputChannel('IntelliG')` call would put two duplicate
 *    entries in the `Output → IntelliG` dropdown — the cache and
 *    Requirement 3.5 forbid it.
 *
 * 2. **Sink does not own the channel.** Calling `dispose()` on the
 *    sink (or on the disposable wrapper `initLogger` pushes onto
 *    `context.subscriptions`) must NOT dispose the underlying
 *    `vscode.OutputChannel`. The channel is owned by
 *    `initOutputChannel(context)` per Requirement 3.4 — a sink that
 *    disposed it would tear down the channel out from under VS
 *    Code's own subscription teardown and break post-deactivate
 *    cleanup.
 *
 * Both properties exercise the channel-ownership boundary documented
 * in design.md → "OutputChannelSink → Channel ownership boundary".
 *
 * @see Requirements 3.1, 3.4, 3.5
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  __resetOutputChannelForTest,
  getOutputChannel,
  initOutputChannel,
} from '../../../../utils/outputChannel';
import { __resetLoggerForTest, getLogger, initLogger } from '../../../../utils/logger/logger';
import { LogLevelResolver } from '../../../../utils/logger/levels';
import { OutputChannelSink } from '../../../../utils/logger/sinks/OutputChannelSink';

/**
 * Minimal `ExtensionContext` stub. Only `subscriptions` is exercised
 * by `initOutputChannel` and `initLogger`; everything else is left
 * undefined and cast through `unknown`.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return { subscriptions } as unknown as vscode.ExtensionContext;
}

describe('logger — OutputChannel sink lifecycle (task 3.4)', () => {
  beforeEach(() => {
    // Drop both singletons so each test starts from a clean
    // module-level state. Order matters: drop the Logger first
    // (which detaches sinks) so the channel reset below does not
    // fight a sink emit racing through a disposing channel.
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetLoggerForTest();
    __resetOutputChannelForTest();
  });

  it('initLogger binds the OutputChannel sink to the cached singleton; no second channel is created', () => {
    const ctx = makeFakeContext();

    // Mimic activation order — initOutputChannel runs before
    // initLogger so the channel is registered against
    // `context.subscriptions` exactly once and cached at module level.
    initOutputChannel(ctx);
    const cachedChannel = getOutputChannel();

    // Spy on `vscode.window.createOutputChannel` so any
    // post-cache call would bump `extraChannelsCreated`. With the
    // singleton honoured, this stays at zero across the rest of the
    // test.
    let extraChannelsCreated = 0;
    type CreateOutputChannelFn = (name: string) => vscode.OutputChannel;
    const windowMutable = vscode.window as unknown as {
      createOutputChannel: CreateOutputChannelFn;
    };
    const originalCreate: CreateOutputChannelFn = windowMutable.createOutputChannel.bind(
      vscode.window
    );
    windowMutable.createOutputChannel = (name: string): vscode.OutputChannel => {
      extraChannelsCreated++;
      return originalCreate(name);
    };

    // Capture every appendLine write on the cached channel — the
    // sink must route writes through THIS exact instance.
    const writes: string[] = [];
    const originalAppendLine = cachedChannel.appendLine.bind(cachedChannel);
    cachedChannel.appendLine = function (value: string): void {
      writes.push(value);
      originalAppendLine(value);
    };

    try {
      initLogger(ctx);

      // Drive one record through the Logger so the sink resolves
      // getOutputChannel() and writes a block. The default
      // threshold is 'info', so an info record is admitted.
      getLogger().info('sink lifecycle smoke');

      assert.strictEqual(
        extraChannelsCreated,
        0,
        'initLogger must reuse the cached IntelliG channel; createOutputChannel must not be called a second time'
      );

      assert.strictEqual(
        writes.length,
        1,
        `expected exactly one appendLine on the cached channel; got ${writes.length}: ${writes.join(' | ')}`
      );

      assert.ok(
        writes[0].includes('sink lifecycle smoke'),
        `the rendered block must include the emitted message; got: ${writes[0]}`
      );
    } finally {
      windowMutable.createOutputChannel = originalCreate;
    }
  });

  it('OutputChannelSink.dispose() does not dispose the underlying channel', () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    const cachedChannel = getOutputChannel();

    // Track dispose calls on the channel. The mock's `dispose` is a
    // plain property (no-op) we can replace with a counter.
    let channelDisposeCount = 0;
    const originalDispose = cachedChannel.dispose.bind(cachedChannel);
    cachedChannel.dispose = function (): void {
      channelDisposeCount++;
      originalDispose();
    };

    // Construct a sink directly against a freshly-refreshed resolver
    // — no Logger plumbing required to assert the dispose-side
    // contract.
    const resolver = new LogLevelResolver();
    resolver.refresh();
    const sink = new OutputChannelSink(resolver);

    sink.dispose();
    assert.strictEqual(
      channelDisposeCount,
      0,
      'first sink.dispose() must NOT dispose the underlying channel — ownership stays with initOutputChannel (Requirement 3.4)'
    );

    // Idempotent: a second dispose call must still leave the channel
    // alive (per the LogSink disposal contract).
    sink.dispose();
    assert.strictEqual(
      channelDisposeCount,
      0,
      'idempotent sink.dispose() must still not dispose the underlying channel'
    );

    // The channel singleton survives — getOutputChannel() returns
    // the same cached instance, confirming initOutputChannel still
    // owns the channel after the sink has been torn down.
    assert.strictEqual(
      getOutputChannel(),
      cachedChannel,
      'channel singleton must survive sink disposal — initOutputChannel owns the lifecycle'
    );
  });

  it('disposing the initLogger-registered sink wrapper also leaves the channel alive', () => {
    // Same property as above, but exercised through the disposable
    // that `initLogger(context)` actually pushes onto
    // `context.subscriptions`. This is the path VS Code itself
    // walks when the extension deactivates, so it's the path that
    // most matters for Requirement 3.4.
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    const cachedChannel = getOutputChannel();

    let channelDisposeCount = 0;
    const originalDispose = cachedChannel.dispose.bind(cachedChannel);
    cachedChannel.dispose = function (): void {
      channelDisposeCount++;
      originalDispose();
    };

    initLogger(ctx);

    // `initOutputChannel` pushed the channel itself onto
    // `subscriptions[0]`. `initLogger` then pushed (in order):
    // the configuration listener, the OutputChannel sink wrapper,
    // and the ConsoleSink wrapper. Dispose every Logger-owned
    // subscription EXCEPT the channel registration at index 0.
    assert.ok(
      ctx.subscriptions.length >= 4,
      `expected initOutputChannel + initLogger to register at least 4 subscriptions; got ${ctx.subscriptions.length}`
    );
    const channelSubscription = ctx.subscriptions[0];
    const loggerOwnedSubscriptions = ctx.subscriptions.slice(1);

    for (const sub of loggerOwnedSubscriptions) {
      sub.dispose();
    }

    assert.strictEqual(
      channelDisposeCount,
      0,
      'disposing the Logger-owned subscriptions must not dispose the channel — Requirement 3.4'
    );

    // VS Code disposes the channel via the registration that
    // `initOutputChannel` made; firing it now hits the dispose hook
    // exactly once, confirming the channel was indeed alive up to
    // this point.
    channelSubscription.dispose();
    assert.strictEqual(
      channelDisposeCount,
      1,
      "channel disposal happens via initOutputChannel's registered subscription, not the sink wrapper"
    );
  });
});
