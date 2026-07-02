// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ByLineRt.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { IMergeLineFragment, MergeLineFragmentImpl } from '../fragments/MergeLineFragment';
import { MergeRange } from '../util/MergeRange';
import { Range } from '../util/Range';
import { ICancellationChecker } from './CancellationChecker';
import { SmartLineChangeCorrector } from './ChangeCorrector';
import { LineChunkOptimizer } from './ChunkOptimizer';
import * as ComparisonMergeUtil from './ComparisonMergeUtil';
import { ComparisonPolicy } from './ComparisonPolicy';
import { getUnimportantLineCharCount } from './ComparisonUtil';
import { IFairDiffIterable } from './iterables/DiffIterable';
import { create, diff, ExpandChangeBuilder, fair } from './iterables/DiffIterableUtil';
import { isSpaceEnterOrTabAt } from './strings';
import { expand } from './TrimUtil';

export function compare(
  lines1: readonly string[],
  lines2: readonly string[],
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IFairDiffIterable {
  indicator.checkCanceled();
  return doCompare(getLines(lines1, policy), getLines(lines2, policy), policy, indicator);
}

export function compareThreeside(
  lines1: readonly string[],
  lines2: readonly string[],
  lines3: readonly string[],
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): MergeRange[] {
  indicator.checkCanceled();
  return doCompareThreeside(
    getLines(lines1, policy),
    getLines(lines2, policy),
    getLines(lines3, policy),
    policy,
    indicator,
    false
  );
}

export function merge(
  lines1: readonly string[],
  lines2: readonly string[],
  lines3: readonly string[],
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): MergeRange[] {
  indicator.checkCanceled();
  return doCompareThreeside(
    getLines(lines1, policy),
    getLines(lines2, policy),
    getLines(lines3, policy),
    policy,
    indicator,
    true
  );
}

//
// Impl
//

function doCompare(
  lines1: readonly Line[],
  lines2: readonly Line[],
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IFairDiffIterable {
  indicator.checkCanceled();

  if (policy === ComparisonPolicy.IGNORE_WHITESPACES) {
    let changes = compareSmart(lines1, lines2, indicator);
    changes = optimizeLineChunks(lines1, lines2, changes, indicator);
    return expandRanges(lines1, lines2, changes);
  }

  const iwLines1 = convertMode(lines1, ComparisonPolicy.IGNORE_WHITESPACES);
  const iwLines2 = convertMode(lines2, ComparisonPolicy.IGNORE_WHITESPACES);

  let iwChanges = compareSmart(iwLines1, iwLines2, indicator);
  iwChanges = optimizeLineChunks(lines1, lines2, iwChanges, indicator);
  return correctChangesSecondStep(lines1, lines2, iwChanges);
}

/**
 * @param keepIgnoredChanges if true, blocks of "ignored" changes will not be actually
 *   ignored (but will not be included into "conflict" blocks)
 */
function doCompareThreeside(
  lines1: readonly Line[],
  lines2: readonly Line[],
  lines3: readonly Line[],
  policy: ComparisonPolicy,
  indicator: ICancellationChecker,
  keepIgnoredChanges: boolean
): MergeRange[] {
  indicator.checkCanceled();

  const iwLines1 = convertMode(lines1, ComparisonPolicy.IGNORE_WHITESPACES);
  const iwLines2 = convertMode(lines2, ComparisonPolicy.IGNORE_WHITESPACES);
  const iwLines3 = convertMode(lines3, ComparisonPolicy.IGNORE_WHITESPACES);

  let iwChanges1 = compareSmart(iwLines2, iwLines1, indicator);
  iwChanges1 = optimizeLineChunks(lines2, lines1, iwChanges1, indicator);
  const iterable1 = correctChangesSecondStep(lines2, lines1, iwChanges1);

  let iwChanges2 = compareSmart(iwLines2, iwLines3, indicator);
  iwChanges2 = optimizeLineChunks(lines2, lines3, iwChanges2, indicator);
  const iterable2 = correctChangesSecondStep(lines2, lines3, iwChanges2);

  if (keepIgnoredChanges && policy !== ComparisonPolicy.DEFAULT) {
    return ComparisonMergeUtil.buildMerge(
      iterable1,
      iterable2,
      (index1, index2, index3) =>
        equalsDefaultPolicy(lines1, lines2, lines3, index1, index2, index3),
      indicator
    );
  }
  return ComparisonMergeUtil.buildSimple(iterable1, iterable2, indicator);
}

function equalsDefaultPolicy(
  lines1: readonly Line[],
  lines2: readonly Line[],
  lines3: readonly Line[],
  index1: number,
  index2: number,
  index3: number
): boolean {
  const content1 = lines1[index1].content;
  const content2 = lines2[index2].content;
  const content3 = lines3[index3].content;
  return content2 === content1 && content2 === content3;
}

function correctChangesSecondStep(
  lines1: readonly Line[],
  lines2: readonly Line[],
  changes: IFairDiffIterable
): IFairDiffIterable {
  /*
   * We want to fix invalid matching here:
   *
   * .{        ..{
   * ..{   vs  ...{
   * ...{
   *
   * The first step will return the matching (0,2)-(0,2), and we should adjust it to
   * (1,3)-(0,2).
   *
   * On the other hand, we don't want to reduce the number of IW-matched lines:
   *
   * .{         ...{
   * ..{    vs  ..{
   * ...{       .{
   *
   * The first step will return (0,3)-(0,3) and 'correcting' it to (0,1)-(2,3) is wrong
   * (and would break the ByWord highlighting).
   *
   * Idea:
   * 1. lines are matched at the first step and equal -> match them
   * 2. lines are not matched at the first step -> do not match them
   * 3. lines are matched at the first step and not equal ->
   *   a. find all IW-equal lines in the same unmatched block
   *   b. find a maximum matching between them, maximising the amount of equal pairs
   *   c. match equal lines using the result of the previous step
   */

  const builder = new ExpandChangeBuilder(
    lines1,
    lines2,
    (index1, index2) => lines1[index1].equalityKey === lines2[index2].equalityKey
  );

  let sample: string | undefined;
  let last1 = 0;
  let last2 = 0;

  const iwEquals = (a: string | undefined, b: string): boolean =>
    a !== undefined && stripWhitespace(a) === stripWhitespace(b);

  const flush = (line1: number, line2: number): void => {
    if (sample === undefined) {
      return;
    }

    const start1 = Math.max(last1, builder.index1);
    const start2 = Math.max(last2, builder.index2);

    const subLines1: number[] = [];
    const subLines2: number[] = [];
    for (let i = start1; i < line1; i++) {
      if (iwEquals(sample, lines1[i].content)) {
        subLines1.push(i);
        last1 = i + 1;
      }
    }
    for (let i = start2; i < line2; i++) {
      if (iwEquals(sample, lines2[i].content)) {
        subLines2.push(i);
        last2 = i + 1;
      }
    }

    if (subLines1.length === 0 || subLines2.length === 0) {
      throw new Error('the sampled line must occur on both sides');
    }
    alignExactMatching(subLines1, subLines2);

    sample = undefined;
  };

  const alignExactMatching = (subLines1: readonly number[], subLines2: readonly number[]): void => {
    const n = Math.max(subLines1.length, subLines2.length);
    const skipAligning =
      n > 10 || // we use a brute-force algorithm (C_n_k). This limits the search space by ~250 cases.
      subLines1.length === subLines2.length; // nothing to do

    if (skipAligning) {
      const count = Math.min(subLines1.length, subLines2.length);
      for (let i = 0; i < count; i++) {
        const index1 = subLines1[i];
        const index2 = subLines2[i];
        if (lines1[index1].equalityKey === lines2[index2].equalityKey) {
          builder.markEqual(index1, index2);
        }
      }
      return;
    }

    if (subLines1.length < subLines2.length) {
      const matching = getBestMatchingAlignment(subLines1, subLines2, lines1, lines2);
      for (let i = 0; i < subLines1.length; i++) {
        const index1 = subLines1[i];
        const index2 = subLines2[matching[i]];
        if (lines1[index1].equalityKey === lines2[index2].equalityKey) {
          builder.markEqual(index1, index2);
        }
      }
    } else {
      const matching = getBestMatchingAlignment(subLines2, subLines1, lines2, lines1);
      for (let i = 0; i < subLines2.length; i++) {
        const index1 = subLines1[matching[i]];
        const index2 = subLines2[i];
        if (lines1[index1].equalityKey === lines2[index2].equalityKey) {
          builder.markEqual(index1, index2);
        }
      }
    }
  };

  for (const range of changes.iterateUnchanged()) {
    const count = range.end1 - range.start1;
    for (let i = 0; i < count; i++) {
      const index1 = range.start1 + i;
      const index2 = range.start2 + i;
      const line1 = lines1[index1];
      const line2 = lines2[index2];

      if (!iwEquals(sample, line1.content)) {
        if (line1.equalityKey === line2.equalityKey) {
          flush(index1, index2);
          builder.markEqual(index1, index2);
        } else {
          flush(index1, index2);
          sample = line1.content;
        }
      }
    }
  }
  flush(changes.length1, changes.length2);

  return fair(builder.finish());
}

function getBestMatchingAlignment(
  subLines1: readonly number[],
  subLines2: readonly number[],
  lines1: readonly Line[],
  lines2: readonly Line[]
): number[] {
  if (subLines1.length >= subLines2.length) {
    throw new Error('the first sub-line list must be the shorter one');
  }
  const size = subLines1.length;

  const comb = new Array<number>(size).fill(0);
  const best = Array.from({ length: size }, (_, i) => i);

  // find a combination with the maximum weight (maximum number of equal lines)
  let bestWeight = 0;

  const processCombination = (): void => {
    let weight = 0;
    for (let i = 0; i < size; i++) {
      const index1 = subLines1[i];
      const index2 = subLines2[comb[i]];
      if (lines1[index1].equalityKey === lines2[index2].equalityKey) {
        weight++;
      }
    }

    if (weight > bestWeight) {
      bestWeight = weight;
      for (let i = 0; i < comb.length; i++) {
        best[i] = comb[i];
      }
    }
  };

  const combinations = (start: number, n: number, k: number): void => {
    if (k === size) {
      processCombination();
      return;
    }

    for (let i = start; i <= n; i++) {
      comb[k] = i;
      combinations(i + 1, n, k + 1);
    }
  };

  combinations(0, subLines2.length - 1, 0);

  return best;
}

function optimizeLineChunks(
  lines1: readonly Line[],
  lines2: readonly Line[],
  iterable: IFairDiffIterable,
  indicator: ICancellationChecker
): IFairDiffIterable {
  return new LineChunkOptimizer(lines1, lines2, iterable, indicator).build();
}

/*
 * Compare lines in two steps:
 *  - compare ignoring "unimportant" lines
 *  - correct changes (compare all lines in gaps between the matched chunks)
 */
function compareSmart(
  lines1: readonly Line[],
  lines2: readonly Line[],
  indicator: ICancellationChecker
): IFairDiffIterable {
  const threshold = getUnimportantLineCharCount();
  if (threshold === 0) {
    return diff(lines1, lines2, indicator, (line) => line.equalityKey);
  }

  const [bigLines1, indexes1] = getBigLines(lines1, threshold);
  const [bigLines2, indexes2] = getBigLines(lines2, threshold);

  const changes = diff(bigLines1, bigLines2, indicator, (line) => line.equalityKey);
  return new SmartLineChangeCorrector(
    indexes1,
    indexes2,
    lines1,
    lines2,
    changes,
    indicator
  ).build();
}

function getBigLines(lines: readonly Line[], threshold: number): readonly [Line[], number[]] {
  const bigLines: Line[] = [];
  const indexes: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.nonSpaceChars > threshold) {
      bigLines.push(line);
      indexes.push(i);
    }
  }
  return [bigLines, indexes];
}

