// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/LineComparisonMergeUtilTest.kt
// Copyright 2000-2018 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { linesDiff, linesMerge, mod } from './mergeComparisonTestUtil';

describe('diff-engine three-side line merge (LineComparisonMergeUtilTest)', () => {
  it('simple cases', () => {
    linesMerge((t) => {
      t.texts('', '', '');
      t.matching('', '', '');
      t.changes();
      t.test();
    });

    linesMerge((t) => {
      t.texts('x_y_z', 'x_y_z', 'x_y_z');
      t.matching(' _ _ ', ' _ _ ', ' _ _ ');
      t.changes();
      t.test();
    });

    linesMerge((t) => {
      t.texts('', '', 'x');
      t.changes(mod(0, 0, 0, 1, 1, 1));
      t.test();
    });

    linesMerge((t) => {
      t.texts('', '', '_x');
      t.matching('', '', '_-');
      t.changes(mod(1, 1, 1, 0, 0, 1));
      t.test();
    });

    linesMerge((t) => {
      t.texts('x', 'y', 'x');
      t.matching('-', '-', '-');
      t.test();
    });

    linesMerge((t) => {
      t.texts('x', 'x_y', 'x');
      t.matching(' ', ' _-', ' ');
      t.test();
    });

    linesMerge((t) => {
      t.texts('x', 'y_x', 'x');
      t.matching(' ', '-_ ', ' ');
      t.test();
    });

    linesMerge((t) => {
      t.texts('x_y_z', 'x_Y_z', 'x_y_z');
      t.matching(' _-_ ', ' _-_ ', ' _-_ ');
      t.test();
    });

    linesMerge((t) => {
      t.texts('x_y_z', 'X_y_Z', 'x_y_z');
      t.matching('-_ _-', '-_ _-', '-_ _-');
      t.test();
    });
  });

  it('ignore whitespaces', () => {
    linesDiff((t) => {
      t.texts('x_ y _z', 'x_y_z', 'x_  y_  z');
      t.changes();
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesMerge((t) => {
      t.texts('x_ y _z', 'x_y_z', 'x_  y_  z');
      t.changes(mod(1, 1, 1, 2, 2, 2));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesDiff((t) => {
      t.texts('x_ y _z', 'x_Y_z', 'x_  y_  z');
      t.changes(mod(1, 1, 1, 1, 1, 1));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesMerge((t) => {
      t.texts('x_ y _z', 'x_Y_z', 'x_  y_  z');
      t.changes(mod(1, 1, 1, 1, 1, 1), mod(2, 2, 2, 1, 1, 1));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesMerge((t) => {
      t.texts('x_ y _z', 'x_Y_z', 'x_  y_z');
      t.changes(mod(1, 1, 1, 1, 1, 1));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesMerge((t) => {
      t.texts('x_ y _z', 'x_y_z', 'x_  y_z');
      t.changes(mod(1, 1, 1, 1, 1, 1));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesMerge((t) => {
      t.texts(' x _y_z', 'x_y_z', 'x_y_  z');
      t.changes(mod(0, 0, 0, 1, 1, 1), mod(2, 2, 2, 1, 1, 1));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesDiff((t) => {
      t.texts(' x_new_y_z', 'x_ y _z', 'x_y_new_ z');
      t.changes(mod(1, 1, 1, 1, 0, 0), mod(3, 2, 2, 0, 0, 1));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesMerge((t) => {
      t.texts(' x_new_y_z', 'x_ y _z', 'x_y_new_ z');
      t.changes(
        mod(0, 0, 0, 1, 1, 1),
        mod(1, 1, 1, 1, 0, 0),
        mod(2, 1, 1, 1, 1, 1),
        mod(3, 2, 2, 0, 0, 1),
        mod(3, 2, 3, 1, 1, 1)
      );
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesDiff((t) => {
      t.texts(' x_new_y1_z', 'x_ y _z', 'x_y2_new_ z');
      t.changes(mod(1, 1, 1, 2, 1, 2));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });

    linesMerge((t) => {
      t.texts(' x_new_y1_z', 'x_ y _z', 'x_y2_new_ z');
      t.changes(mod(0, 0, 0, 1, 1, 1), mod(1, 1, 1, 2, 1, 2), mod(3, 2, 3, 1, 1, 1));
      t.test(ComparisonPolicy.IGNORE_WHITESPACES);
    });
  });
});
