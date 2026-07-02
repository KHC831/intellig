// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/SplitComparisonUtilTest.kt
// Copyright 2000-2015 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import { del, ins, mod, splitter } from './comparisonTestUtil';

describe('diff-engine changed-block splitting (SplitComparisonUtilTest)', () => {
  it('splitter', () => {
    splitter({}, (t) => {
      t.text('x', 'z');
      t.changesDefault(mod(0, 0, 1, 1));
      t.testAll();
    });

    splitter({}, (t) => {
      t.text('x_y', 'a_b');
      t.changesDefault(mod(0, 0, 2, 2));
      t.testAll();
    });

    splitter({}, (t) => {
      t.text('x_y', 'a_b y');
      t.changesDefault(mod(0, 0, 1, 1), mod(1, 1, 1, 1));
      t.testAll();
    });

    splitter({}, (t) => {
      t.text('x y', 'x a_b y');
      t.changesDefault(mod(0, 0, 1, 2));
      t.testAll();
    });

    splitter({}, (t) => {
      t.text('x_y', 'x a_y b');
      t.changesDefault(mod(0, 0, 1, 1), mod(1, 1, 1, 1));
      t.testAll();
    });

    splitter({}, (t) => {
      t.text('x_', 'x a_...');
      t.changesDefault(mod(0, 0, 2, 2));
      t.testAll();
    });

    splitter({}, (t) => {
      t.text('x_y_', 'a_b_');
      t.changesDefault(mod(0, 0, 2, 2));
      t.testAll();
    });

    splitter({}, (t) => {
      t.text('x_y', ' x _ y ');
      t.changesDefault(mod(0, 0, 2, 2));
      t.testDefault();
    });

    splitter({}, (t) => {
      t.text('x_y', ' x _ y.');
      t.changesDefault(mod(0, 0, 1, 1), mod(1, 1, 1, 1));
      t.testDefault();
    });

    splitter({}, (t) => {
      t.text('a_x_b_', ' x_');
      t.changesDefault(del(0, 0, 1), mod(1, 0, 1, 1), del(2, 1, 1));
      t.testDefault();
    });

    splitter({}, (t) => {
      t.text('a_x_b_', '!x_');
      t.changesDefault(del(0, 0, 1), mod(1, 0, 1, 1), del(2, 1, 1));
      t.testAll();
    });

    splitter({ trim: false }, (t) => {
      t.text('< i', '<i<_i');
      t.changesDefault(mod(0, 0, 1, 2));
      t.testDefault();
    });

    splitter({ trim: false }, (t) => {
      t.text('.l j', 'U_._l j+');
      t.changesDefault(ins(0, 0, 2), mod(0, 2, 1, 1));
      t.testDefault();
    });

    splitter({}, (t) => {
      t.text('      run();', '      //commentary_      while(run(true));');
      t.changesDefault(mod(0, 0, 1, 2));
      t.testDefault();
    });
  });

  it('squash', () => {
    splitter({ squash: true }, (t) => {
      t.text('x', 'z');
      t.changesDefault(mod(0, 0, 1, 1));
      t.testAll();
    });

    splitter({ squash: true }, (t) => {
      t.text('x_y', 'a_b');
      t.changesDefault(mod(0, 0, 2, 2));
      t.testAll();
    });

    splitter({ squash: true }, (t) => {
      t.text('x_y', 'a_b y');
      t.changesDefault(mod(0, 0, 2, 2));
      t.testAll();
    });

    splitter({ squash: true }, (t) => {
      t.text('a_x_b_', ' x_');
      t.changesDefault(mod(0, 0, 3, 1));
      t.testDefault();
    });

    splitter({ squash: true }, (t) => {
      t.text('a_x_b_', '!x_');
      t.changesDefault(mod(0, 0, 3, 1));
      t.testAll();
    });
  });

  it('trim', () => {
    splitter({ trim: true }, (t) => {
      t.text('_', '     _    ');
      t.changesDefault(mod(0, 0, 2, 2));
      t.changesTrim();
      t.testAll();
    });

    splitter({ trim: true }, (t) => {
      t.text('', '     _    ');
      t.changesDefault(mod(0, 0, 1, 2));
      t.changesTrim(ins(1, 1, 1));
      t.changesIgnore();
      t.testAll();
    });

    splitter({ trim: true }, (t) => {
      t.text('     _    ', '');
      t.changesDefault(mod(0, 0, 2, 1));
      t.changesTrim(del(1, 1, 1));
      t.changesIgnore();
      t.testAll();
    });

    splitter({ trim: true }, (t) => {
      t.text('x_y', 'z_ ');
      t.changesDefault(mod(0, 0, 2, 2));
      t.testAll();
    });

    splitter({ trim: true }, (t) => {
      t.text('z', 'z_ ');
      t.changesDefault(ins(1, 1, 1));
      t.changesIgnore();
      t.testAll();
    });

    splitter({ trim: true }, (t) => {
      t.text('z_ x', 'z_ w');
      t.changesDefault(mod(1, 1, 1, 1));
      t.testAll();
    });

    splitter({ trim: true }, (t) => {
      t.text('__z__', 'z');
      t.changesDefault(del(0, 0, 2), del(3, 1, 2));
      t.changesIgnore();
      t.testAll();
    });
  });
});
