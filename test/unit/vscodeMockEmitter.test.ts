/**
 * Unit test: the `vscode` mock's EventEmitter must match the real API's
 * registration and delivery contract, otherwise production code that relies on
 * either is untestable in the unit lane.
 *
 * Two properties are pinned:
 *  - `event(listener, thisArgs, disposables)` binds `thisArgs` and pushes the
 *    subscription's disposable into `disposables`, so owners that drain a
 *    `Disposable[]` actually unregister.
 *  - `fire()` delivers to a snapshot of the listeners and skips any listener
 *    disposed during that delivery.
 */

import '../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';

describe('vscode mock EventEmitter', () => {
  it('pushes the subscription disposable into the disposables array', () => {
    const emitter = new vscode.EventEmitter<string>();
    const disposables: vscode.Disposable[] = [];
    const seen: string[] = [];

    emitter.event((e) => seen.push(e), null, disposables);

    assert.strictEqual(disposables.length, 1, 'registration must record a disposable');

    emitter.fire('a');
    assert.deepStrictEqual(seen, ['a']);

    for (const d of disposables) {
      d.dispose();
    }

    emitter.fire('b');
    assert.deepStrictEqual(seen, ['a'], 'draining disposables must unregister the listener');
  });

  it('binds thisArgs for the listener', () => {
    const emitter = new vscode.EventEmitter<string>();
    const host = { tag: 'host', seen: [] as string[] };

    emitter.event(function (this: typeof host, e: string) {
      this.seen.push(e);
    }, host);

    emitter.fire('x');
    assert.deepStrictEqual(host.seen, ['x']);
  });

  it('skips a listener disposed by an earlier listener during the same fire', () => {
    const emitter = new vscode.EventEmitter<string>();
    const seen: string[] = [];
    const disposables: vscode.Disposable[] = [];

    emitter.event(
      () => {
        for (const d of disposables) {
          d.dispose();
        }
      },
      null,
      disposables
    );
    emitter.event(() => seen.push('second'), null, disposables);

    emitter.fire('go');

    assert.deepStrictEqual(seen, [], 'a listener disposed mid-delivery must not be called');
  });

  it('delivers to a snapshot: a listener added during fire is not called for that event', () => {
    // NOTE: this holds for a naive live-array forEach too, so it pins the API
    // contract rather than distinguishing the implementations. The self-dispose
    // case below is the one a live array actually gets wrong.
    const emitter = new vscode.EventEmitter<string>();
    const seen: string[] = [];

    emitter.event(() => {
      emitter.event(() => seen.push('late'));
    });

    emitter.fire('go');
    assert.deepStrictEqual(seen, [], 'listeners added during delivery wait for the next fire');

    emitter.fire('again');
    assert.strictEqual(seen.length, 1);
  });

  it('still delivers to later listeners when one disposes ITSELF mid-delivery', () => {
    // A live-array forEach compacts on splice and skips the next listener, so
    // 'second' would never run. This is the case that distinguishes a snapshot.
    const emitter = new vscode.EventEmitter<string>();
    const seen: string[] = [];
    const selfSub: { dispose: () => void } = emitter.event(() => {
      seen.push('first');
      selfSub.dispose();
    });
    emitter.event(() => seen.push('second'));
    emitter.event(() => seen.push('third'));

    emitter.fire('go');

    assert.deepStrictEqual(
      seen,
      ['first', 'second', 'third'],
      'a self-disposing listener must not starve the listeners after it'
    );
  });

  it('keeps delivering to siblings when a listener throws', () => {
    // The real Emitter routes a listener error to onUnexpectedError and
    // CONTINUES. Aborting delivery here would let a production bug in which one
    // bad subscriber starves the rest pass under test.
    const emitter = new vscode.EventEmitter<string>();
    const seen: string[] = [];

    emitter.event(() => {
      throw new Error('bad subscriber');
    });
    emitter.event(() => seen.push('after-throw'));

    assert.doesNotThrow(() => emitter.fire('go'), 'fire() must not propagate a listener error');
    assert.deepStrictEqual(seen, ['after-throw'], 'siblings still receive the event');
  });
});
