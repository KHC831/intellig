// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/
// ComparisonUtilTestBase.kt + DiffTestCase.kt (the parts driving char/word tests).
// Copyright 2000-2020 JetBrains s.r.o. Apache 2.0 license.
//
// Kotlin's operator DSL ("before" - "after") becomes explicit calls:
//   chars((t) => { t.text('x', 'y'); t.matchDefault('-', '-'); t.testAll(); });

import * as assert from 'assert';
import { BitSet } from '../../../src/diff-engine/diff/BitSet';
import { IDiffFragment } from '../../../src/diff-engine/fragments/DiffFragment';
import { IMergeWordFragment } from '../../../src/diff-engine/fragments/MergeWordFragment';
import * as ByCharRt from '../../../src/diff-engine/comparison/ByCharRt';
import * as ByWordRt from '../../../src/diff-engine/comparison/ByWordRt';
import { EMPTY_CANCELLATION_CHECKER } from '../../../src/diff-engine/comparison/CancellationChecker';
import * as ComparisonManager from '../../../src/diff-engine/comparison/ComparisonManager';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { setVerifyEnabled } from '../../../src/diff-engine/comparison/iterables/DiffIterableUtil';
import { ILineFragment } from '../../../src/diff-engine/fragments/LineFragment';
import { ThreeSide } from '../../../src/diff-engine/util/ThreeSide';

export const CANCELLATION = EMPTY_CANCELLATION_CHECKER;

// Upstream's DiffTestCase turns the iterable self-checks on for every test.
setVerifyEnabled(true);

export function parseSource(source: string): string {
  return source.replace(/_/g, '\n');
}

export function parseMatching(matching: string, text: string): BitSet {
  const pattern = matching.replace(/\./g, '');
  assert.strictEqual(pattern.length, text.length, 'matching pattern must cover the text');

  const set = new BitSet();
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== ' ') {
      set.set(i);
    }
  }
  return set;
}

/** [ [start1, end1], [start2, end2] ] */
export type ChangePair = readonly [readonly [number, number], readonly [number, number]];
export type ChangeTrio = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

export function mod(offset1: number, offset2: number, count1: number, count2: number): ChangePair {
  assert.ok(count1 !== 0 && count2 !== 0);
  return [
    [offset1, offset1 + count1],
    [offset2, offset2 + count2],
  ];
}

export function del(offset1: number, offset2: number, count1: number): ChangePair {
  assert.ok(count1 !== 0);
  return [
    [offset1, offset1 + count1],
    [offset2, offset2],
  ];
}

export function ins(offset1: number, offset2: number, count2: number): ChangePair {
  assert.ok(count2 !== 0);
  return [
    [offset1, offset1],
    [offset2, offset2 + count2],
  ];
}

function checkConsistency(fragments: readonly IDiffFragment[]): void {
  for (const fragment of fragments) {
    assert.ok(fragment.startOffset1 <= fragment.endOffset1);
    assert.ok(fragment.startOffset2 <= fragment.endOffset2);
    assert.ok(
      fragment.startOffset1 !== fragment.endOffset1 || fragment.startOffset2 !== fragment.endOffset2
    );
  }
}

function checkMergeConsistency(fragments: readonly IMergeWordFragment[]): void {
  for (const fragment of fragments) {
    for (const side of [ThreeSide.LEFT, ThreeSide.BASE, ThreeSide.RIGHT]) {
      assert.ok(fragment.getStartOffset(side) <= fragment.getEndOffset(side));
    }
    assert.ok(
      fragment.getStartOffset(ThreeSide.LEFT) !== fragment.getEndOffset(ThreeSide.LEFT) ||
        fragment.getStartOffset(ThreeSide.BASE) !== fragment.getEndOffset(ThreeSide.BASE) ||
        fragment.getStartOffset(ThreeSide.RIGHT) !== fragment.getEndOffset(ThreeSide.RIGHT)
    );
  }
}

