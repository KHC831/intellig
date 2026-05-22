/**
 * Wave A R3 — consolidated review-round fixes.
 *
 * Covers the 11 R3 findings (HIGH + MEDIUM + LOW), each with a behavioural
 * or structural witness. Reviewer cross-references in the brief:
 *
 *   1. HIGH    — TL2-H-1 = Senior L-2/L-4 — post→re-render race
 *   2. MEDIUM  — Senior M-1 — selectCommits doesn't clear pending changed files
 *   3. MEDIUM  — Senior M-2 — weak runtime guard on JS-supplied anchorHash
 *   4. MEDIUM  — TL2-M-3   — IMenuItemState.reason for disabled tooltips
 *   5. MEDIUM  — TL2-M-1   — ADR-009 §3 post-ordering rule (doc, separate test)
 *   6. MEDIUM  — TL2-M-2   — ADR-009 §2.1 counter-example (doc-only)
 *   7. MEDIUM  — TL2-M-4   — ADR-009 §5 partial-vs-full (doc-only)
 *   8. LOW     — Senior L-1 — selectCommits expandedCommit fallback
 *   9. LOW     — Senior L-3 — getSelectedCommits returns display order
 *  10. LOW     — TL2-L-1   — LogContextAction superset comment (structural)
 *  11. LOW     — TL2-L-2   — typed-message FU TODO (structural)
 *
 * Doc-only items (5, 6, 7) carry a small structural assertion against
 * `docs/adr/ADR-009-webview-state-ownership.md` so the docs can't drift
 * silently.
 */

import '../../../../test/setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  GitToolWindowProvider,
  type IExtendedLogState,
  type WaveAInboundMessage,
} from '../../../../services/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import { computeMenuState } from '../../../../services/gitToolWindow/multiSelect';

