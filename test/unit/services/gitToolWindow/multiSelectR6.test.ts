/**
 * HEAD-containment gate for the history-rewriting log actions.
 *
 * IntelliJ's GitCommitEditingActionBase.checkCommitsCanBeEdited greys any
 * commit-editing action whose target is not contained in the current branch
 * (GitUtil.HEAD not among the commit's containing branches). IntelliG had the
 * ancestor-walk (`isSelectedInCurrentBranch`) wired only into Fixup / Squash
 * Into and only for N=1. These specs pin the walk extended to multi-selections
 * and wired into squashCommits / dropCommit / editCommitMessage /
 * interactiveRebase, matching git4idea
 * backend/src/rebase/log/GitCommitEditingActionBase.kt.
 */

import '../../../setup';
import * as assert from 'assert';
import {
  computeMenuState,
  type IMenuStateNode,
} from '../../../../src/git-core/gitToolWindow/multiSelect';

// Display order is newest-first. Two branches share `base`:
//   Branch A (checked out, HEAD = a1): a1 -> a2 -> base
//   Branch B (other):                  b1 -> b2 -> base
// A-commits are reachable from HEAD; B-commits are not.
const A1 = '1111111111111111111111111111111111111111';
const A2 = '2222222222222222222222222222222222222222';
const B1 = '3333333333333333333333333333333333333333';
const B2 = '4444444444444444444444444444444444444444';
const BASE = '5555555555555555555555555555555555555555';

function nodes(): readonly IMenuStateNode[] {
  return [
    { hash: B1, parentCount: 1, parents: [B2] },
    { hash: B2, parentCount: 1, parents: [BASE] },
    { hash: A1, parentCount: 1, parents: [A2] },
    { hash: A2, parentCount: 1, parents: [BASE] },
    { hash: BASE, parentCount: 0, parents: [] },
  ];
}

describe('Wave R6 — HEAD-containment gate for history-rewriting actions', () => {
  describe('off-branch selections are disabled', () => {
    it('disables squashCommits when the contiguous selection is not in the current branch', () => {
      const state = computeMenuState({
        selectedHashes: new Set([B1, B2]), // contiguous first-parent chain on branch B
        commitNodes: nodes(),
        headHash: A1,
      });
      assert.strictEqual(state.squashCommits.visible, true, 'squash is visible at N=2');
      assert.strictEqual(
        state.squashCommits.enabled,
        false,
        'squash must be disabled for commits not in the current branch'
      );
      assert.ok(
        state.squashCommits.reason && /not in the current branch/i.test(state.squashCommits.reason),
        `expected a "not in the current branch" reason; got ${JSON.stringify(state.squashCommits.reason)}`
      );
    });

    it('disables dropCommit for a single off-branch commit', () => {
      const state = computeMenuState({
        selectedHashes: new Set([B1]),
        commitNodes: nodes(),
        headHash: A1,
      });
      assert.strictEqual(state.dropCommit.visible, true);
      assert.strictEqual(state.dropCommit.enabled, false);
      assert.ok(
        state.dropCommit.reason && /not in the current branch/i.test(state.dropCommit.reason),
        `expected drop reason; got ${JSON.stringify(state.dropCommit.reason)}`
      );
    });

    it('disables dropCommit for a multi off-branch selection', () => {
      const state = computeMenuState({
        selectedHashes: new Set([B1, B2]),
        commitNodes: nodes(),
        headHash: A1,
      });
      assert.strictEqual(state.dropCommit.enabled, false);
    });

    it('disables editCommitMessage for an off-branch commit', () => {
      const state = computeMenuState({
        selectedHashes: new Set([B1]),
        commitNodes: nodes(),
        headHash: A1,
      });
      assert.strictEqual(state.editCommitMessage.visible, true);
      assert.strictEqual(state.editCommitMessage.enabled, false);
      assert.ok(
        state.editCommitMessage.reason &&
          /not in the current branch/i.test(state.editCommitMessage.reason)
      );
    });

    it('disables interactiveRebase for an off-branch commit', () => {
      const state = computeMenuState({
        selectedHashes: new Set([B1]),
        commitNodes: nodes(),
        headHash: A1,
      });
      assert.strictEqual(state.interactiveRebase.visible, true);
      assert.strictEqual(state.interactiveRebase.enabled, false);
      assert.ok(
        state.interactiveRebase.reason &&
          /not in the current branch/i.test(state.interactiveRebase.reason)
      );
    });
  });

  describe('in-branch selections stay enabled (no false grey)', () => {
    it('enables squashCommits for a contiguous in-branch selection', () => {
      const state = computeMenuState({
        selectedHashes: new Set([A1, A2]),
        commitNodes: nodes(),
        headHash: A1,
      });
      assert.strictEqual(state.squashCommits.enabled, true);
      assert.strictEqual(state.squashCommits.reason, undefined);
    });

    it('enables dropCommit / editCommitMessage / interactiveRebase for the HEAD commit', () => {
      const state = computeMenuState({
        selectedHashes: new Set([A1]),
        commitNodes: nodes(),
        headHash: A1,
      });
      assert.strictEqual(state.dropCommit.enabled, true);
      assert.strictEqual(state.editCommitMessage.enabled, true);
      assert.strictEqual(state.interactiveRebase.enabled, true);
    });
  });

  describe('permissive when HEAD is unknown (merged scope / off-window)', () => {
    it('does not grey off-branch commits when headHash is empty', () => {
      const state = computeMenuState({
        selectedHashes: new Set([B1, B2]),
        commitNodes: nodes(),
        headHash: '', // merged "All Repositories" scope: no single HEAD
      });
      // Falls back to enabled (structural gates still apply): the perform-time
      // guard is the real fence when the UI can't resolve HEAD.
      assert.strictEqual(state.squashCommits.enabled, true);
      assert.strictEqual(state.dropCommit.enabled, true);
    });
  });
});
