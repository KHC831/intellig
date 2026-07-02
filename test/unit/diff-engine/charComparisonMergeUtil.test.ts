// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/CharComparisonMergeUtilTest.kt
// Copyright 2000-2015 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import { chars3, mod } from './mergeComparisonTestUtil';

describe('diff-engine three-side char merge (CharComparisonMergeUtilTest)', () => {
  it('simple cases', () => {
    chars3((t) => {
      t.texts('', '', '');
      t.matching('', '', '');
      t.changes();
      t.test();
    });

    chars3((t) => {
      t.texts('xyz', 'xyz', 'xyz');
      t.matching('   ', '   ', '   ');
      t.changes();
      t.test();
    });

    chars3((t) => {
      t.texts('', '', 'x');
      t.matching('', '', '-');
      t.changes(mod(0, 0, 0, 0, 0, 1));
      t.test();
    });

    chars3((t) => {
      t.texts('x', 'yx', 'x');
      t.matching(' ', '- ', ' ');
      t.test();
    });

    chars3((t) => {
      t.texts('x', 'xy', 'x');
      t.matching(' ', ' -', ' ');
      t.test();
    });

    chars3((t) => {
      t.texts('xyz', 'xYz', 'xyz');
      t.matching(' - ', ' - ', ' - ');
      t.test();
    });

    chars3((t) => {
      t.texts('xyz', 'XyZ', 'xyz');
      t.matching('- -', '- -', '- -');
      t.test();
    });
  });

  it('conflict types', () => {
    chars3((t) => {
      t.texts('abcd', 'abcd', 'abXcd');
      t.matching('    ', '    ', '  -  ');
      t.test();
    });

    chars3((t) => {
      t.texts('abXcd', 'abcd', 'abXcd');
      t.matching('  -  ', '    ', '  -  ');
      t.test();
    });

    chars3((t) => {
      t.texts('abcd', 'abXcd', 'abXcd');
      t.matching('    ', '  -  ', '  -  ');
      t.test();
    });

    chars3((t) => {
      t.texts('abcd', 'abXcd', 'abcd');
      t.matching('    ', '  -  ', '    ');
      t.test();
    });

    chars3((t) => {
      t.texts('abcd', 'abXcd', 'abYcd');
      t.matching('    ', '  -  ', '  -  ');
      t.test();
    });

    chars3((t) => {
      t.texts('abXcd', 'abXcd', 'abYcd');
      t.matching('  -  ', '  -  ', '  -  ');
      t.test();
    });

    chars3((t) => {
      t.texts('abYcd', 'abXcd', 'abYcd');
      t.matching('  -  ', '  -  ', '  -  ');
      t.test();
    });

    chars3((t) => {
      t.texts('abYcd', 'abXcd', 'abZcd');
      t.matching('  -  ', '  -  ', '  -  ');
      t.test();
    });

    chars3((t) => {
      t.texts('abXcd', 'abcd', 'abYcd');
      t.matching('  -  ', '    ', '  -  ');
      t.test();
    });
  });

  it('boundary conflicts', () => {
    chars3((t) => {
      t.texts('abcd', 'abcd', 'abcdx');
      t.matching('    ', '    ', '    -');
      t.test();
    });

    chars3((t) => {
      t.texts('abcd', 'abcdx', 'abcdx');
      t.matching('    ', '    -', '    -');
      t.test();
    });

    chars3((t) => {
      t.texts('abcd', 'abcdx', 'abcdy');
      t.matching('    ', '    -', '    -');
      t.test();
    });

    chars3((t) => {
      t.texts('abcdz', 'abcdx', 'abcdy');
      t.matching('    -', '    -', '    -');
      t.test();
    });

    chars3((t) => {
      t.texts('xabcd', 'abcd', 'abcd');
      t.matching('-    ', '    ', '    ');
      t.test();
    });

    chars3((t) => {
      t.texts('xabcd', 'yabcd', 'abcd');
      t.matching('-    ', '-    ', '    ');
      t.test();
    });

    chars3((t) => {
      t.texts('abcd', 'yabcd', 'abcd');
      t.matching('    ', '-    ', '    ');
      t.test();
    });
  });

  it('multiple changes', () => {
    chars3((t) => {
      t.texts('XXbXcXXeX', 'XyXzXXnXkX', 'XqXXeXrXX');
      t.matching('  - -  - ', ' - -  - - ', ' -  - -  ');
      t.test();
    });

    chars3((t) => {
      t.texts('Ax', 'z', 'zA');
      t.matching('--', '-', '--');
      t.test();
    });

    chars3((t) => {
      t.texts('ayz', 'xyz', 'xyq');
      t.matching('- -', '- -', '- -');
      t.test();
    });
  });
});