interface InternalsR3 {
  _extendedLogState: IExtendedLogState;
  _handleWebviewMessage(
    message: WaveAInboundMessage | { type: string; [k: string]: unknown }
  ): void;
  _pendingChangedFiles: unknown;
  selectCommits(hashes: readonly string[], anchor?: string | null): void;
  selectIfNotSelected(hash: string): void;
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

/**
 * Stub the webview such that we can record the ORDER of `set webview.html`
 * vs `webview.postMessage` calls. The R3 HIGH fix is exactly about this
 * ordering: post must happen AFTER the html reassignment, not before.
 *
 * NOTE (R4-6, Senior L-1): This fixture pins CALL-SITE order (the host
 * calls `postMessage` AFTER assigning `webview.html`), not message
 * DELIVERY order (which document handles the message). In production,
 * VS Code's `postMessage` semantics guarantee that messages enqueued
 * after `webview.html` reassignment land on the new document — the
 * webview reload completes synchronously before subsequent posts are
 * delivered. The test asserts the host-side property; the runtime
 * delivery guarantee follows from VS Code's webview API contract.
 *
 * FU (R5-6, TL4-L-3): extract to `src/test/helpers/recordingWebview.ts`
 * when a third test file needs this fixture. Currently 2 consumers
 * (this file and `multiSelectR4.test.ts`).
 */
function recordingWebview(provider: GitToolWindowProvider): {
  events: Array<{ kind: 'html' | 'post'; type?: string }>;
} {
  const events: Array<{ kind: 'html' | 'post'; type?: string }> = [];
  let storedHtml = '';
  const webview = {
    get html(): string {
      return storedHtml;
    },
    set html(v: string) {
      storedHtml = v;
      events.push({ kind: 'html' });
    },
    postMessage: (msg: { type?: string }) => {
      events.push({ kind: 'post', type: msg.type });
      return Promise.resolve(true);
    },
    cspSource: 'test:',
    asWebviewUri: (u: vscode.Uri) => u,
  };
  (provider as unknown as { _view: unknown })._view = {
    webview,
    visible: true,
    show: () => {},
    title: 'test',
    description: '',
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
  };
  return { events };
}

describe('Wave A R3 — consolidated review fixes', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // ─── R3-1 HIGH: post→re-render race ─────────────────────────────────────
  describe('R3-1 (HIGH) — postMessage MUST happen after the most recent webview.html reassignment', () => {
    function assertPostsAfterHtml(
      events: Array<{ kind: 'html' | 'post'; type?: string }>,
      expectedPostType: string,
      operationLabel: string
    ): void {
      // Find the index of the LAST html reassignment.
      let lastHtml = -1;
      for (let i = 0; i < events.length; i++) {
        if (events[i].kind === 'html') {
          lastHtml = i;
        }
      }
      assert.ok(lastHtml >= 0, `${operationLabel}: expected at least one html reassignment`);

      // Find the matching post AFTER that html.
      const postIdx = events.findIndex(
        (e, i) => i > lastHtml && e.kind === 'post' && e.type === expectedPostType
      );
      assert.ok(
        postIdx > lastHtml,
        `${operationLabel}: expected '${expectedPostType}' post AFTER the last html reassignment, but events were: ${events
          .map((e) => e.kind + (e.type ? `(${e.type})` : ''))
          .join(' → ')}`
      );
    }

    it('toggleCommitSelection: updateMenuEnableState lands AFTER the re-render', () => {
      const { events } = recordingWebview(provider);
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      events.length = 0; // reset after updateLogState

      provider.toggleCommitSelection('aaa');

      assertPostsAfterHtml(events, 'updateMenuEnableState', 'toggleCommitSelection');
    });

    it('rangeSelectCommit: updateMenuEnableState lands AFTER the re-render', () => {
      const { events } = recordingWebview(provider);
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');
      events.length = 0;

      provider.rangeSelectCommit('ccc');

      assertPostsAfterHtml(events, 'updateMenuEnableState', 'rangeSelectCommit');
    });

    it('addRangeSelectCommit: updateMenuEnableState lands AFTER the re-render', () => {
      const { events } = recordingWebview(provider);
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');
      events.length = 0;

      provider.addRangeSelectCommit('ccc');

      assertPostsAfterHtml(events, 'updateMenuEnableState', 'addRangeSelectCommit');
    });

    it('selectCommits: updateMenuEnableState lands AFTER the re-render', () => {
      const { events } = recordingWebview(provider);
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      events.length = 0;

      const internals = provider as unknown as InternalsR3;
      internals.selectCommits(['aaa', 'bbb']);

      assertPostsAfterHtml(events, 'updateMenuEnableState', 'selectCommits');
    });

    it('selectCommits: syncSelection ALSO lands AFTER the re-render', () => {
      // The brief calls out the asymmetry — only updateLogState was posting
      // syncSelection. Now selectCommits / toggle / range / addRange must too.
      const { events } = recordingWebview(provider);
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      events.length = 0;

      const internals = provider as unknown as InternalsR3;
      internals.selectCommits(['aaa']);

      assertPostsAfterHtml(events, 'syncSelection', 'selectCommits');
    });

    it('toggleCommitSelection: posts syncSelection AFTER re-render', () => {
      const { events } = recordingWebview(provider);
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      events.length = 0;

      provider.toggleCommitSelection('aaa');

      assertPostsAfterHtml(events, 'syncSelection', 'toggleCommitSelection');
    });

    it('rangeSelectCommit: posts syncSelection AFTER re-render', () => {
      const { events } = recordingWebview(provider);
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');
      events.length = 0;

      provider.rangeSelectCommit('ccc');

      assertPostsAfterHtml(events, 'syncSelection', 'rangeSelectCommit');
    });

    it('addRangeSelectCommit: posts syncSelection AFTER re-render', () => {
      const { events } = recordingWebview(provider);
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');
      events.length = 0;

      provider.addRangeSelectCommit('ccc');

      assertPostsAfterHtml(events, 'syncSelection', 'addRangeSelectCommit');
    });
  });

  // ─── R3-2 MEDIUM: selectCommits clears pending changed files ────────────
  describe('R3-2 (MEDIUM) — selectCommits clears _pendingChangedFiles (Senior M-1)', () => {
    it('clears _pendingChangedFiles on entry', () => {
      const internals = provider as unknown as InternalsR3;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('aaa');
      // Seed a pending payload (simulates a partially-loaded commit-details fetch).
      internals._pendingChangedFiles = [{ path: 'leak.ts', status: 'modified' }];

      internals.selectCommits(['bbb']);

      assert.strictEqual(
        internals._pendingChangedFiles,
        undefined,
        'selectCommits must clear _pendingChangedFiles like selectCommit does'
      );
    });
  });

  // ─── R3-3 MEDIUM: type narrow on JS-supplied anchorHash ─────────────────
  describe('R3-3 (MEDIUM) — _handleWebviewMessage rejects non-string non-null anchorHash (Senior M-2)', () => {
    it('does not throw when anchorHash is a number (rogue webview)', () => {
      const internals = provider as unknown as InternalsR3;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('aaa');
      const before = internals._extendedLogState.anchorHash;

      // anchorHash: 42 — should NOT crash, should NOT be assigned to state.
      assert.doesNotThrow(() => {
        internals._handleWebviewMessage({
          type: 'rangeSelectCommit',
          commitHash: 'bbb',
          anchorHash: 42,
        });
      });

      // The bogus value must NOT have made it into state.
      assert.notStrictEqual(
        internals._extendedLogState.anchorHash,
        42,
        'numeric anchorHash must be rejected, not stored'
      );
      // And the state must remain a string|null (the type we declared).
      assert.ok(
        typeof internals._extendedLogState.anchorHash === 'string' ||
          internals._extendedLogState.anchorHash === null,
        `anchorHash type leaked: ${typeof internals._extendedLogState.anchorHash}`
      );
      // We expect the prior anchor to have been preserved (or replaced via
      // the plain-click fallback path); either way it must be a string|null.
      void before;
    });

    it('does not throw when anchorHash is an object', () => {
      const internals = provider as unknown as InternalsR3;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('aaa');

      assert.doesNotThrow(() => {
        internals._handleWebviewMessage({
          type: 'rangeSelectCommit',
          commitHash: 'bbb',
          anchorHash: { not: 'a string' },
        });
      });
      assert.ok(
        typeof internals._extendedLogState.anchorHash === 'string' ||
          internals._extendedLogState.anchorHash === null
      );
    });

    it('still honours legitimate string anchorHash', () => {
      const internals = provider as unknown as InternalsR3;
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');

      internals._handleWebviewMessage({
        type: 'rangeSelectCommit',
        commitHash: 'ccc',
        anchorHash: 'bbb',
      });

      assert.deepStrictEqual(Array.from(internals._extendedLogState.selectedCommits).sort(), [
        'bbb',
        'ccc',
      ]);
    });

    it('still honours legitimate null anchorHash', () => {
      const internals = provider as unknown as InternalsR3;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('aaa');

      internals._handleWebviewMessage({
        type: 'rangeSelectCommit',
        commitHash: 'bbb',
        anchorHash: null,
      });

      // Plain-click semantics on null anchor.
      assert.deepStrictEqual(Array.from(internals._extendedLogState.selectedCommits), ['bbb']);
    });
  });

  // ─── R3-4 MEDIUM: IMenuItemState.reason ─────────────────────────────────
  describe('R3-4 (MEDIUM) — IMenuItemState.reason populated for disabled actions (TL2-M-3)', () => {
    function nodes(merged = false): { hash: string; parentCount: number }[] {
      return [
        { hash: 'aaa', parentCount: 1 },
        { hash: 'bbb', parentCount: 1 },
        { hash: 'ccc', parentCount: merged ? 2 : 1 },
        { hash: 'ddd', parentCount: 1 },
      ];
    }

    it('squashCommits has no reason when enabled', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc']),
        commitNodes: nodes(),
        headHash: 'aaa',
      });
      assert.strictEqual(state.squashCommits.enabled, true);
      assert.strictEqual(
        state.squashCommits.reason,
        undefined,
        'reason must be omitted when the action is enabled'
      );
    });

