// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/ComparisonMergeUtilTestBase.kt
// Copyright 2000-2020 JetBrains s.r.o. Apache 2.0 license.
//
// Trio arguments read (left, base, right) — base in the middle, as upstream.

import * as assert from 'assert';
import * as ByCharRt from '../../../src/diff-engine/comparison/ByCharRt';
import { EMPTY_CANCELLATION_CHECKER } from '../../../src/diff-engine/comparison/CancellationChecker';
import * as ComparisonManager from '../../../src/diff-engine/comparison/ComparisonManager';
import * as ComparisonMergeUtil from '../../../src/diff-engine/comparison/ComparisonMergeUtil';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { BitSet } from '../../../src/diff-engine/diff/BitSet';
import { IMergeLineFragment } from '../../../src/diff-engine/fragments/MergeLineFragment';
import { MergeRange } from '../../../src/diff-engine/util/MergeRange';
import { ThreeSide } from '../../../src/diff-engine/util/ThreeSide';
import { parseLineMatching, parseMatching, parseSource } from './comparisonTestUtil';

const CANCELLATION = EMPTY_CANCELLATION_CHECKER;

/** [ [start1, end1], [start2, end2], [start3, end3] ] — left, base, right. */
export type MergeChange = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

export function mod(
  line1: number,
  line2: number,
  line3: number,
  count1: number,
  count2: number,
  count3: number
): MergeChange {
  return [
    [line1, line1 + count1],
    [line2, line2 + count2],
    [line3, line3 + count3],
  ];
}

function toChange(range: MergeRange): MergeChange {
  return [
    [range.start1, range.end1],
    [range.start2, range.end2],
    [range.start3, range.end3],
  ];
}

function fragmentToChange(fragment: IMergeLineFragment): MergeChange {
  return [
    [fragment.getStartLine(ThreeSide.LEFT), fragment.getEndLine(ThreeSide.LEFT)],
    [fragment.getStartLine(ThreeSide.BASE), fragment.getEndLine(ThreeSide.BASE)],
    [fragment.getStartLine(ThreeSide.RIGHT), fragment.getEndLine(ThreeSide.RIGHT)],
  ];
}

function checkConsistency(actual: readonly MergeChange[]): void {
  let lasts: readonly [number, number, number] = [-1, -1, -1];

  for (const change of actual) {
    let empty = true;
    let squashed = true;
    for (let side = 0; side < 3; side++) {
      const [start, end] = change[side];
      const last = lasts[side];

      assert.ok(last <= start, 'changes must not overlap');
      assert.ok(start <= end, 'change bounds must be ordered');
      empty = empty && start === end;
      squashed = squashed && start === last;
    }

    assert.ok(!empty, 'changes must not be empty on every side');
    assert.ok(!squashed, 'adjacent changes must be squashed');

    lasts = [change[0][1], change[1][1], change[2][1]];
  }
}

function checkDiffChanges(actual: readonly MergeChange[], expected: readonly MergeChange[]): void {
  assert.deepStrictEqual(
    actual.map((c) => c.map((range) => Array.from(range))),
    expected.map((c) => c.map((range) => Array.from(range)))
  );
}

function checkDiffMatching(
  changes: readonly MergeChange[],
  matchings: readonly [BitSet, BitSet, BitSet]
): void {
  const sets = [new BitSet(), new BitSet(), new BitSet()];

  for (const change of changes) {
    for (let side = 0; side < 3; side++) {
      sets[side].setRange(change[side][0], change[side][1]);
    }
  }

  const labels = ['Left', 'Base', 'Right'];
  for (let side = 0; side < 3; side++) {
    assert.ok(
      matchings[side].equals(sets[side]),
      `${labels[side]}: expected ${matchings[side].toString()}, got ${sets[side].toString()}`
    );
  }
}

type TestType = 'CHAR' | 'LINE_DIFF' | 'LINE_MERGE';

export class MergeComparisonTest {
  private executed = false;

  private left: string | undefined;
  private base: string | undefined;
  private right: string | undefined;

  private expectedChanges: readonly MergeChange[] | undefined;
  private matchingPatterns: readonly [string, string, string] | undefined;

  constructor(private readonly type: TestType) {}

  /** Sets the compared texts; '_' becomes '\n'. */
  texts(left: string, base: string, right: string): void {
    this.left = parseSource(left);
    this.base = parseSource(base);
    this.right = parseSource(right);
  }

  matching(left: string, base: string, right: string): void {
    assert.strictEqual(this.matchingPatterns, undefined);
    this.matchingPatterns = [left, base, right];
  }

  changes(...expected: MergeChange[]): void {
    assert.strictEqual(this.expectedChanges, undefined);
    this.expectedChanges = expected;
  }

  test(policy: ComparisonPolicy = ComparisonPolicy.DEFAULT): void {
    this.executed = true;

    const left = this.left;
    const base = this.base;
    const right = this.right;
    assert.ok(
      left !== undefined && base !== undefined && right !== undefined,
      'texts() must be called first'
    );
    assert.ok(this.expectedChanges !== undefined || this.matchingPatterns !== undefined);

    const matchings =
      this.matchingPatterns !== undefined
        ? this.type === 'CHAR'
          ? ([
              parseMatching(this.matchingPatterns[0], left),
              parseMatching(this.matchingPatterns[1], base),
              parseMatching(this.matchingPatterns[2], right),
            ] as const)
          : ([
              parseLineMatching(this.matchingPatterns[0], left),
              parseLineMatching(this.matchingPatterns[1], base),
              parseLineMatching(this.matchingPatterns[2], right),
            ] as const)
        : undefined;

    let actual: MergeChange[];
    switch (this.type) {
      case 'CHAR': {
        assert.strictEqual(policy, ComparisonPolicy.DEFAULT);
        const iterable1 = ByCharRt.compare(base, left, CANCELLATION);
        const iterable2 = ByCharRt.compare(base, right, CANCELLATION);
        const fragments = ComparisonMergeUtil.buildSimple(iterable1, iterable2, CANCELLATION);
        actual = fragments.map(toChange);
        checkConsistency(actual);
        break;
      }
      case 'LINE_DIFF': {
        const fragments = ComparisonManager.compareLinesThreeside(
          left,
          base,
          right,
          policy,
          CANCELLATION
        );
        actual = fragments.map(fragmentToChange);
        break;
      }
      case 'LINE_MERGE': {
        const fragments = ComparisonManager.mergeLines(left, base, right, policy, CANCELLATION);
        actual = fragments.map(fragmentToChange);
        break;
      }
    }

    if (matchings !== undefined) {
      checkDiffMatching(actual, matchings);
    }
    if (this.expectedChanges !== undefined) {
      checkDiffChanges(actual, this.expectedChanges);
    }
  }

  assertExecuted(): void {
    assert.ok(this.executed, 'the test body must call test()');
  }
}

function doTest(type: TestType, body: (t: MergeComparisonTest) => void): void {
  const test = new MergeComparisonTest(type);
  body(test);
  test.assertExecuted();
}

export function chars3(body: (t: MergeComparisonTest) => void): void {
  doTest('CHAR', body);
}

export function linesDiff(body: (t: MergeComparisonTest) => void): void {
  doTest('LINE_DIFF', body);
}

export function linesMerge(body: (t: MergeComparisonTest) => void): void {
  doTest('LINE_MERGE', body);
}
