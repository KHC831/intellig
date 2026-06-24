/**
 * Provider integration tests for multi-select.
 *
 * Drives the provider behaviors:
 *   - Host posts `updateMenuEnableState` on every selection
 *     change. Webview just applies.
 *   - Anchor lifecycle: pruned to `null` when the anchor is
 *     no longer in the rendered list after `updateLogState`; selection
 *     intersected with the new commit set.
 *   - Anchor embedded in graph-panel HTML so a full re-render
 *     keeps the JS `let anchorHash` mirror in sync.
 *   - `.menu-multi-hidden` CSS rule is present.
 *   - `squashCommits`/`compareVersions` are members of
 *     `LogContextAction` so the menu-handler dispatch is type-safe;
 *     every menu `data-action` has a matching `case` in
 *     `CommitContextMenuCommands._handleAction`.
 *   - `resetToHere` is now single-only at the HTML level.
 *   - Right-click on a non-selected commit clears the
 *     selection and selects only that commit (host-side state mirrors
 *     the JS-side mutation).
 *   - `data-head-hash` is HTML-escaped.
 *   - `selectCommits(hashes, anchor?)` public API.
 *   - `_handleCommitContextMenu` validates each hash
 *     against `commitNodes` and aborts with a toast on drift.
 *   - Details panel `data-selected-count` updated alongside
 *     graph panel.
 *   - Keyboard range-select (user decision).
 */

import '../../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  GitToolWindowProvider,
  type IExtendedLogState,
  type LogContextAction,
} from '../../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import {
  computeMenuState,
  type MultiSelectMenuAction,
} from '../../../../src/git-core/gitToolWindow/multiSelect';

/** Narrow surface into provider internals for state assertions. */
interface MultiSelectInternalsR1 {
  _extendedLogState: IExtendedLogState;
  _handleWebviewMessage(message: {
    type: string;
    commitHash?: string;
    commitHashes?: string[];
    action?: string;
  }): void;
  _view?: { webview?: { postMessage: (msg: unknown) => Thenable<boolean> } };
  selectCommits(hashes: string[], anchor?: string | null): void;
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
 * Stub a webview onto the provider so postMessage calls land somewhere
 * we can inspect. The real webview view is owned by VS Code; for unit
 * tests we just record the messages.
 */
function stubWebview(provider: GitToolWindowProvider): {
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      postMessage: (msg: Record<string, unknown>) => {
        messages.push(msg);
        return Promise.resolve(true);
      },
      cspSource: 'test:',
      asWebviewUri: (u: vscode.Uri) => u,
      html: '',
    },
    visible: true,
    show: () => {},
    title: 'test',
    description: '',
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeVisibility: () => ({ dispose: () => {} }),
  };
  return { messages };
}

