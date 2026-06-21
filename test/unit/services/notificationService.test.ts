/**
 * Regression test for the duplicate `IntelliG` OutputChannel bug.
 *
 * Background:
 *   `vscode.window.createOutputChannel(name)` does NOT dedupe by name — each
 *   call returns a fresh `OutputChannel` instance and adds a new entry in
 *   the Output pane dropdown. `src/utils/outputChannel.ts` works around
 *   that with a module-level singleton: `getOutputChannel()` calls
 *   `createOutputChannel` exactly once per extension lifetime.
 *
 *   Pre-fix, `NotificationService.ts:100` called
 *   `vscode.window.createOutputChannel('IntelliG')` directly instead of
 *   going through `getOutputChannel()`. That plus the safeFireAndForget
 *   route-through produced two `IntelliG` entries in Output — a real
 *   user-visible UX wart.
 *
 * This spec pins the invariant "only one `IntelliG` channel is constructed
 * across the lifetime of a NotificationService + the shared singleton."
 * It spies on `vscode.window.createOutputChannel` and asserts the name
 * `'IntelliG'` appears at most once among the spy's call names.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { NotificationService } from '../../../src/ui-shell/NotificationService';
import { __resetOutputChannelForTest, getOutputChannel } from '../../../src/utils/outputChannel';

/**
 * Install a spy on `vscode.window.createOutputChannel` that records every
 * call's `name` argument into the returned `names` array and still returns
 * a functional stub channel (delegating to the original mock). Returns a
 * `restore()` to put the real mock back.
 */
function installCreateOutputChannelSpy(): {
  names: string[];
  restore: () => void;
} {
  const names: string[] = [];
  const windowAsAny = vscode.window as unknown as {
    createOutputChannel: (name: string) => vscode.OutputChannel;
  };
  const original = windowAsAny.createOutputChannel;
  windowAsAny.createOutputChannel = (name: string): vscode.OutputChannel => {
    names.push(name);
    return original(name);
  };
  return {
    names,
    restore: () => {
      windowAsAny.createOutputChannel = original;
    },
  };
}

describe('NotificationService — IntelliG OutputChannel singleton', () => {
  beforeEach(() => {
    // Drop any cached singleton from a prior test so the spy can observe
    // the FIRST createOutputChannel call when getOutputChannel()
    // bootstraps the module-level cache.
    __resetOutputChannelForTest();
  });

  afterEach(() => {
    __resetOutputChannelForTest();
  });

  it('constructs only one "IntelliG" OutputChannel when the singleton + NotificationService coexist', () => {
    const spy = installCreateOutputChannelSpy();
    try {
      // Prime the shared singleton first. This is the order activate()
      // uses: initOutputChannel(context) happens before createNotificationService().
      const shared = getOutputChannel();
      assert.ok(shared, 'shared singleton must exist');

      // Now construct the NotificationService. Pre-fix, this call
      // internally invoked vscode.window.createOutputChannel('IntelliG')
      // a SECOND time, producing a distinct instance + a duplicate
      // dropdown entry. Post-fix, it must route through
      // getOutputChannel() and reuse `shared`.
      const ns = new NotificationService();
      void ns;

      const intelligCount = spy.names.filter((n) => n === 'IntelliG').length;
      assert.strictEqual(
        intelligCount,
        1,
        `createOutputChannel('IntelliG') must fire exactly once across getOutputChannel() + NotificationService construction; actual count=${intelligCount}, all names=${JSON.stringify(spy.names)}`
      );
    } finally {
      spy.restore();
    }
  });

  it('NotificationService._outputChannel is reference-equal to the shared singleton', () => {
    const shared = getOutputChannel();
    const ns = new NotificationService();
    // `_outputChannel` is private; reach through via a cast. This is the
    // same TestSurface-lite pattern used elsewhere in the test tree for
    // private-field identity checks.
    const nsChannel = (ns as unknown as { _outputChannel: vscode.OutputChannel })._outputChannel;
    assert.strictEqual(
      nsChannel,
      shared,
      'NotificationService must consume the shared singleton, not construct its own'
    );
  });
});
