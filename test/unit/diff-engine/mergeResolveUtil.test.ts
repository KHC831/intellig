// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/MergeResolveUtilTest.kt
// Copyright 2000-2016 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import { tryGreedyResolve, tryResolve } from '../../../src/diff-engine/comparison/MergeResolveUtil';

const NL = String.fromCharCode(10);

function joinLines(lines: readonly string[]): string {
  return NL + lines.join(NL);
}

function testSimple(base: string, left: string, right: string, expected: string | undefined): void {
  assert.strictEqual(tryResolve(left, base, right), expected);
}

function testGreedy(base: string, left: string, right: string, expected: string | undefined): void {
  assert.strictEqual(tryGreedyResolve(left, base, right), expected);
}

function test(base: string, left: string, right: string, expected: string | undefined): void {
  testSimple(base, left, right, expected);
  testGreedy(base, left, right, expected);
}

function testBoth(
  base: string,
  left: string,
  right: string,
  expectedSimple: string | undefined,
  expectedGreedy: string | undefined
): void {
  testSimple(base, left, right, expectedSimple);
  testGreedy(base, left, right, expectedGreedy);
}

describe('diff-engine magic resolve (MergeResolveUtilTest)', () => {
  it('simple', () => {
    test('', '', '', '');
    test('x x x', 'x x x', 'x x x', 'x x x');
    test('x x x', 'x Y x', 'x x x', 'x Y x');
    test('x x', 'x x', 'x Y x', 'x Y x');
    test('x X x', 'x x', 'x X x', 'x x');
  });

  it('same modification', () => {
    test('x x x', 'x Y x', 'x Y x', 'x Y x');
    test('x x', 'x Y x', 'x Y x', 'x Y x');
    test('x X x', 'x x', 'x x', 'x x');
  });

  it('non-conflicting changes', () => {
    test('x x x', 'x Y x x', 'x x Z x', 'x Y x Z x');
    test('x', 'x Y', 'Z x', 'Z x Y');
    test('x x', 'x', 'Z x x', 'Z x');
  });

  it('failure', () => {
    test('x x x', 'x Y x', 'x Z x', undefined);
    test('x x', 'x Y x', 'x Z x', undefined);
  });

  it('non-failure conflicts', () => {
    testGreedy('x X x', 'x x', 'x X Y x', 'x Y x');
    testGreedy('x X x', 'x x', 'x Y X x', 'x Y x');
    testGreedy('x X Y x', 'x X x', 'x Y x', 'x x');
    testGreedy('x X Y Z x', 'x X x', 'x Z x', 'x x');
    testGreedy('x A B C D E F G H K x', 'x C F K x', 'x A D H x', 'x x');
  });

  it('confusing conflicts', () => {
    // these cases might be a failure as well
    testGreedy('x X x', 'x x', 'x Z x', 'xZ x');
    testGreedy('x X X x', 'x X Y X x', 'x x', 'x Y x');
    testGreedy('x X x', 'x x', 'x Y x', 'xY x');
    testGreedy('x X X x', 'x Y x', 'x X Y x', 'x Y x');

    // IDEA-200696
    test('version: 1.0.0', 'version: 2.0.0', 'version: 1.0.4', 'version: 2.0.4');
  });

  it('regressions', () => {
    testBoth('i' + NL, 'i', NL + 'i', 'i', 'i');

    testSimple(
      'Y X Y',
      'Y C' + NL + 'X' + NL + 'C Y',
      'Y ' + NL + 'X' + NL + ' Y',
      'Y ' + NL + 'C' + NL + 'X' + NL + 'C Y'
    );

    test(
      joinLines([
        '  public static class ChangeData {',
        '    @NotNull public final ChangeKind kind;',
        '    public final int otherPath;',
        '',
        '    public ChangeData(@NotNull ChangeKind kind, int otherPath) {',
        '      this.kind = kind;',
        '      this.otherPath = otherPath;',
        '    }',
        '',
        '    public boolean isRename() {',
        '      return kind.equals(ChangeKind.RENAMED_FROM) || kind.equals(ChangeKind.RENAMED_TO);',
        '    }',
        '',
        '    @Override',
        '    public int hashCode() {',
        '      return Objects.hash(kind, otherPath);',
        '    }',
        '  }',
        '',
        '  private enum ChangeKind {',
        '    MODIFIED((byte)0),',
        '    RENAMED_FROM((byte)1),',
        '    RENAMED_TO((byte)2);',
      ]),
      joinLines([
        '  public enum ChangeKind {',
        '    NOT_CHANGED((byte)-1),',
        '    MODIFIED((byte)0),',
        '    ADDED((byte)1),',
        '    REMOVED((byte)2);',
      ]),
      joinLines([
        '  public static class ChangeData {',
        '  @NotNull public final ChangeKind kind;',
        '  public final int otherPath;',
        '',
        '  public ChangeData(@NotNull ChangeKind kind, int otherPath) {',
        '    this.kind = kind;',
        '    this.otherPath = otherPath;',
        '  }',
        '',
        '  public boolean isRename() {',
        '    return kind.equals(ChangeKind.RENAMED_FROM) || kind.equals(ChangeKind.RENAMED_TO);',
        '  }',
        '',
        '  @Override',
        '  public int hashCode() {',
        '    return Objects.hash(kind, otherPath);',
        '  }',
        '}',
        '',
        'private enum ChangeKind {',
        '  MODIFIED((byte)0),',
        '  RENAMED_FROM((byte)1),',
        '  RENAMED_TO((byte)2);',
      ]),
      joinLines([
        '  public enum ChangeKind {',
        '    NOT_CHANGED((byte)-1),',
        '  MODIFIED((byte)0),',
        '  ADDED((byte)1),',
        '  REMOVED((byte)2);',
      ])
    );
  });
});
