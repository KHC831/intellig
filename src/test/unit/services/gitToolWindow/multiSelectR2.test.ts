/**
 * Wave A R2 — fix for TL-M-2 follow-up.
 *
 * The R1 brief required the click anchor to travel WITH the
 * `rangeSelectCommit` / `addRangeSelectCommit` messages so the host
 * uses the user's actual click anchor for that single operation,
 * instead of consulting whatever `_extendedLogState.anchorHash` happens
 * to hold (which can drift mid-frame when a re-render fires between
 * the user's prior click and the current shift-click).
 *
 * R2 adds the field to the wire payload + makes the host treat it as
 * authoritative for the single message it carries (and persists it as
 * the new anchor of record so subsequent operations see the same view
 * the user just operated on).
 */

import '../../../setup';
import * as assert from 'assert';
import {
  GitToolWindowProvider,
  type IExtendedLogState,
  type WaveAInboundMessage,
} from '../../../../ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';

interface InternalsR2 {
  _extendedLogState: IExtendedLogState;
  _handleWebviewMessage(message: WaveAInboundMessage): void;
}

function mkCommit(
  hash: string,
  message = `commit ${hash}`,
  parents: string[] = []
): {
  hash: string;
  shortHash: string;
  message: string;
  author: { name: string; email: string };
  committer: { name: string; email: string };
  parents: string[];
  authorDate: Date;
  commitDate: Date;
} {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message,
    author: { name: 'a', email: 'a@x' },
    committer: { name: 'a', email: 'a@x' },
    parents,
    authorDate: new Date(0),
    commitDate: new Date(0),
  };
}

describe('Wave A R2 — TL-M-2 fix: anchorHash travels with the message', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // ─── Inbound message type ────────────────────────────────────────────────
  it('WaveAInboundMessage requires anchorHash on rangeSelectCommit (compile-time)', () => {
    // If this fails to compile, the union is missing the field.
    const m: WaveAInboundMessage = {
      type: 'rangeSelectCommit',
      commitHash: 'aaa',
      anchorHash: 'bbb',
    };
    assert.strictEqual(m.type, 'rangeSelectCommit');
    assert.strictEqual(m.anchorHash, 'bbb');
  });

  it('WaveAInboundMessage requires anchorHash on addRangeSelectCommit (compile-time)', () => {
    const m: WaveAInboundMessage = {
      type: 'addRangeSelectCommit',
      commitHash: 'aaa',
      anchorHash: null,
    };
    assert.strictEqual(m.type, 'addRangeSelectCommit');
    assert.strictEqual(m.anchorHash, null);
  });

  // ─── Behaviour: message anchor wins over host's cached anchor ────────────
  it('rangeSelectCommit message uses the message-supplied anchorHash, not the host cache', () => {
    const internals = provider as unknown as InternalsR2;
    // Display order (newest-first): ddd → ccc → bbb → aaa.
    provider.updateLogState([
      mkCommit('aaa'),
      mkCommit('bbb', 'b', ['aaa']),
      mkCommit('ccc', 'c', ['bbb']),
      mkCommit('ddd', 'd', ['ccc']),
    ]);
    // Host cache says anchor = 'aaa' (oldest, bottom row).
    provider.selectCommit('aaa');
    assert.strictEqual(internals._extendedLogState.anchorHash, 'aaa');

    // The user actually shift-clicked from 'ccc' to 'ddd' — the JS
    // mirror's `anchorHash` is 'ccc', NOT 'aaa'. The host must trust
    // the message, not its own cache.
    internals._handleWebviewMessage({
      type: 'rangeSelectCommit',
      commitHash: 'ddd',
      anchorHash: 'ccc',
    });

    // Range from ccc..ddd = [ddd, ccc] (display order).
    assert.deepStrictEqual(
      Array.from(internals._extendedLogState.selectedCommits).sort(),
      ['ccc', 'ddd'],
      'range must be computed from the message anchor (ccc), not the host cache (aaa)'
    );
    // After the operation the message anchor is the new anchor of record.
    assert.strictEqual(
      internals._extendedLogState.anchorHash,
      'ccc',
      'message anchor must be persisted as the new anchorHash after the operation'
    );
  });

  it('addRangeSelectCommit message uses the message-supplied anchorHash', () => {
    const internals = provider as unknown as InternalsR2;
    provider.updateLogState([
      mkCommit('aaa'),
      mkCommit('bbb', 'b', ['aaa']),
      mkCommit('ccc', 'c', ['bbb']),
      mkCommit('ddd', 'd', ['ccc']),
    ]);
    // Host cache disagrees with the JS-side anchor.
    provider.selectCommit('aaa');
    provider.toggleCommitSelection('bbb');
    // Host's cached anchor is now 'bbb'.

    // User shift+ctrl-clicks from anchor='ccc' (their JS view) to 'ddd'.
    internals._handleWebviewMessage({
      type: 'addRangeSelectCommit',
      commitHash: 'ddd',
      anchorHash: 'ccc',
    });

    // Existing selection {aaa, bbb} + range from ccc..ddd = {ccc, ddd}.
    assert.deepStrictEqual(
      Array.from(internals._extendedLogState.selectedCommits).sort(),
      ['aaa', 'bbb', 'ccc', 'ddd'],
      'addRangeSelectCommit must add [ccc, ddd] to existing selection using the message anchor'
    );
    assert.strictEqual(
      internals._extendedLogState.anchorHash,
      'ccc',
      'message anchor must be persisted'
    );
  });

  it('rangeSelectCommit with message anchorHash=null falls back to plain-click', () => {
    const internals = provider as unknown as InternalsR2;
    provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
    // Host cache has an anchor — but the message says null (e.g. the
    // user's first click after a refresh).
    provider.selectCommit('aaa');

    internals._handleWebviewMessage({
      type: 'rangeSelectCommit',
      commitHash: 'bbb',
      anchorHash: null,
    });

    // Plain-click semantics: selection becomes {bbb}, anchor becomes 'bbb'.
    assert.deepStrictEqual(Array.from(internals._extendedLogState.selectedCommits), ['bbb']);
    assert.strictEqual(internals._extendedLogState.anchorHash, 'bbb');
  });

  it('rangeSelectCommit with message anchorHash NOT in commitNodes falls back to plain-click', () => {
    const internals = provider as unknown as InternalsR2;
    provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
    provider.selectCommit('aaa');

    // The JS thought the anchor was 'ghost', but it's not in commitNodes
    // (e.g. virtualised out, or the JS is stale). Host must NOT use it.
    internals._handleWebviewMessage({
      type: 'rangeSelectCommit',
      commitHash: 'bbb',
      anchorHash: 'ghost',
    });

    assert.deepStrictEqual(
      Array.from(internals._extendedLogState.selectedCommits),
      ['bbb'],
      'stale message anchor must collapse to plain-click on the click hash'
    );
    assert.strictEqual(internals._extendedLogState.anchorHash, 'bbb');
  });
});
