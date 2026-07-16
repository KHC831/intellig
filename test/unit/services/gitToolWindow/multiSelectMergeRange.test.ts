/**
 * Merge-flattening enable-state mirror for the history-rewriting log actions.
 *
 * IntelliJ refuses every commit-editing action when no merge-free path exists
 * between HEAD and the oldest selected commit (git4idea
 * backend/src/rebase/log/GitCommitEditingActionBase.kt checkHeadLinearHistory):
 * a plain `rebase -i` over `oldest^..HEAD` flattens every merge in the range.
 * The host-side handlers refuse at perform time; these specs pin the MENU
 * mirror — dropCommit / squashCommits / editCommitMessage / interactiveRebase
 * grey out (with a reason) when a merge commit sits between the selection and
 * HEAD. The one sanctioned exception mirrors GitRewordAction: rewording HEAD
 * itself runs as an amend (no rebase), so editCommitMessage stays enabled for
 * a HEAD selection even when HEAD is a merge.
 */

import '../../../setup';
import * as assert from 'assert';
import {
  computeMenuState,
  type IMenuStateNode,
} from '../../../../src/git-core/gitToolWindow/multiSelect';

// Display order is newest-first. A merge M brought side branch S into the
// mainline; commits below M are only reachable from HEAD through it:
//   HEAD = h1 -> M(h2, s1) -> h2 -> h3(root); s1 -> h3
const H1 = '1111111111111111111111111111111111111111';
const M = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const S1 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';

function mergeNodes(): readonly IMenuStateNode[] {
  return [
    { hash: H1, parentCount: 1, parents: [M] },
    { hash: M, parentCount: 2, parents: [H2, S1] },
    { hash: S1, parentCount: 1, parents: [H3] },
    { hash: H2, parentCount: 1, parents: [H3] },
    { hash: H3, parentCount: 0, parents: [] },
  ];
}

// Linear control: h1 -> h2 -> h3.
function linearNodes(): readonly IMenuStateNode[] {
  return [
    { hash: H1, parentCount: 1, parents: [H2] },
    { hash: H2, parentCount: 1, parents: [H3] },
    { hash: H3, parentCount: 0, parents: [] },
  ];
}

describe('merge-flattening enable-state mirror (merge between selection and HEAD)', () => {
  describe('selection below a merge is greyed', () => {
    for (const action of ['dropCommit', 'editCommitMessage', 'interactiveRebase'] as const) {
      it(`disables ${action} for a commit below the merge`, () => {
        const state = computeMenuState({
          selectedHashes: new Set([H2]),
          commitNodes: mergeNodes(),
          headHash: H1,
        });
        assert.strictEqual(state[action].visible, true);
        assert.strictEqual(
          state[action].enabled,
          false,
          `${action} must grey when \`oldest^..HEAD\` contains a merge`
        );
        assert.ok(
          state[action].reason && /merge/i.test(state[action].reason),
          `expected a merge-flattening reason; got ${JSON.stringify(state[action].reason)}`
        );
      });
    }

    it('disables squashCommits when the contiguous pair sits below the merge', () => {
      const state = computeMenuState({
        selectedHashes: new Set([H2, H3]),
        commitNodes: mergeNodes(),
        headHash: H1,
      });
      assert.strictEqual(state.squashCommits.visible, true);
      assert.strictEqual(state.squashCommits.enabled, false);
      assert.ok(
        state.squashCommits.reason && /merge/i.test(state.squashCommits.reason),
        `expected a merge-flattening reason; got ${JSON.stringify(state.squashCommits.reason)}`
      );
    });

    it('disables editCommitMessage for a non-HEAD merge commit (reword-of-merge gate)', () => {
      const state = computeMenuState({
        selectedHashes: new Set([M]),
        commitNodes: mergeNodes(),
        headHash: H1,
      });
      assert.strictEqual(state.editCommitMessage.enabled, false);
      assert.ok(
        state.editCommitMessage.reason && /merge/i.test(state.editCommitMessage.reason),
        `expected a merge reason; got ${JSON.stringify(state.editCommitMessage.reason)}`
      );
    });
  });

  describe('selections above the merge stay enabled', () => {
    it('keeps dropCommit / editCommitMessage / interactiveRebase enabled for HEAD above the merge', () => {
      const state = computeMenuState({
        selectedHashes: new Set([H1]),
        commitNodes: mergeNodes(),
        headHash: H1,
      });
      assert.strictEqual(state.dropCommit.enabled, true, 'range {HEAD} carries no merge');
      assert.strictEqual(state.editCommitMessage.enabled, true);
      assert.strictEqual(state.interactiveRebase.enabled, true);
    });

    it('keeps editCommitMessage enabled when HEAD ITSELF is the selected merge (amend arm)', () => {
      // GitRewordAction.kt allows merge reword only when the commit is HEAD;
      // our HEAD path amends (no rebase, nothing to flatten).
      const headMergeNodes: readonly IMenuStateNode[] = [
        { hash: M, parentCount: 2, parents: [H2, S1] },
        { hash: S1, parentCount: 1, parents: [H3] },
        { hash: H2, parentCount: 1, parents: [H3] },
        { hash: H3, parentCount: 0, parents: [] },
      ];
      const state = computeMenuState({
        selectedHashes: new Set([M]),
        commitNodes: headMergeNodes,
        headHash: M,
      });
      assert.strictEqual(
        state.editCommitMessage.enabled,
        true,
        'HEAD merge reword rides the amend path — must stay enabled'
      );
      assert.strictEqual(
        state.interactiveRebase.enabled,
        false,
        'interactive rebase over a HEAD merge still flattens it — stays greyed'
      );
    });

    it('linear history keeps everything enabled (control)', () => {
      const state = computeMenuState({
        selectedHashes: new Set([H2]),
        commitNodes: linearNodes(),
        headHash: H1,
      });
      assert.strictEqual(state.dropCommit.enabled, true);
      assert.strictEqual(state.editCommitMessage.enabled, true);
      assert.strictEqual(state.interactiveRebase.enabled, true);
    });

    it('squash of a linear pair stays enabled (control)', () => {
      const state = computeMenuState({
        selectedHashes: new Set([H1, H2]),
        commitNodes: linearNodes(),
        headHash: H1,
      });
      assert.strictEqual(state.squashCommits.enabled, true);
    });
  });
});
