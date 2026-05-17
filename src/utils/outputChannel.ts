/**
 * Shared extension OutputChannel.
 *
 * The extension's init/watcher/state-sync paths use `safeFireAndForget` to
 * log rejections without forcing every call site into an async shape. Those
 * logs previously only went to `console.error`, which is invisible to a user
 * running the shipped extension (no devtools, no reload-to-extension-host
 * console). This singleton exposes a user-visible `IntelliG` Output channel
 * that init/watcher/refresh failures can `appendLine` to, so a field bug
 * report can be triaged from `Output → IntelliG` instead of requiring the
 * user to reproduce under an extension-development host.
 *
 * ### Why a shared module (not NotificationService accessor)?
 *
 * `NotificationService` is a service with injection concerns — GitService's
 * watcher and ConflictResolutionService's state-sync fire during
 * initialization, before the full service graph is guaranteed to be wired.
 * Making every init path reach into NotificationService to grab the channel
 * would (a) widen the coupling surface and (b) risk ordering bugs where a
 * watcher fires before `ExtensionServices.activate` finishes constructing
 * the notification service. A lazy module-level singleton dodges both.
 *
 * The underlying `vscode.window.createOutputChannel` is safe to call at any
 * point in the extension lifetime, BUT it does NOT dedupe by name — every
 * call returns a fresh `OutputChannel` instance, and two calls with the
 * same name produce two entries in the `Output` pane dropdown. What keeps
 * this module's channel singleton-safe is the module-level `_channel`
 * cache: `getOutputChannel()` only calls `createOutputChannel` on first
 * access; every subsequent caller gets the cached instance.
 *
 * ### Disposal
 *
 * The channel is registered against the extension context once, on first
 * access via `initOutputChannel(context)`. Subsequent calls return the same
 * instance. Calling `__resetOutputChannelForTest()` (test-only) drops the
 * cache so the next `getOutputChannel()` creates a fresh channel — useful
 * for tests that need a clean slate.
 */

import * as vscode from 'vscode';

const CHANNEL_NAME = 'IntelliG';

let _channel: vscode.OutputChannel | undefined;
/**
 * Tracks whether the channel has been pushed onto a host
 * `ExtensionContext.subscriptions` array. Module-level flag so
 * `initOutputChannel` can early-return on subsequent calls without
 * scanning the (potentially 50+ entry) subscriptions list with
 * `Array.prototype.includes`.
 *
 * Reset to `false` by `__resetOutputChannelForTest()` so each test
 * starts from a clean slate.
 */
let _channelRegistered = false;

/**
 * Lazily create (or return) the shared `IntelliG` OutputChannel.
 *
 * Safe to call from any init/watcher/state-sync path. Subsequent calls
 * return the same instance.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel(CHANNEL_NAME);
  }
  return _channel;
}

/**
 * Register the channel with the extension's disposable registry so it
 * disposes on deactivate. Idempotent — repeated calls early-return via
 * the module-level `_channelRegistered` flag rather than scanning
 * `context.subscriptions` with `Array.prototype.includes` (which would
 * be O(n) over the full activation subscription list, typically 50+
 * entries).
 *
 * The flag is reset to `false` by `__resetOutputChannelForTest()` so a
 * test that drops the singleton can re-register against a fresh
 * `ExtensionContext` stub.
 */
export function initOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
  const channel = getOutputChannel();
  if (!_channelRegistered) {
    context.subscriptions.push(channel);
    _channelRegistered = true;
  }
  return channel;
}

/**
 * Test-only seam. Resets the module-level singleton so tests can re-init
 * (drop the cached channel; the next `getOutputChannel()` will create a
 * fresh one). Production code MUST NOT call this.
 *
 * Naming follows the TestSurface function-name prefix variant for
 * module-scope test-only exports (see `docs/testing.md` §3, subsection
 * "Function-name prefix variant for module-scope test-only exports").
 * The literal name is also enforced by the structural CI guard
 * `scripts/check-output-channel-test-surface.sh`, which forbids any
 * reference outside `src/test/**`.
 *
 * @internal
 */
export function __resetOutputChannelForTest(): void {
  if (_channel) {
    _channel.dispose();
    _channel = undefined;
  }
  // Also reset the registration flag so `initOutputChannel(ctx)` will
  // push onto a fresh context's `subscriptions` after the reset.
  _channelRegistered = false;
}