function assertSetsEqual(expected: BitSet, actual: BitSet, message: string): void {
  assert.ok(
    expected.equals(actual),
    `${message}: expected ${expected.toString()}, got ${actual.toString()}`
  );
}

function checkDiffMatching(
  fragments: readonly IDiffFragment[],
  before: BitSet,
  after: BitSet
): void {
  const set1 = new BitSet();
  const set2 = new BitSet();
  for (const fragment of fragments) {
    set1.setRange(fragment.startOffset1, fragment.endOffset1);
    set2.setRange(fragment.startOffset2, fragment.endOffset2);
  }

  assertSetsEqual(before, set1, 'Before');
  assertSetsEqual(after, set2, 'After');
}

function checkDiffChanges(
  fragments: readonly IDiffFragment[],
  expected: readonly ChangePair[]
): void {
  const changes = fragments.map((f) => [
    [f.startOffset1, f.endOffset1],
    [f.startOffset2, f.endOffset2],
  ]);
  assert.deepStrictEqual(
    changes,
    expected.map((pair) => [Array.from(pair[0]), Array.from(pair[1])])
  );
}

function checkMergeMatching(
  fragments: readonly IMergeWordFragment[],
  matchings: readonly [BitSet, BitSet, BitSet]
): void {
  const sets = [new BitSet(), new BitSet(), new BitSet()];
  const sides = [ThreeSide.LEFT, ThreeSide.BASE, ThreeSide.RIGHT];
  for (const fragment of fragments) {
    for (let i = 0; i < 3; i++) {
      sets[i].setRange(fragment.getStartOffset(sides[i]), fragment.getEndOffset(sides[i]));
    }
  }

  assertSetsEqual(matchings[0], sets[0], 'Left');
  assertSetsEqual(matchings[1], sets[1], 'Base');
  assertSetsEqual(matchings[2], sets[2], 'Right');
}

function checkMergeChanges(
  fragments: readonly IMergeWordFragment[],
  expected: readonly ChangeTrio[]
): void {
  const changes = fragments.map((f) => [
    [f.getStartOffset(ThreeSide.LEFT), f.getEndOffset(ThreeSide.LEFT)],
    [f.getStartOffset(ThreeSide.BASE), f.getEndOffset(ThreeSide.BASE)],
    [f.getStartOffset(ThreeSide.RIGHT), f.getEndOffset(ThreeSide.RIGHT)],
  ]);
  assert.deepStrictEqual(
    changes,
    expected.map((trio) => trio.map((range) => Array.from(range)))
  );
}

export function parseLineMatching(matching: string, text: string): BitSet {
  assert.strictEqual(matching.length, text.length, 'line matching pattern must cover the text');

  const lines1 = matching.split(/[_*]/);
  const lines2 = text.split('\n');
  assert.strictEqual(lines1.length, lines2.length);
  for (let i = 0; i < lines1.length; i++) {
    assert.strictEqual(lines1[i].length, lines2[i].length, `line ${i}`);
  }

  const set = new BitSet();

  let index = 0;
  let lineNumber = 0;
  while (index < matching.length) {
    let end = matching.slice(index).search(/[_*]/);
    end = end === -1 ? matching.length : index + end + 1;

    const line = matching.substring(index, end);
    if (/[^ _]/.test(line)) {
      assert.ok(!line.includes(' '), 'a marked line must be fully marked');
      set.set(lineNumber);
    }
    lineNumber++;
    index = end;
  }

  return set;
}

function checkLineMatching(
  fragments: readonly ILineFragment[],
  before: BitSet,
  after: BitSet
): void {
  const set1 = new BitSet();
  const set2 = new BitSet();
  for (const fragment of fragments) {
    set1.setRange(fragment.startLine1, fragment.endLine1);
    set2.setRange(fragment.startLine2, fragment.endLine2);
  }

  assertSetsEqual(before, set1, 'Before');
  assertSetsEqual(after, set2, 'After');
}

