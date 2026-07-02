// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/WordMergeComparisonUtilTest.kt
// Copyright 2000-2016 JetBrains s.r.o. Apache 2.0 license.
//
// Upstream's trio DSL reads (before - base - after); the harness takes
// text(before, after, base).

import '../../setup';
import { words } from './comparisonTestUtil';

describe('diff-engine three-side word merge (WordMergeComparisonUtilTest)', () => {
  it('simple', () => {
    words((t) => {
      t.text('', '', '');
      t.matchDefault('', '', '');
      t.testAll();
    });

    words((t) => {
      t.text('', '', 'X');
      t.matchDefault('', '', '-');
      t.testAll();
    });

    words((t) => {
      t.text('X', '', '');
      t.matchDefault('-', '', '');
      t.testAll();
    });

    words((t) => {
      t.text('a b', 'a b', 'a b');
      t.matchDefault('   ', '   ', '   ');
      t.testAll();
    });

    words((t) => {
      t.text('A b c', 'a b C', 'a b c');
      t.matchDefault('-   -', '-   -', '-   -');
      t.testAll();
    });

    words((t) => {
      t.text('a c', 'a X c', 'a c');
      t.matchDefault('   ', ' --  ', '   ');
      t.matchIgnore('   ', '  -  ', '   ');
      t.testAll();
    });

    words((t) => {
      t.text('a X c', 'a c', 'a X c');
      t.matchDefault(' --  ', '   ', ' --  ');
      t.matchIgnore('  -  ', '   ', '  -  ');
      t.testAll();
    });

    words((t) => {
      t.text('a X c', 'a Y c', 'a c');
      t.matchDefault(' --  ', ' --  ', '   ');
      t.matchIgnore('  -  ', '  -  ', '   ');
      t.testAll();
    });

    words((t) => {
      t.text('a c', 'a Y c', 'a X c');
      t.matchDefault('   ', ' --  ', ' --  ');
      t.matchIgnore('   ', '  -  ', '  -  ');
      t.testAll();
    });
  });

  it('newlines', () => {
    words((t) => {
      t.text('i', '_i', 'i_');
      t.matchDefault('-', '--', '--');
      t.matchTrim(' ', '  ', '  ');
      t.testAll();
    });

    words((t) => {
      t.text('_i', 'i', 'i_');
      t.matchDefault('--', '-', '--');
      t.matchTrim('  ', ' ', '  ');
      t.testAll();
    });

    words((t) => {
      t.text('i', 'i_', '_i');
      t.matchDefault(' ', ' -', '- ');
      t.matchTrim(' ', '  ', '  ');
      t.testAll();
    });

    words((t) => {
      t.text('_i', 'i_', 'i');
      t.matchDefault('- ', ' -', ' ');
      t.matchTrim('  ', '  ', ' ');
      t.testAll();
    });
  });
});
