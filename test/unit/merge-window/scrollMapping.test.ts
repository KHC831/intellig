import '../../setup';
import * as assert from 'assert';
import { IAlignAnchor, mapLine } from '../../../src/conflicts/merge-window/scrollMapping';

describe('merge window scroll mapping', () => {
  it('is identity with no anchors', () => {
    assert.strictEqual(mapLine([], 0), 0);
    assert.strictEqual(mapLine([], 42), 42);
  });

  it('keeps lines before the first anchor unshifted', () => {
    const anchors: IAlignAnchor[] = [{ start1: 5, end1: 7, start2: 5, end2: 10 }];
    assert.strictEqual(mapLine(anchors, 0), 0);
    assert.strictEqual(mapLine(anchors, 4), 4);
  });

  it('shifts lines after an anchor by the anchor size delta', () => {
    const anchors: IAlignAnchor[] = [{ start1: 5, end1: 7, start2: 5, end2: 10 }];
    // Two lines on side 1 became five on side 2: +3 shift after the anchor.
    assert.strictEqual(mapLine(anchors, 7), 10);
    assert.strictEqual(mapLine(anchors, 9), 12);
  });

  it('maps proportionally inside an anchor', () => {
    const anchors: IAlignAnchor[] = [{ start1: 10, end1: 14, start2: 20, end2: 28 }];
    assert.strictEqual(mapLine(anchors, 10), 20);
    assert.strictEqual(mapLine(anchors, 12), 24);
  });

  it('maps an empty source range to its target start', () => {
    const anchors: IAlignAnchor[] = [{ start1: 3, end1: 3, start2: 3, end2: 6 }];
    assert.strictEqual(mapLine(anchors, 2), 2);
    // Lines at/after the insertion point shift by the inserted size.
    assert.strictEqual(mapLine(anchors, 3), 6);
    assert.strictEqual(mapLine(anchors, 5), 8);
  });

  it('interpolates fractional lines smoothly (no per-line rounding)', () => {
    // A 2-line block aligned to a 4-line block: slope 2 inside the anchor.
    const anchors: IAlignAnchor[] = [{ start1: 10, end1: 12, start2: 20, end2: 24 }];
    assert.strictEqual(mapLine(anchors, 10.5), 21);
    assert.strictEqual(mapLine(anchors, 11.25), 22.5);
    // Outside anchors the slope is 1, fractions pass through.
    assert.strictEqual(mapLine(anchors, 5.75), 5.75);
    assert.strictEqual(mapLine(anchors, 13.5), 25.5);
  });

  it('composes across several anchors', () => {
    const anchors: IAlignAnchor[] = [
      { start1: 2, end1: 3, start2: 2, end2: 2 }, // one line deleted on side 2
      { start1: 6, end1: 6, start2: 5, end2: 8 }, // three lines inserted on side 2
    ];
    assert.strictEqual(mapLine(anchors, 1), 1);
    assert.strictEqual(mapLine(anchors, 4), 3);
    assert.strictEqual(mapLine(anchors, 7), 9);
  });
});
