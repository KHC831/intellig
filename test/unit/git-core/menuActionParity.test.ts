/**
 * newBranch / newTag are single-only commit-menu actions, and the commit
 * context menu's data-actions must not drift from the multi-select gating map.
 *
 * The bug this pins: an action rendered in buildCommitContextMenuHtml but
 * absent from MultiSelectMenuAction is never covered by computeMenuState, so
 * the webview's applyMenuEnableMap falls back to visible+enabled and the row
 * stays clickable at N>=2 (acting on an arbitrary member of the selection).
 * newBranch/newTag escaped exactly this way.
 */
import '../../setup';
import * as assert from 'assert';
import {
  computeMenuVisibility,
  computeMenuEnableState,
  MultiSelectMenuAction,
} from '../../../src/git-core/gitToolWindow/multiSelect';
import { buildCommitContextMenuHtml } from '../../../src/git-core/gitToolWindow/provider/htmlBuilders';
import { IGtwControllerContext } from '../../../src/git-core/gitToolWindow/provider/IGtwControllerContext';

describe('newBranch / newTag multi-select gating', () => {
  it('hidden at N>=2 (single-only visibility)', () => {
    assert.strictEqual(computeMenuVisibility(2).newBranch, false);
    assert.strictEqual(computeMenuVisibility(2).newTag, false);
    assert.strictEqual(computeMenuVisibility(5).newBranch, false);
  });

  it('shown at N=1', () => {
    assert.strictEqual(computeMenuVisibility(1).newBranch, true);
    assert.strictEqual(computeMenuVisibility(1).newTag, true);
  });

  it('disabled at N>=2 in the enable map', () => {
    const inputs = {
      selectedCount: 2,
      isContiguous: true,
      isHeadInSelection: false,
      hasMergeCommitInSelection: false,
      isSelectedInCurrentBranch: true,
    };
    assert.strictEqual(computeMenuEnableState(inputs).newBranch, false);
    assert.strictEqual(computeMenuEnableState(inputs).newTag, false);
    assert.strictEqual(computeMenuEnableState({ ...inputs, selectedCount: 1 }).newBranch, true);
  });
});

describe('commit context menu ⊆ multi-select gating map (drift fence)', () => {
  function menuActions(): string[] {
    const ctx = {
      extendedLogState: { commitNodes: [] },
    } as unknown as IGtwControllerContext;
    const html = buildCommitContextMenuHtml(ctx);
    const found: string[] = [];
    const re = /data-action="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      found.push(m[1]);
    }
    return found;
  }

  it('every rendered data-action is a key of the gating map (else it escapes multi-select)', () => {
    const keys = new Set(Object.keys(computeMenuVisibility(1)));
    const actions = menuActions();
    assert.ok(actions.length > 0, 'expected to parse at least one data-action');
    for (const action of actions) {
      assert.ok(
        keys.has(action),
        `menu action "${action}" is not a MultiSelectMenuAction — applyMenuEnableMap ` +
          `would fall back to visible+enabled, leaving it clickable at N>=2`
      );
    }
  });

  it('newBranch and newTag are among the rendered actions AND gated', () => {
    const actions = menuActions();
    assert.ok(actions.includes('newBranch') && actions.includes('newTag'));
    // Type-level proof they are now members of the union.
    const gated: MultiSelectMenuAction[] = ['newBranch', 'newTag'];
    assert.deepStrictEqual(gated, ['newBranch', 'newTag']);
  });

  // compareWithBranch is a gating-map key with NO row in this menu: it is a real
  // LogContextAction surfaced through the branch popup / command palette, not
  // the commit context menu. Extra keys are allowed; missing keys are not.
});
