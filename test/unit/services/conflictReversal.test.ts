/**
 * Unit tests for the conflict ours/theirs reversal helpers.
 *
 * These are pure functions but they gate a data-integrity decision: which side
 * of a conflict "Accept Yours/Theirs" keeps. A wrong answer silently discards
 * the user's work, so the mapping is pinned explicitly here.
 */

import '../../setup';
import * as assert from 'assert';
import {
  isReversedOperation,
  inferReopenOperation,
  type ConflictRepoState,
} from '../../../src/conflicts/conflictReversal';
import type { IConflictOpContext } from '../../../src/conflicts/interfaces/IConflictResolutionService';

type Op = IConflictOpContext['operation'];

describe('isReversedOperation', () => {
  it('reverses ours/theirs for rebase, unstash, and unshelve', () => {
    for (const op of ['rebase', 'unstash', 'unshelve'] as Op[]) {
      assert.strictEqual(isReversedOperation(op), true, `${op} must reverse`);
    }
  });

  it('does NOT reverse for merge, cherryPick, revert, applyPatch, or undefined', () => {
    for (const op of ['merge', 'cherryPick', 'revert', 'applyPatch', undefined] as Array<
      Op | undefined
    >) {
      assert.strictEqual(isReversedOperation(op), false, `${op} must not reverse`);
    }
  });
});

describe('inferReopenOperation', () => {
  it('uses the recorded operation to disambiguate an IDLE repo (working-tree apply)', () => {
    // An idle repo with unmerged files is a working-tree apply with no *_HEAD
    // marker; the recorded op is the only truth about which one (unstash vs
    // unshelve vs applyPatch).
    assert.strictEqual(inferReopenOperation('unstash', 'idle'), 'unstash');
    assert.strictEqual(inferReopenOperation('unshelve', 'idle'), 'unshelve');
    assert.strictEqual(inferReopenOperation('applyPatch', 'idle'), 'applyPatch');
  });

  it('trusts a definitive in-progress STATE over a stale recorded op', () => {
    // A non-idle state is a git fact (you ARE rebasing); a recorded op left over
    // from an earlier conflict must not override it, or "Accept Yours" would take
    // the wrong index stage.
    assert.strictEqual(inferReopenOperation('merge', 'rebasing'), 'rebase');
    assert.strictEqual(inferReopenOperation('merge', 'cherry-picking'), 'cherryPick');
    assert.strictEqual(isReversedOperation(inferReopenOperation('merge', 'rebasing')), true);
    // And the reverse direction: a recorded REVERSED op must not flip a definitive
    // non-idle state. A stale 'unstash' over a live merge stays a (non-reversed)
    // merge — the index is not swapped just because an old apply op lingers.
    assert.strictEqual(inferReopenOperation('unstash', 'merging'), 'merge');
    assert.strictEqual(isReversedOperation(inferReopenOperation('unstash', 'merging')), false);
  });

  it('maps each in-progress state to its operation when nothing is recorded', () => {
    const cases: Array<[ConflictRepoState, Op]> = [
      ['merging', 'merge'],
      ['rebasing', 'rebase'],
      ['cherry-picking', 'cherryPick'],
      ['reverting', 'revert'],
    ];
    for (const [state, expected] of cases) {
      assert.strictEqual(inferReopenOperation(undefined, state), expected, `state ${state}`);
    }
  });

  it('does NOT reverse a cherry-pick or revert (they keep --ours for "Accept Yours")', () => {
    // External cherry-pick/revert conflicts must resolve non-reversed: stage 2
    // (--ours) is the current branch the user keeps. Regression for the state
    // misclassification that made them guess 'unstash' (reversed) and discard it.
    assert.strictEqual(
      isReversedOperation(inferReopenOperation(undefined, 'cherry-picking')),
      false
    );
    assert.strictEqual(isReversedOperation(inferReopenOperation(undefined, 'reverting')), false);
  });

  it('guesses unstash (reversed) for an idle repo with no recorded op', () => {
    // An idle repo with unmerged files is never a merge/rebase/cherry/revert
    // (those leave state). It is a working-tree apply — overwhelmingly an
    // external stash pop — where reversal keeps the user's stashed work.
    assert.strictEqual(inferReopenOperation(undefined, 'idle'), 'unstash');
    assert.strictEqual(isReversedOperation(inferReopenOperation(undefined, 'idle')), true);
  });
});