    it('squashCommits.reason at N=1 is undefined (hidden — R4-2 contract narrowing)', () => {
      // Pre-R4 this populated reason="Squash needs at least 2 commits";
      // R4-2 narrowed the gate to `visible && !enabled`, and squashCommits
      // is hidden at N=1 (visibility flag), so reason is now undefined.
      // The N>=2 requirement is conveyed by the row simply not rendering.
      const state = computeMenuState({
        selectedHashes: new Set(['bbb']),
        commitNodes: nodes(),
        headHash: 'aaa',
      });
      assert.strictEqual(state.squashCommits.visible, false);
      assert.strictEqual(state.squashCommits.enabled, false);
      assert.strictEqual(
        state.squashCommits.reason,
        undefined,
        'hidden actions must not carry a tooltip-able reason (R4-2)'
      );
    });

    it('squashCommits.reason mentions "contiguous" when there is a gap', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ddd']), // gap at ccc
        commitNodes: nodes(),
        headHash: 'aaa',
      });
      assert.strictEqual(state.squashCommits.enabled, false);
      assert.ok(
        state.squashCommits.reason &&
          /contiguous|consecutive|adjacent|gap/i.test(state.squashCommits.reason),
        `expected reason to mention contiguity; got: ${JSON.stringify(state.squashCommits.reason)}`
      );
    });

    it('squashCommits.reason mentions "merge" when a merge commit is in the selection', () => {
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc', 'ddd']),
        commitNodes: nodes(/* merged */ true),
        headHash: 'aaa',
      });
      assert.strictEqual(state.squashCommits.enabled, false);
      assert.ok(
        state.squashCommits.reason && /merge/i.test(state.squashCommits.reason),
        `expected reason to mention merge commit; got: ${JSON.stringify(state.squashCommits.reason)}`
      );
    });

    it('compareVersions.reason is undefined when N!=2 (hidden — R4-2 contract narrowing)', () => {
      // Pre-R4 this populated reason="Compare Versions needs exactly 2";
      // R4-2 narrowed the gate to `visible && !enabled`, and
      // compareVersions is hidden whenever it's disabled (visibility
      // and enable rules both `=== 2`), so the reason is never set in
      // practice. The exactly-2 requirement is conveyed by the row not
      // rendering.
      const state = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc', 'ddd']),
        commitNodes: nodes(),
        headHash: 'aaa',
      });
      assert.strictEqual(state.compareVersions.visible, false);
      assert.strictEqual(state.compareVersions.enabled, false);
      assert.strictEqual(
        state.compareVersions.reason,
        undefined,
        'compareVersions has no visible-disabled state, so reason is never populated (R4-2)'
      );
    });
  });

  // ─── R3-5/6/7 MEDIUM: ADR-009 doc sections ──────────────────────────────
  describe('R3-5/6/7 (MEDIUM) — ADR-009 sections updated', () => {
    let adr: string;
    before(async () => {
      const fs = await import('fs');
      const path = await import('path');
      adr = fs.readFileSync(
        path.join(process.cwd(), 'docs/adr/ADR-009-webview-state-ownership.md'),
        'utf8'
      );
    });

    it('R3-5 (TL2-M-1) — §3 includes a post-must-follow-html-reassignment rule', () => {
      // Look for explicit language about ordering relative to webview.html.
      const hit =
        /webview\.html[\s\S]{0,200}post|post[\s\S]{0,200}webview\.html|after\s+(?:the\s+)?(?:re-?render|html\s*reassignment|html\s*reload)/i.test(
          adr
        );
      assert.ok(
        hit,
        'ADR-009 §3 must include a sub-rule that posts follow webview.html reassignment'
      );
    });

    it('R3-6 (TL2-M-2) — §2.1 includes a counter-example', () => {
      assert.ok(
        /counter[- ]example/i.test(adr),
        'ADR-009 §2.1 must include a counter-example so the click-anchor exception is not over-extended'
      );
      assert.ok(
        /isSquashEnabled|rule\s+derivation/i.test(adr),
        'counter-example must specifically call out rule derivations as off-limits'
      );
    });

    it('R3-7 (TL2-M-4) — new section documents partial-vs-full update flavors', () => {
      assert.ok(
        /partial[\s\S]{0,200}full|full[\s\S]{0,200}partial/i.test(adr),
        'ADR-009 must contrast partial postMessage vs full _updateWebview() update flavors'
      );
      assert.ok(
        /scroll position|hot path|single-(?:select|click)/i.test(adr),
        'partial-vs-full section should explain the rationale (hot path / scroll preservation)'
      );
    });
  });

  // ─── R3-8 LOW: selectCommits expandedCommit fallback ────────────────────
  describe('R3-8 (LOW) — selectCommits sets expandedCommit to first surviving hash for N>=2 (Senior L-1)', () => {
    it('selectCommits([h1, h2]) sets expandedCommit = h1 (first in the new selection)', () => {
      const internals = provider as unknown as InternalsR3;
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');
      assert.strictEqual(internals._extendedLogState.expandedCommit, 'aaa');

      internals.selectCommits(['bbb', 'ccc']);

      assert.strictEqual(
        internals._extendedLogState.expandedCommit,
        'bbb',
        'expandedCommit must move to the first surviving selection hash for N>=2'
      );
    });

    it('selectCommits([]) leaves expandedCommit unchanged or clears it (whichever the impl chose)', () => {
      const internals = provider as unknown as InternalsR3;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('aaa');

      internals.selectCommits([]);

      // Either undefined (cleared) or 'aaa' (preserved) is acceptable; the
      // R3 spec only requires the N>=2 case to behave. We assert it stays
      // a string|undefined for type safety.
      const v = internals._extendedLogState.expandedCommit;
      assert.ok(v === undefined || typeof v === 'string');
    });
  });

  // ─── R3-9 LOW: getSelectedCommits display order ─────────────────────────
  describe('R3-9 (LOW) — getSelectedCommits returns display order (Senior L-3)', () => {
    it('returns hashes in commitNodes display order, not Set insertion order', () => {
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
        mkCommit('ddd', 'd', ['ccc']),
      ]);
      // Display order is newest-first: ddd → ccc → bbb → aaa.
      // Toggle in mixed order:
      provider.toggleCommitSelection('aaa');
      provider.toggleCommitSelection('ccc');
      provider.toggleCommitSelection('bbb');

      const got = provider.getSelectedCommits();
      assert.deepStrictEqual(
        got,
        ['ccc', 'bbb', 'aaa'],
        'getSelectedCommits should reflect display order (newest-first), not Set iteration order'
      );
    });

    it('returns [] for empty selection', () => {
      provider.updateLogState([mkCommit('aaa')]);
      assert.deepStrictEqual(provider.getSelectedCommits(), []);
    });
  });

  // ─── R3-10 LOW: LogContextAction structural comment ─────────────────────
  describe('R3-10 (LOW) — LogContextAction declares its superset relationship (TL2-L-1)', () => {
    it('GitToolWindowProvider.ts contains a "superset" comment on the LogContextAction declaration', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/services/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const idx = src.indexOf('export type LogContextAction');
      assert.ok(idx > 0, 'LogContextAction declaration not found');
      // Look for the comment in the 1000 chars before the type declaration.
      // (The doc comment is multi-paragraph and runs ~600 chars on its own.)
      const window = src.substring(Math.max(0, idx - 1000), idx);
      assert.ok(
        /superset[\s\S]{0,400}MultiSelectMenuAction|MultiSelectMenuAction[\s\S]{0,400}superset/i.test(
          window
        ),
        'LogContextAction declaration must carry a comment naming its superset relationship to MultiSelectMenuAction'
      );
    });
  });

  // ─── R3-11 LOW: typed-message FU TODO ───────────────────────────────────
  describe('R3-11 (LOW) — post-Wave-C TODO for unified WebviewInboundMessage (TL2-L-2)', () => {
    it('GitToolWindowProvider.ts contains a TODO near WaveAInboundMessage referencing the unification plan', async () => {
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/services/gitToolWindow/GitToolWindowProvider.ts'),
        'utf8'
      );
      const idx = src.indexOf('export type WaveAInboundMessage');
      assert.ok(idx > 0, 'WaveAInboundMessage declaration not found');
      // 800-char window covers preceding doc-comment.
      const window = src.substring(Math.max(0, idx - 800), idx + 200);
      assert.ok(
        /TODO\(?post-?[Ww]ave-?C\)?[\s\S]{0,400}WebviewInboundMessage/i.test(window),
        'expected TODO(post-Wave-C) comment naming WebviewInboundMessage as the future single union'
      );
    });
  });
});
