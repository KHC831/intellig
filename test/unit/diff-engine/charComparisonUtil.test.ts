// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/CharComparisonUtilTest.kt
// Copyright 2000-2015 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import { chars, charsRaw, charsSmart, del, ins } from './comparisonTestUtil';

const CH_SMILE = String.fromCodePoint(0x1f602);
const CH_GUN = String.fromCodePoint(0x1f52b);
const CH_MAN = String.fromCodePoint(0x1f9d2);
const CH_FACE = String.fromCodePoint(0x1f92b);

describe('diff-engine by-char comparison (CharComparisonUtilTest)', () => {
  it('equal strings', () => {
    chars((t) => {
      t.text('', '');
      t.matchDefault('', '');
      t.testAll();
    });

    chars((t) => {
      t.text('x', 'x');
      t.matchDefault(' ', ' ');
      t.testAll();
    });

    chars((t) => {
      t.text('x_y_z_', 'x_y_z_');
      t.matchDefault('      ', '      ');
      t.testAll();
    });

    chars((t) => {
      t.text('_', '_');
      t.matchDefault(' ', ' ');
      t.testAll();
    });

    chars((t) => {
      t.text('xxx', 'xxx');
      t.matchDefault('   ', '   ');
      t.testAll();
    });

    chars((t) => {
      t.text('xyz', 'xyz');
      t.matchDefault('   ', '   ');
      t.testAll();
    });

    chars((t) => {
      t.text('.x!', '.x!');
      t.matchDefault('   ', '   ');
      t.testAll();
    });
  });

  it('trivial cases', () => {
    chars((t) => {
      t.text('x', '');
      t.matchDefault('-', '');
      t.testAll();
    });

    chars((t) => {
      t.text('', 'x');
      t.matchDefault('', '-');
      t.testAll();
    });

    chars((t) => {
      t.text('x', 'y');
      t.matchDefault('-', '-');
      t.testAll();
    });

    chars((t) => {
      t.text('x_', '');
      t.matchDefault('--', '');
      t.matchTrim('- ', '');
      t.testAll();
    });

    chars((t) => {
      t.text('', 'x_');
      t.matchDefault('', '--');
      t.matchTrim('', '- ');
      t.testAll();
    });

    chars((t) => {
      t.text('x_', 'y_');
      t.matchDefault('- ', '- ');
      t.testAll();
    });

    chars((t) => {
      t.text('_x', '_y');
      t.matchDefault(' -', ' -');
      t.testAll();
    });
  });

  it('simple cases', () => {
    chars((t) => {
      t.text('xyx', 'xxx');
      t.matchDefault(' - ', ' - ');
      t.testAll();
    });

    chars((t) => {
      t.text('xyyx', 'xmx');
      t.matchDefault(' -- ', ' - ');
      t.testAll();
    });

    chars((t) => {
      t.text('xyy', 'yyx');
      t.matchDefault('-  ', '  -');
      t.testAll();
    });

    chars((t) => {
      t.text('x!!', '!!x');
      t.matchDefault('-  ', '  -');
      t.testAll();
    });

    chars((t) => {
      t.text('xyx', 'xx');
      t.matchDefault(' - ', '  ');
      t.testAll();
    });

    chars((t) => {
      t.text('xx', 'xyx');
      t.matchDefault('  ', ' - ');
      t.testAll();
    });

    chars((t) => {
      t.text('!...', '...!');
      t.matchDefault('-   ', '   -');
      t.testAll();
    });
  });

  it('whitespace changes only', () => {
    chars((t) => {
      t.text(' x y z ', 'xyz');
      t.matchDefault('- - - -', '   ');
      t.matchTrim('  - -  ', '   ');
      t.matchIgnore('       ', '   ');
      t.testAll();
    });

    chars((t) => {
      t.text('xyz', ' x y z ');
      t.matchDefault('   ', '- - - -');
      t.matchTrim('   ', '  - -  ');
      t.matchIgnore('   ', '       ');
      t.testAll();
    });

    chars((t) => {
      t.text('x ', 'x');
      t.matchDefault(' -', ' ');
      t.matchTrim('  ', ' ');
      t.testAll();
    });

    chars((t) => {
      t.text('x', ' x');
      t.matchDefault(' ', '- ');
      t.matchTrim(' ', '  ');
      t.testAll();
    });

    chars((t) => {
      t.text(' x ', 'x');
      t.matchDefault('- -', ' ');
      t.matchTrim('   ', ' ');
      t.testAll();
    });

    chars((t) => {
      t.text('x', ' x ');
      t.matchDefault(' ', '- -');
      t.matchTrim(' ', '   ');
      t.testAll();
    });
  });

  it('whitespace changes', () => {
    chars((t) => {
      t.text(' x ', 'z');
      t.matchDefault('---', '-');
      t.matchTrim(' - ', '-');
      t.testAll();
    });

    chars((t) => {
      t.text('x', ' z ');
      t.matchDefault('-', '---');
      t.matchTrim('-', ' - ');
      t.testAll();
    });

    chars((t) => {
      t.text(' x', 'z\t');
      t.matchDefault('--', '-.-');
      t.matchTrim(' -', '-. ');
      t.testAll();
    });

    chars((t) => {
      t.text('x ', '\tz');
      t.matchDefault('--', '.--');
      t.matchTrim('- ', '. -');
      t.testAll();
    });

    chars((t) => {
      t.text('x y z', 'xy_z');
      t.matchDefault(' - - ', '  - ');
      t.matchTrim(' - - ', '    ');
      t.matchIgnore('     ', '    ');
      t.testAll();
    });

    chars((t) => {
      t.text('x y _ z', 'xy_z');
      t.matchDefault(' - -. - ', '  .  ');
      t.matchTrim(' -  .   ', '  .  ');
      t.matchIgnore('    .   ', '  .  ');
      t.testAll();
    });
  });

  it('ignore inner whitespaces', () => {
    chars((t) => {
      t.text('x z y', 'xmn');
      t.matchDefault(' ----', ' --');
      t.matchIgnore('  ---', ' --');
      t.testAll();
    });

    chars((t) => {
      t.text('x y z ', 'x y m ');
      t.matchDefault('    - ', '    - ');
      t.testAll();
    });

    chars((t) => {
      t.text('x y z', 'x y m ');
      t.matchDefault('    -', '    --');
      t.matchTrim('    -', '    - ');
      t.testAll();
    });

    chars((t) => {
      t.text(' x y z', ' m y z');
      t.matchDefault(' -    ', ' -    ');
      t.testAll();
    });

    chars((t) => {
      t.text('x y z', ' m y z');
      t.matchDefault('-    ', '--    ');
      t.matchTrim('-    ', ' -    ');
      t.testAll();
    });

    chars((t) => {
      t.text('x y z', 'x m z');
      t.matchDefault('  -  ', '  -  ');
      t.testAll();
    });

    chars((t) => {
      t.text('x y z', 'x  z');
      t.matchDefault('  -  ', '    ');
      t.testAll();
    });

    chars((t) => {
      t.text('x  z', 'x m z');
      t.matchDefault('    ', '  -  ');
      t.testAll();
    });

    chars((t) => {
      t.text('x  z', 'x n m z');
      t.matchDefault('    ', '  ---  ');
      t.testAll();
    });
  });

  it('empty range positions', () => {
    chars((t) => {
      t.text('x y', 'x zy');
      t.changesDefault(ins(2, 2, 1));
      t.testAll();
    });

    chars((t) => {
      t.text('x y', 'xz y');
      t.changesDefault(ins(1, 1, 1));
      t.testAll();
    });

    chars((t) => {
      t.text('x y z', 'x  z');
      t.changesDefault(del(2, 2, 1));
      t.testAll();
    });

    chars((t) => {
      t.text('x  z', 'x m z');
      t.changesDefault(ins(2, 2, 1));
      t.testAll();
    });

    chars((t) => {
      t.text('xyx', 'xx');
      t.changesDefault(del(1, 1, 1));
      t.testAll();
    });

    chars((t) => {
      t.text('xx', 'xyx');
      t.changesDefault(ins(1, 1, 1));
      t.testAll();
    });

    chars((t) => {
      t.text('xy', 'x');
      t.changesDefault(del(1, 1, 1));
      t.testAll();
    });

    chars((t) => {
      t.text('x', 'xy');
      t.changesDefault(ins(1, 1, 1));
      t.testAll();
    });
  });

  it('algorithm specific', () => {
    // This is a strange example: "ignore whitespace" produces a lesser matching than
    // "Default". This is fine, as the main goal of "ignore whitespaces" is to reduce the
    // 'noise' of the diff, and 1 change is better than 3 changes. So we actually
    // "ignore" whitespaces during comparison, rather than "mark all whitespaces as
    // matched".
    chars((t) => {
      t.text('x   y   z', 'xX      Zz');
      t.matchDefault('    -    ', ' -      - ');
      t.matchIgnore('    -    ', ' -------- ');
      t.testAll();
    });
  });

  it('non-deterministic cases', () => {
    chars((t) => {
      t.text('x', '  ');
      t.changesIgnore(del(0, 0, 1));
      t.testIgnore();
    });

    chars((t) => {
      t.text('  ', 'x');
      t.changesIgnore(ins(0, 0, 1));
      t.testIgnore();
    });

    chars((t) => {
      t.text('x .. z', 'x y .. z');
      t.matchDefault('      ', '  --    ');
      t.matchIgnore('      ', '  -     ');
      t.changesDefault(ins(2, 2, 2));
      t.changesIgnore(ins(2, 2, 1));
      t.testAll();
    });

    chars((t) => {
      t.text(' x _ y _ z ', 'x z');
      t.matchDefault('-  ------ -', '   ');
      t.matchTrim('     -     ', '   ');
      t.changesDefault(del(0, 0, 1), del(3, 2, 6), del(10, 3, 1));
      t.changesTrim(del(5, 2, 1));
      t.testAll();
    });

    chars((t) => {
      t.text('x z', ' x _ y _ z ');
      t.matchDefault('   ', '-  ------ -');
      t.matchTrim('   ', '     -     ');
      t.changesDefault(ins(0, 0, 1), ins(2, 3, 6), ins(3, 10, 1));
      t.changesTrim(ins(2, 5, 1));
      t.testAll();
    });
  });

  it('two steps', () => {
    charsSmart((t) => {
      t.text('  a', 'a  ');
      t.matchDefault('-- ', ' --');
      t.testDefault();
    });

    charsRaw((t) => {
      t.text('  a', 'a  ');
      t.matchDefault('  -', '-  ');
      t.testDefault();
    });

    charsSmart((t) => {
      t.text('bba', 'abb');
      t.matchDefault('  -', '-  ');
      t.testDefault();
    });

    charsRaw((t) => {
      t.text('bba', 'abb');
      t.matchDefault('  -', '-  ');
      t.testDefault();
    });

    charsSmart((t) => {
      t.text(`${CH_SMILE}${CH_FACE} ${CH_MAN}`, ` ${CH_GUN}${CH_FACE}${CH_MAN} `);
      t.matchDefault('--  -  ', '---    -');
      t.testDefault();
    });

    charsRaw((t) => {
      t.text(`${CH_SMILE}${CH_FACE} ${CH_MAN}`, ` ${CH_GUN}${CH_FACE}${CH_MAN} `);
      t.matchDefault('--   --', '---  -- ');
      t.testDefault();
    });
  });

  it('high surrogates', () => {
    chars((t) => {
      t.text(CH_SMILE, CH_SMILE);
      t.matchDefault('  ', '  ');
      t.testAll();
    });

    chars((t) => {
      t.text(CH_SMILE, CH_MAN);
      t.matchDefault('--', '--');
      t.testAll();
    });

    chars((t) => {
      t.text(CH_SMILE, CH_GUN);
      t.matchDefault('--', '--');
      t.testAll();
    });

    chars((t) => {
      t.text(CH_FACE, CH_GUN);
      t.matchDefault('--', '--');
      t.testAll();
    });

    chars((t) => {
      t.text(`${CH_SMILE}${CH_GUN}${CH_MAN}${CH_FACE}`, `${CH_GUN}${CH_MAN}${CH_FACE}${CH_SMILE}`);
      t.matchDefault('--      ', '      --');
      t.testAll();
    });

    chars((t) => {
      t.text(`${CH_SMILE} `, CH_GUN);
      t.matchDefault('---', '--');
      t.matchTrim('-- ', '--');
      t.testAll();
    });

    chars((t) => {
      t.text(` ${CH_SMILE}${CH_FACE} ${CH_MAN}`, `${CH_GUN}${CH_FACE}${CH_MAN}`);
      t.matchDefault('---  -  ', '--    ');
      t.matchTrim(' --  -  ', '--    ');
      t.matchIgnore(' --     ', '--    ');
      t.testAll();
    });
  });
});
