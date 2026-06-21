/**
 * provider-level multi-select integration tests.
 *
 * Pure helpers are tested in `multiSelect.test.ts`; this file drives
 * `GitToolWindowProvider` directly to verify:
 *   - A0 — the inline-script disable/enable wiring no longer hard-disables
 *          editCommitMessage (line 3650 regression).
 *   - A1 — `_extendedLogState.anchorHash` is tracked on plain-click,
 *          ctrl-click, and shift-click via `_handleWebviewMessage`.
 *   - A2 — context-menu HTML now includes `squashCommits` +
 *          `compareVersions` items with `.menu-multi-hidden` class so
 *          they default to hidden.
 *   - A4 — single-commit details panel header includes
 *          `data-selected-count="1"`, the graph-panel root has
 *          `aria-multiselectable="true"` + `data-selected-count`.
 *
 * The inline-script DOM mutation logic (which row gets `.selected`, which
 * menu items get `.disabled`) is delegated to the pure helpers and tested
 * separately. Here we only verify the provider exposes the correct
 * structural hooks for those helpers to act on.
 */

import '../../../setup';
import * as assert from 'assert';
import {
  GitToolWindowProvider,
  type IExtendedLogState,
} from '../../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';

interface MultiSelectInternals {
  _extendedLogState: IExtendedLogState;
  _handleWebviewMessage(message: {
    type: string;
    commitHash?: string;
    commitHashes?: string[];
    anchorHash?: string;
  }): void;
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

describe('Wave A — provider integration', () => {
  let provider: GitToolWindowProvider;
  const extensionUri = Uri.file('/test/extension');

  beforeEach(() => {
    provider = new GitToolWindowProvider(extensionUri);
  });

  afterEach(() => {
    provider.dispose();
  });

  // ─── A0: inline script no longer hard-disables editCommitMessage ─────────
  describe('A0 — editCommitMessage no longer unconditionally disabled', () => {
    it('inline script does NOT contain a hard-disable line for editCommitMessage', () => {
      // The bug at line 3650-3652 was an unconditional
      // `editMsgItem.classList.add('disabled')`. After the disable
      // call must be guarded by `!isSingleCommit` (or equivalent), so it
      // is conditional, not free-standing.
      const html = provider._getThreePanelHtmlContent(
        { cspSource: 'test:' } as unknown as import('vscode').Webview,
        []
      );

      // Match the pre-fix pattern: `editMsgItem.classList.add('disabled')`
      // appearing as a top-level statement (not inside an `if (!...)` block).
      // We grep for the line shape and assert NO occurrence is unconditional.
      // The fix wraps it in `if (!isSingleCommit)`; older bug had it bare.
      const bareDisable = /editMsgItem\.classList\.add\(['"]disabled['"]\);(?!\s*\/\/ guarded)/;
      const inlineMatch = bareDisable.exec(html);
      if (inlineMatch) {
        // It's allowed, but only inside a guarded `if (!isSingleCommit)`
        // block. Look back 200 chars for the guard.
        const start = Math.max(0, inlineMatch.index - 200);
        const window = html.substring(start, inlineMatch.index);
        assert.ok(
          /if\s*\(\s*!\s*isSingleCommit\s*\)\s*\{/.test(window) ||
            /!isSingle/.test(window) ||
            /isMulti/.test(window),
          'editMsgItem.classList.add("disabled") must be guarded by a single-commit check'
        );
      }
    });

    it('inline script applies a host-precomputed enable map (no JS-side rule mirror)', () => {
      const html = provider._getThreePanelHtmlContent(
        { cspSource: 'test:' } as unknown as import('vscode').Webview,
        []
      );
      // The inline-script no longer mirrors the rules; it applies
      // the host-precomputed `menuEnableMap` per-action via `applyMenuEnableMap`.
      // Direct check: the apply-loop function exists and references `menuEnableMap`.
      assert.ok(
        /function\s+applyMenuEnableMap\s*\(/.test(html),
        'inline script must define applyMenuEnableMap'
      );
      assert.ok(
        /menuEnableMap/.test(html),
        'inline script must read menuEnableMap (the host-pushed payload)'
      );
      // And: the legacy `case 'editCommitMessage': enabled = isSingleCommit`
      // mirror MUST be gone — the cases live host-side now in computeMenuEnableState.
      assert.ok(
        !/case\s+['"]editCommitMessage['"]\s*:\s*[\s\S]{0,200}isSingleCommit/.test(html),
        'legacy JS-side editCommitMessage rule mirror must be gone (host owns the rules)'
      );
    });

    it('inline script no longer hard-disables editCommitMessage with a bare classList.add line', () => {
      const html = provider._getThreePanelHtmlContent(
        { cspSource: 'test:' } as unknown as import('vscode').Webview,
        []
      );
      // The bug was a single statement
      // `editMsgItem.classList.add('disabled');` on its own line. After
      // the legacy `editMsgItem` reference must be gone — the loop body
      // operates on `item`, not a per-action variable.
      assert.ok(
        !/editMsgItem\.classList\.add\(['"]disabled['"]\)/.test(html),
        'legacy editMsgItem.classList.add("disabled") regression must not return'
      );
    });
  });

  // ─── A1: anchor-hash tracking ────────────────────────────────────────────
  describe('A1 — anchorHash state', () => {
    it('starts with anchorHash = null on a fresh provider', () => {
      const internals = provider as unknown as MultiSelectInternals;
      assert.strictEqual(internals._extendedLogState.anchorHash, null);
    });

    it('plain-click (selectCommit message) sets anchorHash to clicked hash', () => {
      const internals = provider as unknown as MultiSelectInternals;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);

      internals._handleWebviewMessage({ type: 'selectCommit', commitHash: 'bbb' });

      assert.strictEqual(internals._extendedLogState.anchorHash, 'bbb');
    });

    it('ctrl-click (toggleCommitSelection message) updates anchorHash to clicked hash', () => {
      const internals = provider as unknown as MultiSelectInternals;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      internals._handleWebviewMessage({ type: 'selectCommit', commitHash: 'aaa' });

      // Ctrl-click on b: anchor moves from 'aaa' to 'bbb'.
      internals._handleWebviewMessage({ type: 'toggleCommitSelection', commitHash: 'bbb' });

      assert.strictEqual(internals._extendedLogState.anchorHash, 'bbb');
    });

    it('shift+click range-select replaces selection with [anchor..click] and leaves anchor unchanged', () => {
      const internals = provider as unknown as MultiSelectInternals;
      // Display order is newest-first → after sort+reverse:
      //   [ddd → ccc → bbb → aaa]
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
        mkCommit('ddd', 'd', ['ccc']),
      ]);
      // Plain-click on bbb: anchor = bbb, selection = {bbb}
      internals._handleWebviewMessage({ type: 'selectCommit', commitHash: 'bbb' });
      // Shift-click on ddd: range = [ddd, ccc, bbb] (display order)
      internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: 'ddd' });

      const sel = internals._extendedLogState.selectedCommits;
      assert.deepStrictEqual(
        Array.from(sel).sort(),
        ['bbb', 'ccc', 'ddd'].sort(),
        'shift-click should select the inclusive range from anchor to click'
      );
      assert.strictEqual(
        internals._extendedLogState.anchorHash,
        'bbb',
        'plain shift-click does NOT move the anchor'
      );
    });

    it('shift+ctrl+click adds the range from anchor to click without dropping prior selection', () => {
      const internals = provider as unknown as MultiSelectInternals;
      // Display order [ddd → ccc → bbb → aaa]
      provider.updateLogState([
        mkCommit('aaa'),
        mkCommit('bbb', 'b', ['aaa']),
        mkCommit('ccc', 'c', ['bbb']),
        mkCommit('ddd', 'd', ['ccc']),
      ]);
      // Plain on aaa, then ctrl on ccc → selection {aaa, ccc}, anchor=ccc
      internals._handleWebviewMessage({ type: 'selectCommit', commitHash: 'aaa' });
      internals._handleWebviewMessage({ type: 'toggleCommitSelection', commitHash: 'ccc' });
      // Now shift+ctrl click on ddd: ADD range [ddd..ccc] = {ccc, ddd} to existing.
      internals._handleWebviewMessage({
        type: 'addRangeSelectCommit',
        commitHash: 'ddd',
      });

      const sel = internals._extendedLogState.selectedCommits;
      assert.deepStrictEqual(
        Array.from(sel).sort(),
        ['aaa', 'ccc', 'ddd'].sort(),
        'shift+ctrl should ADD the range to the existing selection'
      );
    });

    it('shift+click with anchor=null falls back to plain-click semantics', () => {
      const internals = provider as unknown as MultiSelectInternals;
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);

      // No prior selectCommit — anchor is null.
      internals._handleWebviewMessage({ type: 'rangeSelectCommit', commitHash: 'bbb' });

      const sel = internals._extendedLogState.selectedCommits;
      assert.deepStrictEqual(Array.from(sel), ['bbb']);
      assert.strictEqual(internals._extendedLogState.anchorHash, 'bbb');
    });
  });

  // ─── A2: menu HTML adds new items with hidden-by-default ─────────────────
  describe('A2 — context menu HTML extensions', () => {
    it('includes data-action="squashCommits" on the commit context menu', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        html.includes('data-action="squashCommits"'),
        'commit context menu must include squashCommits item'
      );
    });

    it('includes data-action="compareVersions" on the commit context menu', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(
        html.includes('data-action="compareVersions"'),
        'commit context menu must include compareVersions item'
      );
    });

    it('renders "Squash Commits" label', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Squash Commits'), 'must include "Squash Commits" label');
    });

    it('renders "Compare Versions" label', () => {
      const html = provider._getCommitContextMenuHtml();
      assert.ok(html.includes('Compare Versions'), 'must include "Compare Versions" label');
    });

    it('squashCommits and compareVersions default to hidden via menu-multi-hidden class', () => {
      const html = provider._getCommitContextMenuHtml();
      // Find the squashCommits row — it must include `menu-multi-hidden` so
      // it is hidden by default (only shown when N>=2).
      const squashIdx = html.indexOf('data-action="squashCommits"');
      assert.ok(squashIdx !== -1);
      const squashRow = html.substring(Math.max(0, squashIdx - 200), squashIdx + 200);
      assert.ok(
        squashRow.includes('menu-multi-hidden'),
        'squashCommits row must include menu-multi-hidden class so it is hidden by default'
      );

      const compareIdx = html.indexOf('data-action="compareVersions"');
      assert.ok(compareIdx !== -1);
      const compareRow = html.substring(Math.max(0, compareIdx - 200), compareIdx + 200);
      assert.ok(
        compareRow.includes('menu-multi-hidden'),
        'compareVersions row must include menu-multi-hidden class so it is hidden by default'
      );
    });

    it('preserves all 13 single-action items (no regression of pre-Wave-A menu)', () => {
      const html = provider._getCommitContextMenuHtml();
      const requiredActions = [
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
        'mergeIntoCurrent',
        'interactiveRebase',
      ];
      for (const action of requiredActions) {
        assert.ok(
          html.includes(`data-action="${action}"`),
          `regression: missing data-action="${action}"`
        );
      }
    });
  });

  // ─── A4: count + a11y on details panel + graph panel ────────────────────
  describe('A4 — selection-count indicator + a11y', () => {
    it('graph panel root has aria-multiselectable="true"', () => {
      provider.updateLogState([mkCommit('aaa')]);
      const html = provider._getGraphPanelHtml(provider.getExtendedLogState().commitNodes);
      assert.ok(
        html.includes('aria-multiselectable="true"'),
        'graph panel root must declare itself multiselectable'
      );
    });

    it('graph panel root has data-selected-count attribute', () => {
      provider.updateLogState([mkCommit('aaa'), mkCommit('bbb', 'b', ['aaa'])]);
      const selected = new Set(['aaa', 'bbb']);
      const html = provider._getGraphPanelHtml(
        provider.getExtendedLogState().commitNodes,
        selected
      );
      assert.ok(
        html.includes('data-selected-count="2"'),
        'graph panel root must expose data-selected-count for CSS / test hooks'
      );
    });

    it('data-selected-count reflects 0 when no commits are selected', () => {
      provider.updateLogState([mkCommit('aaa')]);
      const html = provider._getGraphPanelHtml(provider.getExtendedLogState().commitNodes);
      assert.ok(
        html.includes('data-selected-count="0"'),
        'graph panel root must expose data-selected-count="0" when nothing selected'
      );
    });

    it('multi-commit details header still uses "N commits selected" style copy (regression guard)', () => {
      // The header was already "N commits selected" — A4 only
      // adds a data-selected-count attribute. Keep this regression guard so
      // we notice if a careless edit drops the established copy.
      const commits = [
        {
          hash: 'aaa1',
          message: 'a',
          body: undefined,
          author: { name: 'a', email: 'a@x' },
          date: new Date(0),
          parents: [],
          branches: [],
          tags: [],
          changedFiles: [],
        },
        {
          hash: 'bbb2',
          message: 'b',
          body: undefined,
          author: { name: 'b', email: 'b@x' },
          date: new Date(0),
          parents: [],
          branches: [],
          tags: [],
          changedFiles: [],
        },
      ];
      const html = provider._getMultiCommitDetailsPanelHtml(commits);
      assert.ok(html.includes('2 commits selected'));
      assert.ok(html.includes('data-selected-count="2"'));
    });
  });
});
