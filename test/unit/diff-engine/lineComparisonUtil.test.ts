// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/LineComparisonUtilTest.kt
// Copyright 2000-2020 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import { del, ins, lines, mod, splitter } from './comparisonTestUtil';

describe('diff-engine by-line comparison (LineComparisonUtilTest)', () => {
  it('equal strings', () => {
    for (const text of ['', 'x', 'x_y_z_', '_', ' x_y ']) {
      lines((t) => {
        t.text(text, text);
        t.changesDefault();
        t.testAll();
      });
    }
  });

  it('trivial cases', () => {
    lines((t) => {
      t.text('x_', 'y_');
      t.changesDefault(mod(0, 0, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x', '');
      t.changesDefault(mod(0, 0, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('', 'x');
      t.changesDefault(mod(0, 0, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x', 'y');
      t.changesDefault(mod(0, 0, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x_z', 'y_z');
      t.changesDefault(mod(0, 0, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('z_x', 'z_y');
      t.changesDefault(mod(1, 1, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x', 'x_');
      t.changesDefault(ins(1, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x_', 'x');
      t.changesDefault(del(1, 1, 1));
      t.testAll();
    });
  });

  it('simple cases', () => {
    lines((t) => {
      t.text('x_', 'x_z');
      t.changesDefault(mod(1, 1, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x_y', 'n_m');
      t.changesDefault(mod(0, 0, 2, 2));
      t.testAll();
    });

    lines((t) => {
      t.text('x_y_z', 'n_y_m');
      t.changesDefault(mod(0, 0, 1, 1), mod(2, 2, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x_y_z', 'n_k_y');
      t.changesDefault(mod(0, 0, 1, 2), del(2, 3, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x_y_z', 'y');
      t.changesDefault(del(0, 0, 1), del(2, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('a_b_x', 'x_m_n');
      t.changesDefault(del(0, 0, 2), ins(3, 1, 2));
      t.testAll();
    });
  });

  it('empty last line', () => {
    lines((t) => {
      t.text('x_', '');
      t.changesDefault(del(0, 0, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('', 'x_');
      t.changesDefault(ins(0, 0, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x_', 'x');
      t.changesDefault(del(1, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text('x_', 'x_z ');
      t.changesDefault(mod(1, 1, 1, 1));
      t.testAll();
    });
  });

  it('whitespace-only changes', () => {
    lines((t) => {
      t.text('x ', ' x');
      t.changesDefault(mod(0, 0, 1, 1));
      t.changesTrim();
      t.testAll();
    });

    lines((t) => {
      t.text('x \t', '\t x');
      t.changesDefault(mod(0, 0, 1, 1));
      t.changesTrim();
      t.testAll();
    });

    lines((t) => {
      t.text('x_', 'x ');
      t.changesDefault(mod(0, 0, 2, 1));
      t.changesTrim(del(1, 1, 1));
      t.testAll();
    });

    lines((t) => {
      t.text(' x_y ', 'x _ y');
      t.changesDefault(mod(0, 0, 2, 2));
      t.changesTrim();
      t.testAll();
    });

    lines((t) => {
      t.text('x y ', 'x  y');
      t.changesDefault(mod(0, 0, 1, 1));
      t.changesIgnore();
      t.testAll();
    });

    lines((t) => {
      t.text('x y_x y_x y', '  x y  _x y  _x   y');
      t.changesDefault(mod(0, 0, 3, 3));
      t.changesTrim(mod(2, 2, 1, 1));
      t.changesIgnore();
      t.testAll();
    });
  });

  it('algorithm specific', () => {
    lines((t) => {
      t.text('x_y_z_AAAAA', 'AAAAA_x_y_z');
      t.changesDefault(del(0, 0, 3), ins(4, 1, 3));
      t.testAll();
    });

    lines((t) => {
      t.text('x_y_z', ' y_ m_ n');
      t.changesDefault(mod(0, 0, 3, 3));
      t.changesTrim(del(0, 0, 1), mod(2, 1, 1, 2));
      t.testAll();
    });

    lines((t) => {
      t.text('}_ }', ' }');
      t.changesDefault(del(0, 0, 1));
      t.testDefault();
    });

    lines((t) => {
      t.text('{_}', '{_ {_ }_}_x');
      t.changesDefault(ins(1, 1, 2), ins(2, 4, 1));
      t.testDefault();
    });
  });

  it('non-deterministic cases', () => {
    lines((t) => {
      t.text('', '__');
      t.changesDefault(ins(1, 1, 2));
      t.testAll();
    });

    lines((t) => {
      t.text('__', '');
      t.changesDefault(del(1, 1, 2));
      t.testAll();
    });
  });

  it('regression: shifted similar lines are matched as a single change, not insertion-deletion', () => {
    lines((t) => {
      t.text(' X_  X', '  X_   X');
      t.matchDefault('--_---', '---_----');
      t.testDefault();
    });
  });

  it('prefer chunks bounded by empty line', () => {
    lines((t) => {
      t.text('A_B_o_o_Y_Z_ _A_B_z_z_Y_Z', 'A_B_o_o_Y_Z_ _A_B_u_u_Y_Z_ _A_B_z_z_Y_Z');
      t.matchDefault(' _ _ _ _ _ _ _ _ _ _ _ _ ', ' _ _ _ _ _ _ _-_-_-_-_-_-_-_ _ _ _ _ _ ');
      t.testAll();
    });

    lines((t) => {
      t.text('A_B_o_o_Y_Z_ _A_B_ _ _Y_Z', 'A_B_o_o_Y_Z_ _A_B_u_u_Y_Z_ _A_B_ _ _Y_Z');
      t.matchDefault(' _ _ _ _ _ _ _ _ _ _ _ _ ', ' _ _ _ _ _ _ _ _ _-_-_-_-_-_-_-_ _ _ _ ');
      t.testAll();
    });

    lines((t) => {
      t.text('A_B_o_o_ _A_B_z_z', 'A_B_o_o_ _A_B_u_u_ _A_B_z_z');
      t.matchDefault(' _ _ _ _ _ _ _ _ ', ' _ _ _ _ _-_-_-_-_-_ _ _ _ ');
      t.testAll();
    });

    lines((t) => {
      t.text('o_o_Y_Z_ _z_z_Y_Z', 'o_o_Y_Z_ _u_u_Y_Z_ _z_z_Y_Z');
      t.matchDefault(' _ _ _ _ _ _ _ _ ', ' _ _ _ _ _-_-_-_-_-_ _ _ _ ');
      t.testAll();
    });
  });

  it('prefer chunks bounded by short line', () => {
    lines((t) => {
      t.text(
        'A====_B====_o====_o====_Y====_Z====_!_A====_B====_z====_z====_Y====_Z====',
        'A====_B====_o====_o====_Y====_Z====_!_A====_B====_u====_u====_Y====_Z====_!_A====_B====_z====_z====_Y====_Z===='
      );
      t.matchDefault(
        '     _     _     _     _     _     _ _     _     _     _     _     _     ',
        '     _     _     _     _     _     _ _-----_-----_-----_-----_-----_-----_-_     _     _     _     _     _     '
      );
      t.testAll();
    });

    lines((t) => {
      t.text(
        'A====_B====_o====_o====_Y====_Z====_ _A====_B====_!_!_Y====_Z====',
        'A====_B====_o====_o====_Y====_Z====_ _A====_B====_u====_u====_Y====_Z====_ _A====_B====_!_!_Y====_Z===='
      );
      t.matchDefault(
        '     _     _     _     _     _     _ _     _     _ _ _     _     ',
        '     _     _     _     _     _     _ _-----_-----_-----_-----_-----_-----_-_     _     _ _ _     _     '
      );
      t.testAll();
    });

    lines((t) => {
      t.text(
        'A====_B====_o====_o====_Y====_Z====_!_A====_B====_ _ _Y====_Z====',
        'A====_B====_o====_o====_Y====_Z====_!_A====_B====_u====_u====_Y====_Z====_!_A====_B====_ _ _Y====_Z===='
      );
      t.matchDefault(
        '     _     _     _     _     _     _ _     _     _ _ _     _     ',
        '     _     _     _     _     _     _ _     _     _-----_-----_-----_-----_-_-----_-----_ _ _     _     '
      );
      t.testAll();
    });
  });

  it('prefer chunks bounded by empty line - using inserted content', () => {
    lines((t) => {
      t.text('e_x_A_B_z', 'x_A_B_ _q_A_B_z');
      t.matchDefault('-_ _ _ _ ', ' _ _ _-_-_-_-_ ');
      t.testAll();
    });
  });

  it('prefer smaller amount of chunks', () => {
    lines((t) => {
      t.text('X_A_X_Y_', 'X_Y_');
      t.matchDefault('-_-_ _ _', ' _ _');
      t.testAll();
    });

    lines((t) => {
      t.text(' __x___y', '__y');
      t.matchDefault('-**-*__ ', '__ ');
      t.changesDefault(del(0, 0, 3));
      t.testAll();
    });

    lines((t) => {
      t.text(
        'U======_X======_Y======_z======_X======_Y======_X======_U======_X======_z======',
        'U======_Y======_X======_U======_X======'
      );
      t.matchDefault(
        '       _-------_-------_-------_-------_       _       _       _       _-------',
        '       _       _       _       _       '
      );
      t.testAll();
    });
  });

  it("regression: can trim chunks after 'compareTwoSteps'", () => {
    lines((t) => {
      t.text('q__7_ 6_ 7', '_7');
      t.matchDefault('-*_ _--*--', '_ ');
      t.testDefault();
    });
  });

  it("regression: can trim chunks after 'optimizeLineChunks'", () => {
    lines((t) => {
      t.text('A=====_ B=====_ }_}_B=====_', 'A=====_ }_}_B=====_');
      t.matchDefault('      _-------_  _ _      _', '      _  _ _      _');
      t.testAll();
    });
  });

  it("bad cases caused by 'compareTwoStep' logic", () => {
    lines((t) => {
      t.text('x_!', '!_x_y');
      t.matchDefault('-_ ', ' _-_-');
      t.testAll();
    });

    lines((t) => {
      t.text('!_x_y', 'x_!');
      t.matchDefault('-_ _-', ' _-');
      t.testAll();
    });

    lines((t) => {
      t.text('x_! ', '!_x_y');
      t.matchDefault('-_--', '-_-_-');
      t.matchTrim('-_  ', ' _-_-');
      t.testAll();
    });

    lines((t) => {
      t.text('!_x_y', 'x_! ');
      t.matchDefault('-_ _-', ' _--');
      t.testAll();
    });

    splitter({}, (t) => {
      t.text('M===_X===_Y===', ' Y===_X===_N');
      t.changesDefault(mod(0, 0, 1, 1), mod(1, 1, 1, 1), mod(2, 2, 1, 1));
      t.testDefault();
    });
  });

  it("bad cases caused by 'compareSmart' logic", () => {
    lines((t) => {
      t.text('A=====_ B=====_ }_}_B=====', 'A=====_ }_}_B=====');
      t.matchDefault('      _-------_  _ _      ', '      _  _ _      ');
      t.matchTrim('      _       _--_-_------', '      _--_-_      ');
      t.testAll();
    });

    lines((t) => {
      t.text('A=====_ B=====_X_ }_}_Z_B=====_', 'A=====_ }_}_B=====_');
      t.matchDefault('      _-------_-_--_-_-_      _', '      _--_-_      _');
      t.testAll();
    });
  });

  it('trim changed blocks after second step correction', () => {
    lines((t) => {
      t.text('====}_==== }_Y_====}', '====}_Y_====}');
      // result after second step correction
      t.matchDefault('     _------_ _     ', '     _ _     ');
      // the result looks strange because of 'diff.unimportant.line.char.count'
      t.matchIgnore('     _      _-_-----', '     _-_     ');
      t.testAll();
    });
  });

  it('second step correction processes all confusing lines', () => {
    lines((t) => {
      t.text('====}_==== }_Y_==== }_====}', '==== }_Y_==== }');
      t.matchDefault('-----_      _ _      _-----', '      _ _      ');
      t.testDefault();
    });
  });

  it('ignore whitespace policy does not apply two-step correction', () => {
    lines((t) => {
      t.text('1_ _  1', '  1');
      t.matchDefault('-_-_   ', '   ');
      t.matchTrim(' _-_---', '   ');
      t.testAll();
    });

    lines((t) => {
      t.text('  1_ _1', '  1');
      t.matchDefault('   _-_-', '   ');
      t.testAll();
    });

    lines((t) => {
      t.text('X_ Y_X', 'Y ');
      t.matchDefault('-_--_-', '--');
      t.matchTrim('-_  _-', '  ');
      t.testAll();
    });
  });

  it('regression: second step correction is performed if there are no ambiguous matchings', () => {
    lines((t) => {
      t.text('}_ }', ' }_}');
      t.matchDefault('-_--', '--_-');
      t.matchTrim(' _  ', '  _ ');
      t.testAll();
    });

    lines((t) => {
      t.text(' }_}_ }', '}_}_}');
      t.matchDefault('--_ _--', '-_ _-');
      t.matchTrim('  _ _  ', ' _ _ ');
      t.testAll();
    });

    lines((t) => {
      t.text('X_X __Y', 'X__Z');
      t.matchDefault(' _--__-', ' __-');
      t.matchTrim('-_  __-', ' __-');
      t.testAll();
    });
  });

  it('regression: second step with too many possible matchings', () => {
    lines((t) => {
      t.text(
        ' X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_ X',
        'X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X_X '
      );
      t.matchDefault(
        '--_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _-_-_-_-_-_--',
        '-_ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _--'
      );
      t.matchTrim(
        '  _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _-_-_-_-_--',
        ' _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _  '
      );
      t.testAll();
    });
  });

  it('regression: second step correction searches for matchings in its prefix', () => {
    lines((t) => {
      t.text('Z_X_Z_X __Y', 'X__Y');
      t.matchDefault('-_ _-_--__ ', ' __ ');
      t.matchTrim('-_-_-_  __ ', ' __ ');
      t.testAll();
    });

    // do not break other IW-matchings during the second step
    lines((t) => {
      t.text('Z_X_K_Z_X __Y', 'K _X__Y');
      t.matchDefault('-_-_-_-_--__ ', '--_-__ ');
      t.matchTrim('-_-_ _-_  __ ', '  _ __ ');
      t.testAll();
    });
  });

  it('regression: multiple similar braces nearby (IDEA-111712)', () => {
    lines((t) => {
      t.text(
        'function fn() {_  return {_    a: 1_  }_}_',
        'function fn() {_  return {_    a: 1_  };_}_'
      );
      t.matchDefault(
        '               _          _        _---_ _',
        '               _          _        _----_ _'
      );
      t.testAll();
    });

    lines((t) => {
      t.text(
        'function fn() {_  return {_    a: 1_  }_}_',
        'function fn() {_  return {_    a: 1_  }_};_'
      );
      t.matchDefault(
        '               _          _        _   _-_',
        '               _          _        _   _--_'
      );
      t.testAll();
    });
  });
});