function checkLineChanges(
  fragments: readonly ILineFragment[],
  expected: readonly ChangePair[]
): void {
  const changes = fragments.map((f) => [
    [f.startLine1, f.endLine1],
    [f.startLine2, f.endLine2],
  ]);
  assert.deepStrictEqual(
    changes,
    expected.map((pair) => [Array.from(pair[0]), Array.from(pair[1])])
  );
}

type TestType = 'LINE' | 'WORD' | 'CHAR' | 'CHAR_SMART' | 'CHAR_RAW' | 'LINE_INNER' | 'SPLITTER';

interface PolicyData<T> {
  default?: T;
  trim?: T;
  ignore?: T;
}

function getForPolicy<T>(data: PolicyData<T>, policy: ComparisonPolicy): T | undefined {
  switch (policy) {
    case ComparisonPolicy.IGNORE_WHITESPACES:
      return data.ignore ?? data.trim ?? data.default;
    case ComparisonPolicy.TRIM_WHITESPACES:
      return data.trim ?? data.default;
    case ComparisonPolicy.DEFAULT:
      return data.default;
  }
}

export class ComparisonTest {
  private executed = false;

  private before: string | undefined;
  private after: string | undefined;
  private base: string | undefined;

  shouldSquash = false;
  shouldTrim = false;

  private readonly matchings: PolicyData<readonly string[]> = {};
  private readonly changes: PolicyData<readonly ChangePair[] | readonly ChangeTrio[]> = {};

  constructor(private readonly type: TestType) {}

  /** Sets the compared texts; '_' becomes '\n'. A base makes it a three-side word test. */
  text(before: string, after: string, base?: string): void {
    this.before = parseSource(before);
    this.after = parseSource(after);
    this.base = base !== undefined ? parseSource(base) : undefined;
  }

  /** Sets the compared texts verbatim (no '_' substitution). */
  plainText(before: string, after: string): void {
    this.before = before;
    this.after = after;
  }

  matchDefault(before: string, after: string, base?: string): void {
    assert.strictEqual(this.matchings.default, undefined);
    this.matchings.default = base !== undefined ? [before, base, after] : [before, after];
  }

  matchTrim(before: string, after: string, base?: string): void {
    assert.strictEqual(this.matchings.trim, undefined);
    this.matchings.trim = base !== undefined ? [before, base, after] : [before, after];
  }

  matchIgnore(before: string, after: string, base?: string): void {
    assert.strictEqual(this.matchings.ignore, undefined);
    this.matchings.ignore = base !== undefined ? [before, base, after] : [before, after];
  }

  changesDefault(...expected: ChangePair[]): void {
    assert.strictEqual(this.changes.default, undefined);
    this.changes.default = expected;
  }

  changesTrim(...expected: ChangePair[]): void {
    assert.strictEqual(this.changes.trim, undefined);
    this.changes.trim = expected;
  }

  changesIgnore(...expected: ChangePair[]): void {
    assert.strictEqual(this.changes.ignore, undefined);
    this.changes.ignore = expected;
  }

  testAll(): void {
    this.testDefault();
    this.testTrim();
    this.testIgnore();
  }

  testDefault(): void {
    this.run(ComparisonPolicy.DEFAULT);
  }

  testTrim(): void {
    this.run(ComparisonPolicy.TRIM_WHITESPACES);
  }

  testIgnore(): void {
    this.run(ComparisonPolicy.IGNORE_WHITESPACES);
  }

  assertExecuted(): void {
    assert.ok(this.executed, 'the test body must call one of the test*() methods');
  }