function expandRanges(
  lines1: readonly Line[],
  lines2: readonly Line[],
  iterable: IFairDiffIterable
): IFairDiffIterable {
  const changes: Range[] = [];

  for (const ch of iterable.iterateChanges()) {
    const expanded = expand(
      lines1,
      lines2,
      ch.start1,
      ch.start2,
      ch.end1,
      ch.end2,
      (index1, index2) => lines1[index1].equalityKey === lines2[index2].equalityKey
    );
    if (!expanded.isEmpty) {
      changes.push(expanded);
    }
  }

  return fair(create(changes, lines1.length, lines2.length));
}

//
// Lines
//

function getLines(text: readonly string[], policy: ComparisonPolicy): Line[] {
  return text.map((line) => new Line(line, policy));
}

function convertMode(original: readonly Line[], policy: ComparisonPolicy): Line[] {
  return original.map((line) => (line.policy !== policy ? new Line(line.content, policy) : line));
}

export function convertIntoMergeLineFragments(
  conflicts: readonly MergeRange[]
): IMergeLineFragment[] {
  return conflicts.map((range) => MergeLineFragmentImpl.fromRange(range));
}

export function convertIntoMergeLineFragmentsWithinRange(
  conflicts: readonly MergeRange[],
  range: MergeRange
): IMergeLineFragment[] {
  return conflicts.map(
    (conflict) =>
      new MergeLineFragmentImpl(
        conflict.start1 + range.start1,
        conflict.end1 + range.start1,
        conflict.start2 + range.start2,
        conflict.end2 + range.start2,
        conflict.start3 + range.start3,
        conflict.end3 + range.start3
      )
  );
}

