/**
 * `initOutputChannel` registration idempotence via a module-level flag
 * instead of `context.subscriptions.includes()`.
 *
 * A module-level `_channelRegistered` boolean flag short-circuits repeat
 * calls: the first call registers (push + flag flip) and every subsequent
 * call early-returns without scanning `context.subscriptions` (which can be
 * 50+ items in a real activation, making an `Array.includes()` guard O(n)).
 *
 * The TestSurface seam `__resetOutputChannelForTest()` also
 * resets the flag so each test gets a clean slate.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { initOutputChannel, __resetOutputChannelForTest } from '../../../src/utils/outputChannel';

/**
 * Minimal `ExtensionContext` stub. Only `subscriptions` is exercised by
 * `initOutputChannel`; the rest of the surface is left undefined and
 * cast through `unknown`.
 */
function makeFakeContext(): vscode.ExtensionContext {
  const subscriptions: { dispose(): void }[] = [];
  return {
    subscriptions,
  } as unknown as vscode.ExtensionContext;
}

describe('outputChannel — initOutputChannel idempotence (TL-66)', () => {
  beforeEach(() => {
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetOutputChannelForTest();
  });

  it('first init pushes exactly one disposable into context.subscriptions', () => {
    const ctx = makeFakeContext();
    assert.strictEqual(ctx.subscriptions.length, 0, 'precondition: empty subscriptions');

    initOutputChannel(ctx);

    assert.strictEqual(
      ctx.subscriptions.length,
      1,
      'first init must register the channel exactly once'
    );
  });

  it('second init on the SAME context is a no-op (no second push)', () => {
    const ctx = makeFakeContext();
    initOutputChannel(ctx);
    assert.strictEqual(ctx.subscriptions.length, 1);

    initOutputChannel(ctx);

    assert.strictEqual(
      ctx.subscriptions.length,
      1,
      'second init on the same context must not push again — flag-guard short-circuits'
    );
  });

  it('after __resetOutputChannelForTest, the flag clears and a fresh context can re-register', () => {
    const ctxA = makeFakeContext();
    initOutputChannel(ctxA);
    assert.strictEqual(ctxA.subscriptions.length, 1);

    // Drop the singleton + flag, mimicking a test re-init.
    __resetOutputChannelForTest();

    const ctxB = makeFakeContext();
    initOutputChannel(ctxB);

    assert.strictEqual(
      ctxB.subscriptions.length,
      1,
      'after reset, a fresh context must register again — flag must reset to false'
    );
    // The original context was not touched — its registration is stale
    // but unchanged.
    assert.strictEqual(ctxA.subscriptions.length, 1, 'reset must not mutate prior contexts');
  });
});