  private run(policy: ComparisonPolicy): void {
    this.executed = true;
    try {
      const before = this.before;
      const after = this.after;
      assert.ok(before !== undefined && after !== undefined, 'text() must be called first');

      const matchings = getForPolicy(this.matchings, policy);
      const changes = getForPolicy(this.changes, policy);
      assert.ok(matchings !== undefined || changes !== undefined);

      if (this.base === undefined) {
        const matchingSets =
          matchings !== undefined
            ? ([
                parseMatching(matchings[0], before),
                parseMatching(matchings[matchings.length - 1], after),
              ] as const)
            : undefined;

        switch (this.type) {
          case 'LINE':
            this.doLineTest(
              before,
              after,
              matchings !== undefined
                ? ([
                    parseLineMatching(matchings[0], before),
                    parseLineMatching(matchings[matchings.length - 1], after),
                  ] as const)
                : undefined,
              changes as readonly ChangePair[] | undefined,
              policy
            );
            break;
          case 'WORD':
            this.doWordTest(
              before,
              after,
              matchingSets,
              changes as readonly ChangePair[] | undefined,
              policy
            );
            break;
          case 'LINE_INNER':
            this.doLineInnerTest(
              before,
              after,
              matchingSets,
              changes as readonly ChangePair[] | undefined,
              policy
            );
            this.doWordTest(
              before,
              after,
              matchingSets,
              changes as readonly ChangePair[] | undefined,
              policy
            );
            break;
          case 'SPLITTER':
            this.doSplitterTest(
              before,
              after,
              changes as readonly ChangePair[] | undefined,
              policy
            );
            break;
          case 'CHAR':
            this.doCharTest(
              before,
              after,
              matchingSets,
              changes as readonly ChangePair[] | undefined,
              policy
            );
            if (policy === ComparisonPolicy.DEFAULT) {
              this.doCharRawTest(
                before,
                after,
                matchingSets,
                changes as readonly ChangePair[] | undefined
              );
            }
            break;
          case 'CHAR_SMART':
            this.doCharTest(
              before,
              after,
              matchingSets,
              changes as readonly ChangePair[] | undefined,
              policy
            );
            break;
          case 'CHAR_RAW':
            if (policy === ComparisonPolicy.DEFAULT) {
              this.doCharRawTest(
                before,
                after,
                matchingSets,
                changes as readonly ChangePair[] | undefined
              );
            }
            break;
        }
      } else {
        assert.strictEqual(this.type, 'WORD', 'three-side texts are only supported by word tests');
        const base = this.base;
        const matchingSets =
          matchings !== undefined
            ? ([
                parseMatching(matchings[0], before),
                parseMatching(matchings[1], base),
                parseMatching(matchings[2], after),
              ] as const)
            : undefined;

        const fragments = ByWordRt.compareThreeside(before, base, after, policy, CANCELLATION);
        checkMergeConsistency(fragments);
        if (matchingSets !== undefined) {
          checkMergeMatching(fragments, matchingSets);
        }
        if (changes !== undefined) {
          checkMergeChanges(fragments, changes as readonly ChangeTrio[]);
        }
      }
    } catch (e) {
      throw new Error(
        `Policy: ${policy}\n${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
      );
    }
  }

  private doLineTest(
    before: string,
    after: string,
    matchings: readonly [BitSet, BitSet] | undefined,
    changes: readonly ChangePair[] | undefined,
    policy: ComparisonPolicy
  ): void {
    const fragments = ComparisonManager.compareLines(before, after, policy, CANCELLATION);
    if (matchings !== undefined) {
      checkLineMatching(fragments, matchings[0], matchings[1]);
    }
    if (changes !== undefined) {
      checkLineChanges(fragments, changes);
    }
  }

  private doLineInnerTest(
    before: string,
    after: string,
    matchings: readonly [BitSet, BitSet] | undefined,
    changes: readonly ChangePair[] | undefined,
    policy: ComparisonPolicy
  ): void {
    const rawFragments = ComparisonManager.compareLinesInner(before, after, policy, CANCELLATION);
    const fragments = ComparisonManager.squash(rawFragments);

    assert.strictEqual(fragments.length, 1, 'the squashed diff must be a single fragment');
    const fragment = fragments[0];
    assert.strictEqual(fragment.startOffset1, 0);
    assert.strictEqual(fragment.startOffset2, 0);
    assert.strictEqual(fragment.endOffset1, before.length);
    assert.strictEqual(fragment.endOffset2, after.length);

    // It could be missing if there are no common words. We do not test such cases here.
    const diffFragments = fragment.innerFragments;
    assert.ok(diffFragments !== undefined);
    checkConsistency(diffFragments);
    if (matchings !== undefined) {
      checkDiffMatching(diffFragments, matchings[0], matchings[1]);
    }
    if (changes !== undefined) {
      checkDiffChanges(diffFragments, changes);
    }
  }

  private doSplitterTest(
    before: string,
    after: string,
    changes: readonly ChangePair[] | undefined,
    policy: ComparisonPolicy
  ): void {
    let fragments = ComparisonManager.compareLinesInner(before, after, policy, CANCELLATION);
    fragments = ComparisonManager.processBlocks(
      fragments,
      before,
      after,
      policy,
      this.shouldSquash,
      this.shouldTrim
    );

    if (changes !== undefined) {
      checkLineChanges(fragments, changes);
    }
  }

  private doWordTest(
    before: string,
    after: string,
    matchings: readonly [BitSet, BitSet] | undefined,
    changes: readonly ChangePair[] | undefined,
    policy: ComparisonPolicy
  ): void {
    const fragments = ByWordRt.compare(before, after, policy, CANCELLATION);
    checkConsistency(fragments);

    if (matchings !== undefined) {
      checkDiffMatching(fragments, matchings[0], matchings[1]);
    }
    if (changes !== undefined) {
      checkDiffChanges(fragments, changes);
    }
  }

  // ComparisonManagerImpl.doCompareChars
  private doCharTest(
    before: string,
    after: string,
    matchings: readonly [BitSet, BitSet] | undefined,
    changes: readonly ChangePair[] | undefined,
    policy: ComparisonPolicy
  ): void {
    let iterable;
    if (policy === ComparisonPolicy.DEFAULT) {
      iterable = ByCharRt.compareTwoStep(before, after, CANCELLATION);
    } else if (policy === ComparisonPolicy.TRIM_WHITESPACES) {
      iterable = ByCharRt.compareTrimWhitespaces(before, after, CANCELLATION);
    } else {
      iterable = ByCharRt.compareIgnoreWhitespaces(before, after, CANCELLATION);
    }
    const fragments = ByWordRt.convertIntoDiffFragments(iterable);
    checkConsistency(fragments);

    if (matchings !== undefined) {
      checkDiffMatching(fragments, matchings[0], matchings[1]);
    }
    if (changes !== undefined) {
      checkDiffChanges(fragments, changes);
    }
  }

  private doCharRawTest(
    before: string,
    after: string,
    matchings: readonly [BitSet, BitSet] | undefined,
    changes: readonly ChangePair[] | undefined
  ): void {
    const iterable = ByCharRt.compare(before, after, CANCELLATION);
    const fragments = ByWordRt.convertIntoDiffFragments(iterable);
    checkConsistency(fragments);

    if (matchings !== undefined) {
      checkDiffMatching(fragments, matchings[0], matchings[1]);
    }
    if (changes !== undefined) {
      checkDiffChanges(fragments, changes);
    }
  }
}

function doTest(type: TestType, body: (t: ComparisonTest) => void): void {
  const test = new ComparisonTest(type);
  body(test);
  test.assertExecuted();
}

export function words(body: (t: ComparisonTest) => void): void {
  doTest('WORD', body);
}

export function chars(body: (t: ComparisonTest) => void): void {
  doTest('CHAR', body);
}

export function charsSmart(body: (t: ComparisonTest) => void): void {
  doTest('CHAR_SMART', body);
}

export function charsRaw(body: (t: ComparisonTest) => void): void {
  doTest('CHAR_RAW', body);
}

export function linesInner(body: (t: ComparisonTest) => void): void {
  doTest('LINE_INNER', body);
}

export function lines(body: (t: ComparisonTest) => void): void {
  doTest('LINE', body);
}

export function splitter(
  options: { squash?: boolean; trim?: boolean },
  body: (t: ComparisonTest) => void
): void {
  doTest('SPLITTER', (t) => {
    t.shouldSquash = options.squash ?? false;
    t.shouldTrim = options.trim ?? false;
    body(t);
  });
}
