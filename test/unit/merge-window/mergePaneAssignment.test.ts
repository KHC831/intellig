import '../../setup';
import * as assert from 'assert';
import {
  assignMergePanes,
  IMergeStageContents,
} from '../../../src/conflicts/merge-window/mergeStages';

const STAGES: IMergeStageContents = {
  base: 'base\n',
  ours: 'stage2\n',
  theirs: 'stage3\n',
};

describe('merge window pane assignment (stages → panes via the reversal predicate)', () => {
  it('a merge maps stage 2 to the left (Yours) pane and stage 3 to the right', () => {
    const panes = assignMergePanes(STAGES, { ours: 'main', theirs: 'feature' }, 'merge');
    assert.strictEqual(panes.left.content, 'stage2\n');
    assert.strictEqual(panes.left.label, 'Yours (main)');
    assert.strictEqual(panes.right.content, 'stage3\n');
    assert.strictEqual(panes.right.label, 'Theirs (feature)');
    assert.strictEqual(panes.base, 'base\n');
  });

  it('a rebase swaps CONTENT and label together: left (Yours) shows stage 3', () => {
    // Rebase replays the user's branch as stage 3 (git swaps ours/theirs), so
    // both the label AND the content of the Yours pane must come from stage 3
    // — IntelliJ swaps the content in GitMergeUtil.loadMergeData
    // (plugins/git4idea/backend/src/merge/GitMergeUtil.java, isReversed).
    const panes = assignMergePanes(STAGES, { ours: 'main', theirs: 'feature' }, 'rebase');
    assert.strictEqual(panes.left.content, 'stage3\n', 'Yours pane must hold stage 3 on a rebase');
    assert.strictEqual(panes.left.label, 'Yours (feature)');
    assert.strictEqual(panes.right.content, 'stage2\n');
    assert.strictEqual(panes.right.label, 'Theirs (main)');
  });

  it('unstash and unshelve swap like a rebase', () => {
    for (const op of ['unstash', 'unshelve'] as const) {
      const panes = assignMergePanes(STAGES, { ours: 'main' }, op);
      assert.strictEqual(panes.left.content, 'stage3\n', `${op}: Yours pane must hold stage 3`);
      assert.strictEqual(panes.right.content, 'stage2\n');
      assert.strictEqual(panes.right.label, 'Theirs (main)', `${op}: stage-2 name follows stage 2`);
    }
  });

  it('cherry-pick, revert and applyPatch stay forward like a merge', () => {
    for (const op of ['cherryPick', 'revert', 'applyPatch'] as const) {
      const panes = assignMergePanes(STAGES, {}, op);
      assert.strictEqual(panes.left.content, 'stage2\n');
      assert.strictEqual(panes.right.content, 'stage3\n');
    }
  });

  it('an unknown operation defaults to the forward mapping', () => {
    const panes = assignMergePanes(STAGES, {}, undefined);
    assert.strictEqual(panes.left.content, 'stage2\n');
    assert.strictEqual(panes.right.content, 'stage3\n');
  });

  it('a side with no resolved name falls back to the generic label', () => {
    const panes = assignMergePanes(STAGES, {}, 'merge');
    assert.strictEqual(panes.left.label, 'Yours');
    assert.strictEqual(panes.right.label, 'Theirs');
  });

  it('identical side names are disambiguated like the Resolve Conflicts dialog', () => {
    const panes = assignMergePanes(STAGES, { ours: 'main', theirs: 'main' }, 'merge');
    assert.strictEqual(panes.left.label, 'Yours (main (current))');
    assert.strictEqual(panes.right.label, 'Theirs (main (incoming))');
  });
});
