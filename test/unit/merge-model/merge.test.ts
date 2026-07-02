// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/merge/MergeTest.kt
// Copyright 2000-2025 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { MergeConflictTypeKind } from '../../../src/diff-engine/util/MergeConflictType';
import { Side } from '../../../src/diff-engine/util/Side';
import { ThreeSide } from '../../../src/diff-engine/util/ThreeSide';
import { MergeTestBuilder, doTest, doTest1, doTest2, doTestN } from './mergeTestUtil';

const { INSERTED, DELETED, MODIFIED, CONFLICT } = MergeConflictTypeKind;

describe('merge model (MergeTest)', () => {
  it('change types', () => {
    doTest('', '', '', 0, ComparisonPolicy.DEFAULT, () => {});

    doTest('x', 'x', 'x', 0, ComparisonPolicy.DEFAULT, () => {});

    doTest('x_y_z a x', 'x_y_z a x', 'x_y_z a x', 0, ComparisonPolicy.DEFAULT, () => {});

    doTest1('x', 'x', 'y', (t) => {
      t.assertType(0, MODIFIED, 'RIGHT');
      t.assertChangeContent(0, 'x', 0, 1);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x', 'y', 'x', (t) => {
      t.assertType(0, MODIFIED, 'BOTH');
      t.assertChangeContent(0, 'y', 0, 1);
      t.assertResolved(0, 'NONE');
    });

    doTest2('x_Y', 'Y', 'Y_z', (t) => {
      t.assertType(0, INSERTED, 'LEFT');
      t.assertChangeContent(0, '', 0, 0);
      t.assertResolved(0, 'NONE');

      t.assertType(1, INSERTED, 'RIGHT');
      t.assertChangeContent(1, '', 1, 1);
      t.assertResolved(1, 'NONE');
    });

    doTest2('Y_z', 'x_Y_z', 'x_Y', (t) => {
      t.assertType(0, DELETED, 'LEFT');
      t.assertChangeContent(0, 'x', 0, 1);
      t.assertResolved(0, 'NONE');

      t.assertType(1, DELETED, 'RIGHT');
      t.assertChangeContent(1, 'z', 2, 3);
      t.assertResolved(1, 'NONE');
    });

    doTest1('X_Z', 'X_y_Z', 'X_Z', (t) => {
      t.assertType(0, DELETED, 'BOTH');
      t.assertChangeContent(0, 'y', 1, 2);
      t.assertResolved(0, 'NONE');
    });

    doTest1('X_y_Z', 'X_Z', 'X_y_Z', (t) => {
      t.assertType(0, INSERTED, 'BOTH');
      t.assertChangeContent(0, '', 1, 1);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x', 'y', 'z', (t) => {
      t.assertType(0, CONFLICT, 'BOTH');
      t.assertChangeContent(0, 'y', 0, 1);
      t.assertResolved(0, 'NONE');
    });

    doTest1('z_Y', 'x_Y', 'Y', (t) => {
      t.assertType(0, CONFLICT, 'BOTH');
      t.assertChangeContent(0, 'x', 0, 1);
      t.assertResolved(0, 'NONE');
    });

    doTest1('z_Y', 'x_Y', 'k_x_Y', (t) => {
      t.assertType(0, CONFLICT, 'BOTH');
      t.assertChangeContent(0, 'x', 0, 1);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x_Y', 'Y', 'z_Y', (t) => {
      t.assertType(0, CONFLICT, 'BOTH');
      t.assertChangeContent(0, '', 0, 0);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x_Y', 'Y', 'z_x_Y', (t) => {
      t.assertType(0, CONFLICT, 'BOTH');
      t.assertChangeContent(0, '', 0, 0);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x_Y', 'x_z_Y', 'z_Y', (t) => {
      t.assertType(0, CONFLICT, 'BOTH');
      t.assertChangeContent(0, 'x_z', 0, 2);
      t.assertResolved(0, 'NONE');
    });
  });

  it('last line', () => {
    doTest1('x', 'x_', 'x', (t) => {
      t.assertType(0, DELETED, 'BOTH');
      t.assertChangeContent(0, '', 1, 2);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x_', 'x_', 'x', (t) => {
      t.assertType(0, DELETED, 'RIGHT');
      t.assertChangeContent(0, '', 1, 2);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x_', 'x_', 'x_y', (t) => {
      t.assertType(0, MODIFIED, 'RIGHT');
      t.assertChangeContent(0, '', 1, 2);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x', 'x_', 'x_y', (t) => {
      t.assertType(0, CONFLICT, 'BOTH');
      t.assertChangeContent(0, '', 1, 2);
      t.assertResolved(0, 'NONE');
    });

    doTest1('x_', 'x', 'x_y', (t) => {
      t.assertType(0, CONFLICT, 'BOTH');
      t.assertChangeContent(0, '', 1, 1);
      t.assertResolved(0, 'NONE');
    });
  });

  it('modifications', () => {
    doTest1('x', 'x', 'y', (t) => {
      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y');

      t.assertContent('y');
    });

    doTest1('x', 'x', 'y', (t) => {
      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'x');

      t.assertContent('x');
    });

    doTest1('X_x_Z', 'X_x_Z', 'X_y_Z', (t) => {
      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y');

      t.assertContent('X_y_Z');
    });

    doTest1('z', 'x', 'y', (t) => {
      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'RIGHT');
      t.assertChangeContent(0, 'y');

      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y_z');

      t.assertContent('y_z');
    });

    doTest1('z', 'x', 'y', (t) => {
      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'LEFT');
      t.assertChangeContent(0, 'z');

      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'z_y');

      t.assertContent('z_y');
    });

    doTest1('X', 'X', 'X_y', (t) => {
      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y');

      t.assertContent('X_y');
    });

    doTest1('X', 'X', 'X_y', (t) => {
      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, '');

      t.assertContent('X');
    });

    doTest1('X_z', 'X', 'X_y', (t) => {
      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'RIGHT');
      t.assertChangeContent(0, 'y');

      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y_z');

      t.assertContent('X_y_z');
    });

    doTest1('X_z', 'X_y', 'X', (t) => {
      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'z');

      t.assertContent('X_z');
    });

    doTest1('X_z', 'X_y', 'X', (t) => {
      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'RIGHT');
      t.assertChangeContent(0, '');

      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'z');

      t.assertContent('X_z');
    });
  });

  it('modifications ignore', () => {
    doTest1('x', 'x', 'y', (t) => {
      t.ignore(0, Side.RIGHT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'x');

      t.assertContent('x');
    });

    doTest1('x', 'x', 'y', (t) => {
      t.ignore(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'x');

      t.assertContent('x');
    });

    doTest1('z', 'x', 'y', (t) => {
      t.ignore(0, Side.RIGHT);
      t.assertResolved(0, 'RIGHT');
      t.assertChangeContent(0, 'x');

      t.ignore(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'x');

      t.assertContent('x');
    });

    doTest1('z', 'x', 'y', (t) => {
      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'RIGHT');
      t.assertChangeContent(0, 'y');

      t.ignore(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y');

      t.assertContent('y');
    });

    doTest1('z', 'x', 'y', (t) => {
      t.ignore(0, Side.RIGHT);
      t.assertResolved(0, 'RIGHT');
      t.assertChangeContent(0, 'x');

      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'z');

      t.assertContent('z');
    });

    doTest1('X_z', 'X_y', 'X', (t) => {
      t.ignore(0, Side.RIGHT);
      t.assertResolved(0, 'RIGHT');
      t.assertChangeContent(0, 'y');

      t.apply(0, Side.LEFT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'z');

      t.assertContent('X_z');
    });

    doTest1('X_z', 'X_y', 'X', (t) => {
      t.ignore(0, Side.LEFT);
      t.assertResolved(0, 'LEFT');
      t.assertChangeContent(0, 'y');

      t.apply(0, Side.RIGHT);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, '');

      t.assertContent('X');
    });
  });

  it('modifications modifiers', () => {
    doTest1('x', 'x', 'y', (t) => {
      t.apply(0, Side.RIGHT, true);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y');

      t.assertContent('y');
    });

    doTest1('x', 'x', 'y', (t) => {
      t.ignore(0, Side.RIGHT, true);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'x');

      t.assertContent('x');
    });

    doTest1('z', 'x', 'y', (t) => {
      t.apply(0, Side.RIGHT, true);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y');

      t.assertContent('y');
    });

    doTest1('z', 'x', 'y', (t) => {
      t.ignore(0, Side.RIGHT, true);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'x');

      t.assertContent('x');
    });
  });

  it('resolve', () => {
    doTest1('y z', 'x y z', 'x y', (t) => {
      t.resolve(0);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y');

      t.assertContent('y');
    });

    doTest2('y z_Y_x y', 'x y z_Y_x y z', 'x y_Y_y z', (t) => {
      t.resolve(0);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y');

      t.resolve(1);
      t.assertResolved(1, 'BOTH');
      t.assertChangeContent(1, 'y');

      t.assertContent('y_Y_y');
    });

    doTest2('y z_Y_x y', 'x y z_Y_x y z', 'x y_Y_y z', (t) => {
      t.apply(0, Side.LEFT, true);
      t.assertResolved(0, 'BOTH');
      t.assertChangeContent(0, 'y z');

      t.resolve(1);
      t.assertResolved(1, 'BOTH');
      t.assertChangeContent(1, 'y');

      t.assertContent('y z_Y_y');
    });

    doTest1('y z', 'x y z', 'x y', (t) => {
      assert.ok(t.canResolveConflict(0));

      t.replaceText(2, 3, 'U');
      t.assertContent('x U z');

      assert.ok(!t.canResolveConflict(0));
    });

    doTest2('y z_Y_x y', 'x y z_Y_x y z', 'x y_Y_y z', (t) => {
      assert.ok(t.canResolveConflict(0));
      assert.ok(t.canResolveConflict(1));

      t.replaceText(2, 3, 'U');

      assert.ok(!t.canResolveConflict(0));
      assert.ok(t.canResolveConflict(1));
      t.assertContent('x U z_Y_x y z');

      t.checkUndo(1, () => {
        t.resolve(1);
      });
      t.assertResolved(1, 'BOTH');
      t.assertChangeContent(1, 'y');

      assert.ok(!t.canResolveConflict(0));
      assert.ok(!t.canResolveConflict(1));
      t.assertContent('x U z_Y_y');

      t.replaceText(2, 3, 'y');

      assert.ok(t.canResolveConflict(0));
      assert.ok(!t.canResolveConflict(1));

      t.checkUndo(1, () => {
        t.resolve(0);
      });

      assert.ok(!t.canResolveConflict(0));
      assert.ok(!t.canResolveConflict(1));
      t.assertContent('y_Y_y');
    });
  });

  it('undo simple', () => {
    doTest1('x', 'y', 'z', (t) => {
      t.checkUndo(1, () => {
        t.apply(0, Side.RIGHT);
      });
    });

    doTest1('x', 'y', 'z', (t) => {
      t.checkUndo(1, () => {
        t.apply(0, Side.RIGHT, true);
      });
    });

    doTest1('x', 'y', 'z', (t) => {
      t.checkUndo(1, () => {
        t.ignore(0, Side.RIGHT);
      });
    });

    doTest1('x', 'y', 'z', (t) => {
      t.checkUndo(1, () => {
        t.ignore(0, Side.RIGHT, true);
      });
    });

    doTest1('x', 'y', 'z', (t) => {
      t.checkUndo(2, () => {
        t.apply(0, Side.RIGHT);
        t.apply(0, Side.LEFT);
      });
    });

    doTest1('x', 'y', 'z', (t) => {
      t.checkUndo(2, () => {
        t.apply(0, Side.RIGHT);
        t.apply(0, Side.RIGHT);
      });
    });

    doTest1('X', 'X_y', 'X', (t) => {
      t.checkUndo(1, () => {
        t.apply(0, Side.RIGHT);
      });
    });

    doTest1('X', 'X', 'X_y', (t) => {
      t.checkUndo(1, () => {
        t.apply(0, Side.LEFT);
      });
    });

    doTest1('X', 'X', 'X_y', (t) => {
      t.checkUndo(1, () => {
        t.apply(0, Side.RIGHT);
      });
    });

    doTest1('X_z', 'X_y', 'X', (t) => {
      t.checkUndo(1, () => {
        t.apply(0, Side.LEFT);
      });
    });

    doTest1('X_z', 'X_y', 'X', (t) => {
      t.checkUndo(1, () => {
        t.apply(0, Side.RIGHT);
      });
    });

    doTest2('y_X', 'X', 'X_z', (t) => {
      t.checkUndo(1, () => {
        t.apply(0, Side.LEFT);
      });
      t.checkUndo(1, () => {
        t.apply(1, Side.RIGHT);
      });

      t.assertContent('y_X_z');
    });
  });

  it('range modification', () => {
    doTest1('X_x_y_z_Y', 'X_a_b_c_Y', 'X_x_y_z_Y', (t) => {
      t.assertChangeContent(0, 'a_b_c', 1, 4);
      t.checkUndo(1, () => t.replaceText(t.lineCol(2, 0), t.lineCol(2, 1), 'D'));
      t.assertChangeContent(0, 'a_D_c', 1, 4);
    });

    doTest1('X_x_y_z_Y', 'X_a_b_c_Y', 'X_x_y_z_Y', (t) => {
      t.assertChangeContent(0, 'a_b_c', 1, 4);
      t.checkUndo(1, () => t.replaceText(t.lineCol(2, -1), t.lineCol(2, 2), 'D'));
      t.assertChangeContent(0, 'aDc', 1, 2);
    });

    doTest1('X_x_y_z_Y', 'X_a_b_c_Y', 'X_x_y_z_Y', (t) => {
      t.assertChangeContent(0, 'a_b_c', 1, 4);
      t.checkUndo(1, () => t.replaceContent('c', 'u_x'));
      t.assertChangeContent(0, 'a_b_u_x', 1, 5);
    });

    doTest1('X_x_y_z_Y', 'X_a_b_c_Y', 'X_x_y_z_Y', (t) => {
      t.assertChangeContent(0, 'a_b_c', 1, 4);
      t.checkUndo(1, () => t.deleteContent('c_'));
      t.assertChangeContent(0, 'a_b', 1, 3);
    });

    doTest1('X_x_y_z_Y', 'X_a_b_c_Y', 'X_x_y_z_Y', (t) => {
      t.assertChangeContent(0, 'a_b_c', 1, 4);
      t.checkUndo(1, () => t.insertTextBefore('b', 'q'));
      t.assertChangeContent(0, 'a_qb_c', 1, 4);
    });

    doTest1('X_x_y_z_Y', 'X_a_b_c_Y', 'X_x_y_z_Y', (t) => {
      t.assertChangeContent(0, 'a_b_c', 1, 4);
      t.checkUndo(1, () => t.insertTextAfter('b', 'q'));
      t.assertChangeContent(0, 'a_bq_c', 1, 4);
    });

    doTest1('X_x_y_z_Y', 'X_a_b_c_Y', 'X_x_y_z_Y', (t) => {
      t.assertChangeContent(0, 'a_b_c', 1, 4);
      t.checkUndo(1, () => t.insertText(0, 'a_b_c_'));
      t.assertChangeContent(0, 'a_b_c', 4, 7);
    });

    doTest1('A_X_x_y_z_Y', 'A_X_a_b_c_Y', 'A_X_x_y_z_Y', (t) => {
      t.assertChangeContent(0, 'a_b_c', 2, 5);
      t.checkUndo(1, () => t.replaceContent('X_a_b', 'q_w_e'));
      t.assertChangeContent(0, 'c');
    });

    doTest1('X_x_y_z_Y_A', 'X_a_b_c_Y_A', 'X_x_y_z_Y_A', (t) => {
      t.assertChangeContent(0, 'a_b_c');
      t.checkUndo(1, () => t.replaceContent('c_Y', 'q'));
      t.assertChangeContent(0, 'a_b');
    });

    doTest1('A_X_x_Y_A', 'A_X_b_Y_A', 'A_X_x_z_Y_A', (t) => {
      t.assertChangeContent(0, 'b');
      t.checkUndo(1, () => t.replaceContent('X_b_Y', 'q'));

      t.assertChangeContent(0, '', 2, 2);
      t.assertContent('A_q_A');
    });
  });

  it('non-conflicts actions', () => {
    const text1 = [
      '1 ======',
      'insert left',
      '2 ======',
      'remove right',
      '3 ======',
      'new both',
      '4 ======',
      'modify both',
      '5 ======',
      'modify',
      '6 ======',
      '7 ======',
      '8 ======',
    ].join('\n');
    const text2 = [
      '1 ======',
      '2 ======',
      'remove right',
      '3 ======',
      '4 ======',
      'modify',
      '5 ======',
      'modify',
      '6 ======',
      '7 ======',
      'delete modify',
      '8 ======',
    ].join('\n');
    const text3 = [
      '1 ======',
      '2 ======',
      '3 ======',
      'new both',
      '4 ======',
      'modify both',
      '5 ======',
      'modify right',
      '6 ======',
      '7 ======',
      'modify',
      '8 ======',
    ].join('\n');

    doTestN(text1, text2, text3, (t) => {
      t.checkUndo(1, () => {
        t.runApplyNonConflictsAction(ThreeSide.BASE);
      });

      t.assertChangesCount(1);
      t.assertContent(
        [
          '1 ======',
          'insert left',
          '2 ======',
          '3 ======',
          'new both',
          '4 ======',
          'modify both',
          '5 ======',
          'modify right',
          '6 ======',
          '7 ======',
          'delete modify',
          '8 ======',
        ].join('\n')
      );
    });

    doTestN(text1, text2, text3, (t) => {
      t.checkUndo(1, () => {
        t.runApplyNonConflictsAction(ThreeSide.LEFT);
      });

      t.assertChangesCount(3);
      t.assertContent(
        [
          '1 ======',
          'insert left',
          '2 ======',
          'remove right',
          '3 ======',
          'new both',
          '4 ======',
          'modify both',
          '5 ======',
          'modify',
          '6 ======',
          '7 ======',
          'delete modify',
          '8 ======',
        ].join('\n')
      );
    });

    doTestN(text1, text2, text3, (t) => {
      t.checkUndo(1, () => {
        t.runApplyNonConflictsAction(ThreeSide.RIGHT);
      });

      t.assertChangesCount(2);
      t.assertContent(
        [
          '1 ======',
          '2 ======',
          '3 ======',
          'new both',
          '4 ======',
          'modify both',
          '5 ======',
          'modify right',
          '6 ======',
          '7 ======',
          'delete modify',
          '8 ======',
        ].join('\n')
      );
    });

    doTestN(text1, text2, text3, (t) => {
      t.replaceText(t.lineCol(5, 0), t.lineCol(5, 0), 'USER ');

      t.checkUndo(1, () => {
        t.runApplyNonConflictsAction(ThreeSide.BASE);
      });

      t.assertChangesCount(2);
      t.assertContent(
        [
          '1 ======',
          'insert left',
          '2 ======',
          '3 ======',
          'new both',
          '4 ======',
          'USER modify',
          '5 ======',
          'modify right',
          '6 ======',
          '7 ======',
          'delete modify',
          '8 ======',
        ].join('\n')
      );
    });

    doTestN(text1, text2, text3, (t) => {
      t.replaceText(t.lineCol(7, 0), t.lineCol(7, 0), 'USER ');

      t.checkUndo(1, () => {
        t.runApplyNonConflictsAction(ThreeSide.RIGHT);
      });

      t.assertChangesCount(3);
      t.assertContent(
        [
          '1 ======',
          '2 ======',
          '3 ======',
          'new both',
          '4 ======',
          'modify both',
          '5 ======',
          'USER modify',
          '6 ======',
          '7 ======',
          'delete modify',
          '8 ======',
        ].join('\n')
      );
    });
  });

  it('no conflicts', () => {
    doTest2('a_Ins1_b_ccc', 'a_b_ccc', 'a_b_dddd', (t) => {
      t.assertRange6(0, 1, 2, 1, 1, 1, 1);
      t.assertRange6(1, 3, 4, 2, 3, 2, 3);

      t.apply(0, Side.LEFT);
      t.assertRange6(0, 1, 2, 1, 2, 1, 1);
      t.assertRange6(1, 3, 4, 3, 4, 2, 3);
      t.assertContent('a_Ins1_b_ccc');

      t.runApplyNonConflictsAction(ThreeSide.BASE);
      t.assertRange6(0, 1, 2, 1, 2, 1, 1);
      t.assertRange6(1, 3, 4, 3, 4, 2, 3);
      t.assertContent('a_Ins1_b_dddd');

      t.assertResolved(0, 'BOTH');
      t.assertResolved(1, 'BOTH');
    });
  });

  it('conflicting change', () => {
    doTest(
      '1_2_3_X_a_b_c_Y_Ver1_Ver12_Z',
      'X_a_b_c_Y_' + 'Ver12_Ver23_Z',
      'X_' + 'Y_' + 'Ver23_Ver3_Z',
      3,
      ComparisonPolicy.DEFAULT,
      (t) => {
        t.assertType(0, INSERTED);
        t.assertType(1, DELETED);
        t.assertType(2, CONFLICT);

        t.runApplyNonConflictsAction(ThreeSide.BASE);
        t.assertResolved(0, 'BOTH');
        t.assertResolved(1, 'BOTH');
        t.assertResolved(2, 'NONE');

        t.assertContent('1_2_3_X_Y_Ver12_Ver23_Z');
      }
    );
  });

  it('apply merge then undo', () => {
    doTest1('X_b_Y', 'X_1_2_3_Y', 'X_a_Y', (t) => {
      t.assertRange6(0, 1, 2, 1, 4, 1, 2);

      t.apply(0, Side.RIGHT);
      t.assertRange6(0, 1, 2, 1, 2, 1, 2);
      t.assertChangeContent(0, 'a');

      t.checkUndo(1, () => {
        t.apply(0, Side.LEFT);
        t.assertRange6(0, 1, 2, 1, 3, 1, 2);
        t.assertChangeContent(0, 'a_b');
      });

      t.assertContent('X_a_b_Y');
    });
  });

  it('apply modified-deleted conflict', () => {
    doTest1('X_Y', 'X_1_2_3_Y', 'X_a_Y', (t) => {
      t.assertRange6(0, 1, 1, 1, 4, 1, 2);
      t.assertChangeContent(0, '1_2_3');

      t.runApplyNonConflictsAction(ThreeSide.BASE);
      t.assertResolved(0, 'NONE');

      t.apply(0, Side.RIGHT);
      t.assertRange6(0, 1, 1, 1, 2, 1, 2);
      t.assertResolved(0, 'BOTH');

      t.assertContent('X_a_Y');
    });
  });

  it('invalidating change', () => {
    doTest1('X_1_2_Y', 'X_1_Ins_2_Y', 'X_1_2_Y', (t) => {
      t.assertType(0, DELETED);
      t.assertRange6(0, 2, 2, 2, 3, 2, 2);

      t.deleteContent('1_Ins_2_');
      t.assertResolved(0, 'BOTH');
      t.assertRange6(0, 2, 2, 2, 2, 2, 2);
    });
  });

  it('apply several actions', () => {
    doTest(
      'X_1_Y_2_Z_3_4_U_W_',
      'X_a_Y_b_Z_c_U_d_W_',
      'X_a_Y_B_Z_C_U_D_W_',
      4,
      ComparisonPolicy.DEFAULT,
      (t) => {
        t.assertType(0, MODIFIED);
        t.assertType(1, CONFLICT);
        t.assertType(2, CONFLICT);
        t.assertType(3, CONFLICT);

        t.apply(0, Side.LEFT);
        t.assertResolved(0, 'BOTH');

        t.apply(3, Side.RIGHT);
        t.assertResolved(3, 'BOTH');
        t.assertContent('X_1_Y_b_Z_c_U_D_W_');

        t.apply(1, Side.RIGHT);
        t.assertResolved(1, 'RIGHT');
        t.assertContent('X_1_Y_B_Z_c_U_D_W_');

        t.apply(1, Side.LEFT);
        t.apply(2, Side.LEFT);
        t.apply(2, Side.RIGHT);
        t.assertResolved(1, 'BOTH');
        t.assertResolved(2, 'BOTH');
        t.assertContent('X_1_Y_B_2_Z_3_4_C_U_D_W_');
      }
    );
  });

  it('ignore change action', () => {
    doTest2('X_1_Y_2_Z', 'X_a_Y_b_Z', 'X_a_Y_B_Z', (t) => {
      t.assertType(0, MODIFIED);
      t.assertType(1, CONFLICT);

      t.ignore(0, Side.LEFT);
      t.assertRange6(0, 1, 2, 1, 2, 1, 2);
      t.assertContent('X_a_Y_b_Z');

      t.ignore(0, Side.RIGHT);
      t.assertResolved(0, 'BOTH');
      t.assertRange6(0, 1, 2, 1, 2, 1, 2);
      t.assertContent('X_a_Y_b_Z');
    });
  });

  it('long base', () => {
    doTest1('X_1_2_3_Z', 'X_1_b_3_d_e_f_Z', 'X_a_b_c_Z', (t) => {
      t.assertType(0, CONFLICT);
      t.assertRange6(0, 1, 4, 1, 7, 1, 4);
    });
  });

  it('replace base with branch', () => {
    doTest2('a_X_b_c', 'A_X_B_c', '1_X_1_c', (t) => {
      t.assertType(0, CONFLICT);
      t.assertType(1, CONFLICT);

      t.apply(0, Side.LEFT);
      t.assertContent('a_X_B_c');

      t.replaceContent('a_X_B_c', 'a_X_b_c');

      t.assertRange6(0, 0, 1, 0, 1, 0, 1);
      t.assertRange6(1, 2, 3, 2, 3, 2, 3);
    });
  });

  it('error 1', () => {
    doTestN(
      'start_change_ a_ b',
      'start_CHANGE_   a_   b',
      '    }_    return new DiffFragment(notEmptyContent(buffer1), notEmptyContent(buffer2));_  }',
      () => {}
    );
  });

  it('error 2', () => {
    doTest1('C_X', 'C_', 'C_', (t) => {
      t.assertRange6(0, 1, 2, 1, 2, 1, 2);
    });
  });

  it('error 3', () => {
    doTestN(
      'original_local_local_local_original_',
      'original_original_original_original_original_',
      'original_remote_remote_remote_original_',
      () => {}
    );
  });

  it('ignored', () => {
    doTest(' x_new_y_z', 'x_ y _z', 'x_y _new_ z', 5, ComparisonPolicy.IGNORE_WHITESPACES, (t) => {
      t.assertRange6(0, 0, 1, 0, 1, 0, 1);
      t.assertRange6(1, 1, 2, 1, 1, 1, 1);
      t.assertRange6(2, 2, 3, 1, 2, 1, 2);
      t.assertRange6(3, 3, 3, 2, 2, 2, 3);
      t.assertRange6(4, 3, 4, 2, 3, 3, 4);

      t.assertType(0, MODIFIED, 'LEFT');
      t.assertType(1, INSERTED, 'LEFT');
      t.assertType(2, MODIFIED, 'BOTH');
      t.assertType(3, INSERTED, 'RIGHT');
      t.assertType(4, MODIFIED, 'RIGHT');

      t.checkUndo(1, () => {
        t.runApplyNonConflictsAction(ThreeSide.BASE);
      });
      t.assertContent(' x_new_y_new_ z');

      t.assertResolved(0, 'BOTH');
      t.assertResolved(1, 'BOTH');
      t.assertResolved(2, 'BOTH');
      t.assertResolved(3, 'BOTH');
      t.assertResolved(4, 'BOTH');

      t.undo(1);

      t.apply(1, Side.RIGHT);
      t.apply(2, Side.RIGHT);

      t.checkUndo(1, () => {
        t.runApplyNonConflictsAction(ThreeSide.BASE);
      });

      t.assertContent(' x_y _new_ z');
    });

    doTest(
      ' x_new_y1_z',
      'x_ y _z',
      'x_y2 _new_ z',
      3,
      ComparisonPolicy.IGNORE_WHITESPACES,
      (t) => {
        t.assertRange6(0, 0, 1, 0, 1, 0, 1);
        t.assertRange6(1, 1, 3, 1, 2, 1, 3);
        t.assertRange6(2, 3, 4, 2, 3, 3, 4);

        t.assertType(0, MODIFIED, 'LEFT');
        t.assertType(1, CONFLICT, 'BOTH');
        t.assertType(2, MODIFIED, 'RIGHT');

        t.checkUndo(1, () => {
          t.runApplyNonConflictsAction(ThreeSide.BASE);
        });
        t.assertContent(' x_ y _ z');

        t.assertResolved(0, 'BOTH');
        t.assertResolved(1, 'NONE');
        t.assertResolved(2, 'BOTH');
      }
    );

    doTest(' x_new_y_z', 'x_ y _z', 'x_y _new_ z', 1, ComparisonPolicy.DEFAULT, (t) => {
      t.assertRange6(0, 0, 4, 0, 3, 0, 4);
      t.assertType(0, CONFLICT, 'BOTH');

      t.rediff(ComparisonPolicy.IGNORE_WHITESPACES);
      t.assertCantUndo();

      t.assertRange6(0, 0, 1, 0, 1, 0, 1);
      t.assertRange6(1, 1, 2, 1, 1, 1, 1);
      t.assertRange6(2, 2, 3, 1, 2, 1, 2);
      t.assertRange6(3, 3, 3, 2, 2, 2, 3);
      t.assertRange6(4, 3, 4, 2, 3, 3, 4);

      t.checkUndo(1, () => {
        t.runApplyNonConflictsAction(ThreeSide.RIGHT);
      });
      t.assertContent('x_y _new_ z');

      t.assertResolved(0, 'NONE');
      t.assertResolved(1, 'NONE');
      t.assertResolved(2, 'BOTH');
      t.assertResolved(3, 'BOTH');
      t.assertResolved(4, 'BOTH');
    });
  });

  it('reset all', () => {
    function doResetTest1(
      left: string,
      base: string,
      right: string,
      beforeReset: (t: MergeTestBuilder) => void
    ): void {
      doTest1(left, base, right, (t) => {
        beforeReset(t);

        t.resetAll();

        t.assertChangesCount(1);
        t.assertContent(base);
        t.assertResolved(0, 'NONE');
        t.assertRange6(0, 0, 1, 0, 1, 0, 1);
      });
    }

    doResetTest1('a', 'b', 'c', (t) => t.apply(0, Side.LEFT));
    doResetTest1('a', 'b', 'c', (t) => t.apply(0, Side.RIGHT));
    doResetTest1('a', 'b', 'c', (t) => t.ignore(0, Side.LEFT));
    doResetTest1('a', 'b', 'c', (t) => t.ignore(0, Side.RIGHT));

    doResetTest1('a', 'b', 'c', (t) => {
      t.apply(0, Side.LEFT);
      t.apply(0, Side.RIGHT);
    });

    doResetTest1('a', 'b', 'c', (t) => {
      t.ignore(0, Side.LEFT);
      t.ignore(0, Side.RIGHT);
    });

    doResetTest1('a', 'b', 'c', (t) => {
      t.ignore(0, Side.LEFT);
      t.apply(0, Side.RIGHT);
    });

    doResetTest1('a', 'b', 'c', (t) => {
      t.apply(0, Side.LEFT);
      t.ignore(0, Side.RIGHT);
    });

    doResetTest1('y z', 'x y z', 'x y', (t) => {
      t.resolve(0);
    });
  });
});
