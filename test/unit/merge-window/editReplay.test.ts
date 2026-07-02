import '../../setup';
import * as assert from 'assert';
import { replayMonacoChanges } from '../../../src/conflicts/merge-window/editReplay';
import { StringMergeDocument } from '../../../src/conflicts/merge-model/MergeDocument';

describe('merge window Monaco edit replay', () => {
  it('applies a single change', () => {
    const doc = new StringMergeDocument('abcdef');
    replayMonacoChanges(doc, [{ rangeOffset: 2, rangeLength: 2, text: 'XY' }]);
    assert.strictEqual(doc.getText(), 'abXYef');
  });

  it('applies a batch whose ranges all refer to the original text', () => {
    // Monaco reports simultaneous changes in pre-change coordinates; applying
    // them from the highest offset down keeps the earlier offsets valid.
    const doc = new StringMergeDocument('abcdefgh');
    replayMonacoChanges(doc, [
      { rangeOffset: 0, rangeLength: 1, text: 'A' },
      { rangeOffset: 5, rangeLength: 2, text: 'BB' },
    ]);
    assert.strictEqual(doc.getText(), 'AbcdeBBh');

    const doc2 = new StringMergeDocument('abcdefgh');
    replayMonacoChanges(doc2, [
      { rangeOffset: 5, rangeLength: 2, text: 'BB' },
      { rangeOffset: 0, rangeLength: 1, text: 'A' },
    ]);
    assert.strictEqual(doc2.getText(), 'AbcdeBBh');
  });

  it('handles inserts and deletes', () => {
    const doc = new StringMergeDocument('abc');
    replayMonacoChanges(doc, [
      { rangeOffset: 3, rangeLength: 0, text: 'Z' },
      { rangeOffset: 0, rangeLength: 1, text: '' },
    ]);
    assert.strictEqual(doc.getText(), 'bcZ');
  });
});