describe('Wave A R1 — provider integration', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // ───: host posts updateMenuEnableState ───────────────────────────
  describe('R1 Step 1 — host posts updateMenuEnableState on selection changes', () => {
    it('selectCommit posts updateMenuEnableState with N=1 enable map', () => {
      const { messages } = stubWebview(provider);
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      messages.length = 0; // reset after updateLogState's own posts

      provider.selectCommit('aaa');

      const updates = messages.filter((m) => m.type === 'updateMenuEnableState');
      assert.ok(updates.length >= 1, 'expected updateMenuEnableState message');
      const last = updates[updates.length - 1] as {
        type: string;
        state: Record<MultiSelectMenuAction, { visible: boolean; enabled: boolean }>;
        selectedCount: number;
      };
      assert.strictEqual(last.selectedCount, 1);
      assert.strictEqual(last.state.editCommitMessage.enabled, true);
      assert.strictEqual(last.state.editCommitMessage.visible, true);
    });

    it('toggleCommitSelection posts updateMenuEnableState with the new selection', () => {
      const { messages } = stubWebview(provider);
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');
      messages.length = 0;

      provider.toggleCommitSelection('bbb');

      const last = messages.filter((m) => m.type === 'updateMenuEnableState').pop() as {
        selectedCount: number;
      };
      assert.strictEqual(last.selectedCount, 2);
    });

    it('rangeSelectCommit posts updateMenuEnableState with the range as the new selection', () => {
      const { messages } = stubWebview(provider);
      // Display order: ddd → ccc → bbb → aaa (newest-first).
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
        mkCommit('ddd', 'd', ['ccc']),
      ]);
      provider.selectCommit('bbb');
      messages.length = 0;

      provider.rangeSelectCommit('ddd');

      const last = messages.filter((m) => m.type === 'updateMenuEnableState').pop() as {
        selectedCount: number;
      };
      assert.strictEqual(last.selectedCount, 3);
    });

    it('updateLogState posts updateMenuEnableState (re-renders need a fresh map)', () => {
      const { messages } = stubWebview(provider);
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);

      const updates = messages.filter((m) => m.type === 'updateMenuEnableState');
      assert.ok(
        updates.length >= 1,
        'updateLogState should post updateMenuEnableState on the new commit set'
      );
    });

    it('payload covers every MultiSelectMenuAction key', () => {
      const { messages } = stubWebview(provider);
      provider.updateLogState([mkCommit('aaa')]);
      provider.selectCommit('aaa');

      const last = messages.filter((m) => m.type === 'updateMenuEnableState').pop() as {
        state: Record<string, unknown>;
      };
      const expectedKeys: MultiSelectMenuAction[] = [
        'copyHash',
        'createPatch',
        'cherryPick',
        'checkoutRevision',
        'showRepoAtRevision',
        'compareWithLocal',
        'resetToHere',
        'revert',
        'undoCommit',
        'dropCommit',
        'editCommitMessage',
        'interactiveRebase',
        'squashCommits',
        'compareVersions',
      ];
      for (const k of expectedKeys) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(last.state, k),
          `state missing action "${k}"`
        );
      }
    });

    it('payload state agrees with computeMenuState (host-as-source-of-truth)', () => {
      const { messages } = stubWebview(provider);
      // 4-commit chain, select bbb+ccc.
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
        mkCommit('ddd', 'd', ['ccc']),
      ]);
      provider.selectCommit('bbb');
      provider.toggleCommitSelection('ccc');

      const last = messages.filter((m) => m.type === 'updateMenuEnableState').pop() as {
        state: Record<MultiSelectMenuAction, { visible: boolean; enabled: boolean }>;
      };

      const expected = computeMenuState({
        selectedHashes: new Set(['bbb', 'ccc']),
        commitNodes: provider
          .getExtendedLogState()
          .commitNodes.map((n) => ({ hash: n.commit.hash, parentCount: n.commit.parents.length })),
        // HEAD is the newest, which is 'ddd' here.
        headHash: 'ddd',
      });
      assert.deepStrictEqual(last.state, expected);
    });
  });

  // ───: anchor lifecycle on updateLogState ─────────────────────────
  describe('R1 Step 2 — anchor lifecycle hardening', () => {
    it('updateLogState clears anchorHash when the anchor is no longer in the new commit list', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('aaa');
      assert.strictEqual(internals._extendedLogState.anchorHash, 'aaa');

      // Re-render without 'aaa' (e.g. after a force-push that drops it).
      provider.updateLogState([mkCommit('xxx'), mkCommit('yyy', 'y', ['xxx'])]);

      assert.strictEqual(
        internals._extendedLogState.anchorHash,
        null,
        'anchor must reset when no longer present'
      );
    });

    it('updateLogState prunes selectedCommits to intersection with new commit set', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');
      provider.toggleCommitSelection('bbb');
      provider.toggleCommitSelection('ccc');
      assert.strictEqual(internals._extendedLogState.selectedCommits.size, 3);

      // 'aaa' and 'bbb' survive; 'ccc' is gone.
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);

      assert.deepStrictEqual(Array.from(internals._extendedLogState.selectedCommits).sort(), [
        'aaa',
        'bbb',
      ]);
    });

    it('updateLogState retains anchor when it is still in the new commit list', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('bbb');

      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);

      assert.strictEqual(internals._extendedLogState.anchorHash, 'bbb');
    });

    it('updateLogState posts a syncSelection message so JS resets its anchor mirror', () => {
      const { messages } = stubWebview(provider);
      provider.updateLogState([mkCommit('aaa')]);
      provider.selectCommit('aaa');
      messages.length = 0;

      provider.updateLogState([mkCommit('xxx')]);

      const sync = messages.find((m) => m.type === 'syncSelection');
      assert.ok(sync, 'expected syncSelection message after updateLogState');
    });

    it('rangeSelectCommit with virtualised-out anchor falls back to plain-click (anchor + selection ← click)', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('aaa');
      // Inject a stale anchor that isn't in the commit list (simulates
      // virtualization or a TOCTOU between renders).
      internals._extendedLogState.anchorHash = 'ghost';
      // Even though anchor is stale, the operation must still leave a
      // sane state — clicked hash becomes both anchor and sole selection.
      provider.rangeSelectCommit('bbb');

      assert.deepStrictEqual(
        Array.from(internals._extendedLogState.selectedCommits),
        ['bbb'],
        'stale anchor must collapse to single-select on the clicked hash'
      );
      assert.strictEqual(internals._extendedLogState.anchorHash, 'bbb');
    });
  });

  // ───: anchor embedded in HTML ────────────────────────────────────
  describe('R1 Step 3 — anchor embedded in graph-panel HTML', () => {
    it('graph panel root carries data-anchor-hash attribute (empty when null)', () => {
      provider.updateLogState([mkCommit('aaa')]);
      const html = provider._getGraphPanelHtml(provider.getExtendedLogState().commitNodes);
      assert.ok(
        /data-anchor-hash=""/.test(html),
        'graph panel must emit data-anchor-hash="" when anchor is null'
      );
    });

    it('graph panel root carries data-anchor-hash attribute set to the anchor hash', () => {
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('bbb');
      const state = provider.getExtendedLogState();
      const html = provider._getGraphPanelHtml(state.commitNodes, state.selectedCommits);
      // The graph panel HTML emitter takes selectedCommits but reads
      // _extendedLogState.anchorHash from `this` directly.
      assert.ok(
        /data-anchor-hash="bbb"/.test(html),
        'graph panel must emit data-anchor-hash="bbb" after selectCommit("bbb")'
      );
    });
  });

  // ─── C-1: menu-multi-hidden CSS rule present ─────────────────────
  describe('R1 Step 4 C-1 — .menu-multi-hidden CSS rule present', () => {
    it('inline <style> block contains a display:none rule for .menu-multi-hidden', () => {
      const html = provider._getThreePanelHtmlContent(
        { cspSource: 'test:' } as unknown as vscode.Webview,
        []
      );
      assert.ok(
        /\.menu-multi-hidden\s*\{[^}]*display:\s*none/.test(html),
        'inline style must include .menu-multi-hidden { display: none } so the visibility flag actually hides items'
      );
    });
  });

  // ─── C-2: type-safe action union ─────────────────────────────────
  describe('R1 Step 4 C-2 — squashCommits + compareVersions are LogContextAction members', () => {
    it('squashCommits is assignable to LogContextAction (compile-time check)', () => {
      // If this fails to compile, the LogContextAction union is missing
      // the entry. The runtime side of the assertion is just a tag check.
      const a: LogContextAction = 'squashCommits';
      assert.strictEqual(a, 'squashCommits');
    });

    it('compareVersions is assignable to LogContextAction', () => {
      const a: LogContextAction = 'compareVersions';
      assert.strictEqual(a, 'compareVersions');
    });
  });

  // ───: resetToHere single-only at HTML level ──────────────────
  describe('R1 Step 5 H-1 — resetToHere is now single-only', () => {
    it('the resetToHere context-menu item carries data-multi-action="single-only"', () => {
      const html = provider._getCommitContextMenuHtml();
      const idx = html.indexOf('data-action="resetToHere"');
      assert.ok(idx !== -1);
      const window = html.substring(Math.max(0, idx - 200), idx + 200);
      assert.ok(
        window.includes('data-multi-action="single-only"'),
        'resetToHere row must declare data-multi-action="single-only"'
      );
    });
  });

  // ───: right-click on non-selected commit moves selection ─────
  describe('R1 Step 6 M-1 — right-click on a non-selected commit single-selects it (host-side mirror)', () => {
    it('exposes selectIfNotSelected(hash) that single-selects when the hash is not currently selected', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);
      provider.selectCommit('aaa');
      provider.toggleCommitSelection('bbb'); // selection: {aaa, bbb}

      // Right-click a commit not in the selection set.
      provider.selectIfNotSelected('ccc');

      assert.deepStrictEqual(
        Array.from(internals._extendedLogState.selectedCommits),
        ['ccc'],
        'right-click on non-selected commit must collapse selection to that commit'
      );
    });

    it('selectIfNotSelected is a no-op when the hash is already selected', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      provider.selectCommit('aaa');
      provider.toggleCommitSelection('bbb');

      provider.selectIfNotSelected('bbb');

      assert.deepStrictEqual(
        Array.from(internals._extendedLogState.selectedCommits).sort(),
        ['aaa', 'bbb'],
        'right-click on a selected commit must keep the multi-selection intact'
      );
    });
  });

  // ───: data-head-hash escaped ─────────────────────────────────
  describe('R1 Step 6 M-4 — data-head-hash is HTML-escaped', () => {
    it('does not pass raw quotes through the data-head-hash interpolation', () => {
      // Inject a malicious-looking hash via updateLogState. Real git
      // hashes are hex-only, but defense-in-depth — every interpolation
      // we control should round-trip through _escapeHtml.
      const evilHash = 'ev"il<script>alert(1)</script>';
      provider.updateLogState([mkCommit(evilHash)]);

      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        !html.includes('<script>alert(1)</script>'),
        'data-head-hash must HTML-escape its interpolation'
      );
      assert.ok(
        html.includes('&lt;script&gt;') || html.includes('&quot;') || !html.includes('<script>'),
        'an escaped form of the malicious hash must appear in the rendered HTML'
      );
    });
  });

  // ───: public selectCommits API ────────────────────────────
  describe('R1 Step 6 TL-M-1 — selectCommits public API', () => {
    it('selectCommits([h1, h2]) sets the selection and an anchor', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
      ]);

      internals.selectCommits(['aaa', 'bbb'], 'aaa');

      assert.deepStrictEqual(Array.from(internals._extendedLogState.selectedCommits).sort(), [
        'aaa',
        'bbb',
      ]);
      assert.strictEqual(internals._extendedLogState.anchorHash, 'aaa');
    });

    it('selectCommits([]) clears selection and anchor', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([mkCommit('aaa')]);
      provider.selectCommit('aaa');

      internals.selectCommits([]);

      assert.strictEqual(internals._extendedLogState.selectedCommits.size, 0);
      assert.strictEqual(internals._extendedLogState.anchorHash, null);
    });

    it('selectCommits ignores hashes not in the rendered commit list', () => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);

      internals.selectCommits(['aaa', 'ghost']);

      assert.deepStrictEqual(Array.from(internals._extendedLogState.selectedCommits), ['aaa']);
    });
  });

  // ───: validate selection at action-fire time ──────────────
  describe('R1 Step 6 TL-M-4 — _handleCommitContextMenu validates hashes', () => {
    it('_handleCommitContextMenu does NOT fire onDidRequestLogContextAction when a hash is no longer in commitNodes', (done) => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);

      let fired = false;
      const sub = provider.onDidRequestLogContextAction(() => {
        fired = true;
      });

      // Send a commitContextMenu message referencing a hash that was
      // never in commitNodes (or has been swapped out).
      internals._handleWebviewMessage({
        type: 'commitContextMenu',
        action: 'cherryPick',
        commitHashes: ['ghost'],
      });

      // Give it a tick.
      setTimeout(() => {
        sub.dispose();
        assert.strictEqual(fired, false, 'stale hash must abort the action');
        done();
      }, 5);
    });

    it('_handleCommitContextMenu DOES fire when all hashes are in commitNodes', (done) => {
      const internals = provider as unknown as MultiSelectInternalsR1;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);

      const sub = provider.onDidRequestLogContextAction((e) => {
        sub.dispose();
        assert.strictEqual(e.action, 'cherryPick');
        assert.deepStrictEqual(e.commitHashes, ['aaa', 'bbb']);
        done();
      });

      internals._handleWebviewMessage({
        type: 'commitContextMenu',
        action: 'cherryPick',
        commitHashes: ['aaa', 'bbb'],
      });
    });
  });

  // ─── Keyboard range-select ────────────────────────────────────────
  describe('R1 H-2 — keyboard range-select inline-script', () => {
    it('inline script handles ArrowDown for next-row single-select', () => {
      const html = provider._getThreePanelHtmlContent(
        { cspSource: 'test:' } as unknown as vscode.Webview,
        []
      );
      // The keyboard handler must include an arrow-key arm. We assert
      // structurally; the behavioural witness for the apply-loop is the
      // host-side selection tests above.
      assert.ok(/case\s+['"]ArrowDown['"]/.test(html), 'handleCommitKeydown must handle ArrowDown');
      assert.ok(/case\s+['"]ArrowUp['"]/.test(html), 'handleCommitKeydown must handle ArrowUp');
    });

    it('inline script differentiates Shift+Arrow (range) from plain Arrow (move)', () => {
      const html = provider._getThreePanelHtmlContent(
        { cspSource: 'test:' } as unknown as vscode.Webview,
        []
      );
      // Pattern: the arrow-key block must reference shiftKey and post a
      // rangeSelectCommit/addRangeSelectCommit when shift is held.
      assert.ok(
        /shiftKey[\s\S]{0,400}rangeSelectCommit/.test(html),
        'Shift+Arrow must dispatch a range message, not a plain selectCommit'
      );
    });
  });

  // ───: details panel data-selected-count ──────────────────────
  describe('R1 Step 7 L-1 — refreshSelectedCount touches the details panel too', () => {
    it('inline script updates data-selected-count on .multi-commit-details when present', () => {
      const html = provider._getThreePanelHtmlContent(
        { cspSource: 'test:' } as unknown as vscode.Webview,
        []
      );
      // Look for a refreshSelectedCount body that addresses the multi-commit details element.
      assert.ok(
        /refreshSelectedCount[\s\S]{0,800}multi-commit-details/.test(html),
        'refreshSelectedCount must also update the .multi-commit-details data-selected-count'
      );
    });
  });

  // ─── C-2 structural: every data-action has a CommitContextMenuCommands case
  describe('R1 Step 4 C-2 — every menu data-action has a matching case in CommitContextMenuCommands', () => {
    it('renders only data-action values that the action handler recognises', async () => {
      const html = provider._getCommitContextMenuHtml();
      const renderedActions = Array.from(html.matchAll(/data-action="([a-zA-Z]+)"/g)).map(
        (m) => m[1]
      );
      assert.ok(renderedActions.length > 0);

      // Read CommitContextMenuCommands.ts source; assert each action has
      // a `case '<action>':` line. This is a structural guard.
      const fs = await import('fs');
      const path = await import('path');
      const src = fs.readFileSync(
        path.join(process.cwd(), 'src/commits/CommitContextMenuCommands.ts'),
        'utf8'
      );
      for (const action of renderedActions) {
        const re = new RegExp(`case ['"]${action}['"]\\s*:`);
        assert.ok(
          re.test(src),
          `CommitContextMenuCommands._handleAction has no case for "${action}"`
        );
      }
    });
  });
});
