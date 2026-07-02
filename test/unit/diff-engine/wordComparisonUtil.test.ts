// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/WordComparisonUtilTest.kt
// Copyright 2000-2015 JetBrains s.r.o. Apache 2.0 license.
//
// The linesInner lane currently exercises only the by-word half of the upstream
// lines_inner tests (see comparisonTestUtil.ts).

import '../../setup';
import { del, linesInner, words } from './comparisonTestUtil';

const CH_SMILE = String.fromCodePoint(0x1f602);
const CH_GUN = String.fromCodePoint(0x1f52b);
const CH_MAN = String.fromCodePoint(0x1f9d2);
const CH_FACE = String.fromCodePoint(0x1f92b);

describe('diff-engine by-word comparison (WordComparisonUtilTest)', () => {
  it('simple cases', () => {
    linesInner((t) => {
      t.text('x z', 'y z');
      t.matchDefault('-  ', '-  ');
      t.testAll();
    });

    linesInner((t) => {
      t.text(' x z', 'y z');
      t.matchDefault('--  ', '-  ');
      t.matchTrim(' -  ', '-  ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x z ', 'y z');
      t.matchDefault('-  -', '-  ');
      t.matchTrim('-   ', '-  ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x z', ' y z ');
      t.matchDefault('-  ', '--  -');
      t.matchTrim('-  ', ' -   ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x y', 'x z ');
      t.matchDefault('  -', '  --');
      t.matchTrim('  -', '  - ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x,y', 'x');
      t.matchDefault(' --', ' ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x,y', 'y');
      t.matchDefault('-- ', ' ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('.x=', '.!=');
      t.matchDefault(' - ', ' - ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('X xyz1 Z', 'X xyz2 Z');
      t.matchDefault('  ----  ', '  ----  ');
      t.testAll();
    });
  });

  it('punctuation', () => {
    linesInner((t) => {
      t.text(' x.z.x ', 'x..x');
      t.matchDefault('-  -  -', '    ');
      t.matchTrim('   -   ', '    ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x..x', ' x.z.x ');
      t.matchDefault('    ', '-  -  -');
      t.matchTrim('    ', '   -   ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x ... z', 'y ... z');
      t.matchDefault('-      ', '-      ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x ... z', 'x ... y');
      t.matchDefault('      -', '      -');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x ,... z', 'x ... y');
      t.matchDefault('  -    -', '      -');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x . , .. z', 'x ... y');
      t.matchDefault('   ---   -', '      -');
      t.matchIgnore('    -    -', '      -');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x==y==z', 'x====z');
      t.matchDefault('   -   ', '      ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x====z', 'x==t==z');
      t.matchDefault('      ', '   -   ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('X Y ) {_ A B C', 'X Y Z ) {_ y B C ) {');
      t.matchDefault('         -    ', '   --      -    ----');
      t.matchIgnore('         -    ', '    -      -     ---');
      t.testAll();
    });

    words((t) => {
      t.text('@Deprecated @NotNull', '@NotNull');
      t.matchDefault(' ------------       ', '        ');
      t.testAll();
    });

    words((t) => {
      t.text('@Deprecated_ @NotNull', '@NotNull');
      t.matchDefault(' -------------       ', '        ');
      t.testAll();
    });
  });

  it('old diff bug', () => {
    linesInner((t) => {
      t.text("x'y'>", "x'>");
      t.matchDefault('  -- ', '   ');
      t.testAll();
    });

    linesInner((t) => {
      t.text("x'>", "x'y'>");
      t.matchDefault('   ', '  -- ');
      t.testAll();
    });
  });

  it('whitespace-only changes', () => {
    linesInner((t) => {
      t.text('x  =z', 'x=  z');
      t.matchDefault(' --  ', '  -- ');
      t.testDefault();
      t.testTrim();
    });

    linesInner((t) => {
      t.text('x  =', 'x=  z');
      t.matchDefault(' -- ', '  ---');
      t.matchIgnore('    ', '    -');
      t.testAll();
    });
  });

  it('newlines', () => {
    linesInner((t) => {
      t.text(' x _ y _ z ', 'x z');
      t.matchDefault('- ------  -', '   ');
      t.matchTrim('     -     ', '   ');
      t.matchIgnore('     -     ', '   ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x z', ' x _ y _ z ');
      t.matchDefault('   ', '- ------  -');
      t.matchTrim('   ', '     -     ');
      t.matchIgnore('   ', '     -     ');
      t.testAll();
    });

    words((t) => {
      t.text('_i', 'i_');
      t.matchDefault('- ', ' -');
      t.matchTrim('  ', '  ');
      t.testAll();
    });

    words((t) => {
      t.text('i_', '_i');
      t.matchDefault('- ', ' -');
      t.testAll();
    });

    words((t) => {
      t.text('x_y', 'xy');
      t.matchIgnore('   ', '  ');
      t.testIgnore();
    });

    words((t) => {
      t.text('A x_y B', 'a xy b');
      t.matchIgnore('-------', '------');
      t.testIgnore();
    });

    words((t) => {
      t.text('A xy B', 'a xy b');
      t.matchIgnore('-    -', '-    -');
      t.testIgnore();
    });

    words((t) => {
      t.text('A_B_', 'X_');
      t.matchDefault('--- ', '- ');
      t.testAll();
    });
  });

  it('fixed bugs', () => {
    linesInner((t) => {
      t.text('.! ', '.  y!');
      t.matchDefault('  -', ' --- ');
      t.matchTrim('   ', ' --- ');
      t.matchIgnore('   ', '   - ');
      t.testAll();
    });

    linesInner((t) => {
      t.text(' x n', ' y_  x m');
      t.matchDefault('   -', '----   -');
      t.matchTrim('   -', ' -     -');
      t.matchIgnore('   -', ' -     -');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x_', 'x!  ');
      t.matchDefault(' -', ' ---');
      t.matchTrim('  ', ' -  ');
      t.matchIgnore('  ', ' -  ');
      t.testAll();
    });
  });

  it('inner whitespaces', () => {
    linesInner((t) => {
      t.text('<< x >>', '<.<>.>');
      t.matchDefault('  ---  ', ' -  - ');
      t.matchIgnore('   -   ', ' -  - ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('<< x >>', 'y<<x>>y');
      t.matchDefault('  - -  ', '-     -');
      t.matchIgnore('       ', '-     -');
      t.testAll();
    });

    linesInner((t) => {
      t.text('x .. z', 'x y .. z');
      t.matchDefault('      ', ' --     ');
      t.matchIgnore('      ', '  -     ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('  x..z', 'x..y  ');
      t.matchDefault('--   -', '   ---');
      t.matchTrim('     -', '   -  ');
      t.testAll();
    });

    linesInner((t) => {
      t.text(' x y x _ x z x ', 'x x_x x');
      t.matchDefault('- --  - - --  -', '       ');
      t.matchTrim('  --      --   ', '       ');
      t.matchIgnore('   -       -   ', '       ');
      t.testAll();
    });
  });

  it('algorithm specific', () => {
    // prefer words over punctuation
    linesInner((t) => {
      t.text('...x', 'x...');
      t.matchDefault('--- ', ' ---');
      t.testAll();
    });

    // prefer longer word sequences
    linesInner((t) => {
      t.text('x x y', 'x y');
      t.matchDefault('--   ', '   ');
      t.matchIgnore('-    ', '   ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('y x x', 'y x');
      t.matchDefault('   --', '   ');
      t.matchIgnore('    -', '   ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('A X A B', 'A B');
      t.matchDefault('----   ', '   ');
      t.matchIgnore('---    ', '   ');
      t.testAll();
    });

    // prefer less modified 'sentences'
    linesInner((t) => {
      t.text('A.X A.Z', 'A.X A.Y A.Z');
      t.matchDefault('       ', '   ----    ');
      t.matchIgnore('       ', '    ---    ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('X.A Z.A', 'X.A Y.A Z.A');
      t.matchDefault('       ', '   ----    ');
      t.matchIgnore('       ', '    ---    ');
      t.testAll();
    });

    // prefer punctuation over whitespaces
    linesInner((t) => {
      t.text('.   ', '   .');
      t.matchDefault(' ---', '--- ');
      t.testDefault();
    });

    linesInner((t) => {
      t.text('A B_C D', 'A_B C_D');
      t.matchDefault(' -  -- ', ' - --  ');
      t.matchTrim(' -  -- ', '   --  ');
      t.matchIgnore('    -  ', '    -  ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('B_C_D_', 'X_Y_Z_');
      t.matchDefault('- - - ', '- - - ');
      t.testAll();
    });

    words((t) => {
      t.text('!x_!_z', '!_!_y z');
      t.matchDefault(' -    ', '    -- ');
      t.testDefault();
    });
  });

  it('trailing punctuation', () => {
    linesInner((t) => {
      t.text('X = { };', 'X = { _ };');
      t.matchDefault('        ', '     --   ');
      t.matchTrim('        ', '          ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('X = { };_', 'X = { _ };_');
      t.matchDefault('      -- ', '       ----');
      t.matchTrim('      -- ', '        -- ');
      t.testAll();
    });
  });

  it('legacy cases from ByWordTest', () => {
    linesInner((t) => {
      t.text('abc def, 123', 'ab def, 12');
      t.matchDefault('---      ---', '--      --');
      t.testAll();
    });

    linesInner((t) => {
      t.text(' a[xy]+1', ',a[]+1');
      t.matchDefault('-  --   ', '-     ');
      t.matchTrim('   --   ', '-     ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('0987_  a.g();_', 'yyyy_');
      t.matchDefault('------------- ', '---- ');
      t.testAll();
    });

    linesInner((t) => {
      t.text('  abc_2222_', '    x = abc_zzzz_');
      t.matchDefault('      ---- ', ' ------     ---- ');
      t.matchTrim('      ---- ', '    ---     ---- ');
      t.testAll();
    });

    linesInner((t) => {
      // Idea58505
      t.text(
        '   if (eventMerger!=null && !dataSelection.getValueIsAdjusting()) {',
        '   if (eventMerger!=null && (dataSelection==null || !dataSelection.getValueIsAdjusting())) {'
      );
      t.matchDefault(
        '                                                                   ',
        '                           ------------------------                                      -  '
      );
      t.matchIgnore(
        '                                                                   ',
        '                            -----------------------                                      -  '
      );
      t.testAll();
    });

    linesInner((t) => {
      // Idea56428
      t.plainText(
        'messageInsertStatement = connection.prepareStatement("INSERT INTO AUDIT (AUDIT_TYPE_ID, STATUS, SERVER_ID, INSTANCE_ID, REQUEST_ID) VALUES (?, ?, ?, ?, ?)");',
        'messageInsertStatement = connection.prepareStatement("INSERT INTO AUDIT (AUDIT_TYPE_ID, CREATION_TIMESTAMP, STATUS, SERVER_ID, INSTANCE_ID, REQUEST_ID) VALUES (?, ?, ?, ?, ?, ?)");'
      );
      t.matchDefault(
        '                                                     .                                                                                                     .   ',
        '                                                     .                                  --------------------                                                                  --- .   '
      );
      t.matchIgnore(
        '                                                     .                                                                                                     .   ',
        '                                                     .                                   -------------------                                                                  --- .   '
      );
      t.testAll();
    });

    linesInner((t) => {
      t.text('f(a, b);', 'f(a,_  b);');
      t.matchDefault('        ', '    --    ');
      t.matchTrim('        ', '          ');
      t.testAll();
    });

    linesInner((t) => {
      t.text(' o.f(a)', 'o. f( b)');
      t.matchDefault('-    - ', '  -  -- ');
      t.matchTrim('     - ', '  -  -- ');
      t.matchIgnore('     - ', '      - ');
      t.testAll();
    });

    linesInner((t) => {
      t.text(' 123 ', 'xyz');
      t.matchTrim(' --- ', '---');
      t.testTrim();
    });
  });

  it('empty range positions', () => {
    linesInner((t) => {
      t.text('x? y', 'x y');
      t.matchDefault(' -  ', '   ');
      t.changesDefault(del(1, 1, 1));
      t.testAll();
    });

    linesInner((t) => {
      t.text('x ?y', 'x y');
      t.matchDefault('  - ', '   ');
      t.changesDefault(del(2, 2, 1));
      t.testAll();
    });
  });

  it('continuous script', () => {
    words((t) => {
      t.text('ABCD', 'DABC');
      t.matchDefault('----', '----');
      t.testDefault();
    });

    words((t) => {
      t.text('汉语漢語', '語汉语漢');
      t.matchDefault('   -', '-   ');
      t.testDefault();
    });

    words((t) => {
      t.text('AB漢CD', 'DA漢CD');
      t.matchDefault('--   ', '--   ');
      t.testDefault();
    });

    words((t) => {
      t.text('AB漢CD', 'DA语CD');
      t.matchDefault('---  ', '---  ');
      t.testDefault();
    });

    words((t) => {
      t.plainText('a_c', 'x_c');
      t.matchDefault('---', '---');
      t.testDefault();
    });

    words((t) => {
      t.text('!_?', '!_+');
      t.matchDefault('  -', '  +');
      t.testDefault();
    });
  });

  it('high surrogates', () => {
    words((t) => {
      t.text(`${CH_SMILE}${CH_GUN}${CH_MAN}${CH_FACE}`, `${CH_GUN}${CH_MAN}${CH_FACE}${CH_SMILE}`);
      t.matchDefault('--      ', '      --');
      t.testDefault();
    });

    words((t) => {
      t.text(CH_SMILE, CH_GUN);
      t.matchDefault('--', '--');
      t.testDefault();
    });

    words((t) => {
      t.text(CH_FACE, CH_GUN);
      t.matchDefault('--', '--');
      t.testDefault();
    });

    words((t) => {
      t.text(`${CH_SMILE} `, ` ${CH_GUN}`);
      t.matchDefault('---', '---');
      t.matchTrim('-- ', ' --');
      t.testAll();
    });

    words((t) => {
      t.text(`${CH_SMILE}${CH_FACE} ${CH_MAN}`, ` ${CH_GUN}${CH_FACE}${CH_MAN} `);
      t.matchDefault('--  -  ', '---    -');
      t.matchTrim('--  -  ', ' --     ');
      t.matchIgnore('--     ', ' --     ');
      t.testAll();
    });
  });
});