function stripWhitespace(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    if (!isSpaceEnterOrTabAt(text, i)) {
      result += text[i];
    }
  }
  return result;
}

function trimWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpaceEnterOrTabAt(text, start)) {
    start++;
  }
  while (start < end && isSpaceEnterOrTabAt(text, end - 1)) {
    end--;
  }
  return text.substring(start, end);
}

export class Line {
  readonly nonSpaceChars: number;
  /** Lines are equal under their policy iff their keys are equal. */
  readonly equalityKey: string;

  constructor(
    readonly content: string,
    readonly policy: ComparisonPolicy
  ) {
    this.nonSpaceChars = countNonSpaceChars(content);
    switch (policy) {
      case ComparisonPolicy.DEFAULT:
        this.equalityKey = content;
        break;
      case ComparisonPolicy.TRIM_WHITESPACES:
        this.equalityKey = trimWhitespace(content);
        break;
      case ComparisonPolicy.IGNORE_WHITESPACES:
        this.equalityKey = stripWhitespace(content);
        break;
    }
  }
}

function countNonSpaceChars(text: string): number {
  let nonSpace = 0;
  for (let offset = 0; offset < text.length; offset++) {
    if (!isSpaceEnterOrTabAt(text, offset)) {
      nonSpace++;
    }
  }
  return nonSpace;
}
