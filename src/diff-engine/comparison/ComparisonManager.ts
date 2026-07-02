// Ported from intellij-community platform/diff-impl/src/com/intellij/diff/comparison/ComparisonManagerImpl.java
// (as free functions; the ignored-ranges lanes and the words-first registry branch are
// not ported). Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { DiffConfig } from '../diff/DiffConfig';
import { DiffFragmentImpl, IDiffFragment } from '../fragments/DiffFragment';
import { ILineFragment, LineFragmentImpl } from '../fragments/LineFragment';
import { IMergeLineFragment } from '../fragments/MergeLineFragment';
import { ILineOffsets, LineOffsetsImpl } from '../text/LineOffsets';
import { Range } from '../util/Range';
import * as ByCharRt from './ByCharRt';
import * as ByLineRt from './ByLineRt';
import * as ByWordRt from './ByWordRt';
import { ICancellationChecker } from './CancellationChecker';
import { ComparisonPolicy } from './ComparisonPolicy';
import { equalsTrimWhitespaces as equalsTrimWhitespacesLineAware } from './ComparisonUtil';
import { DiffTooBigException } from './DiffTooBigException';
import { IDiffIterable } from './iterables/DiffIterable';
import { equalsIgnoreWhitespaces as equalsIgnoreWhitespacesText } from './strings';

export type InnerFragmentsPolicy = 'NONE' | 'WORDS' | 'CHARS';

export function compareLines(
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): ILineFragment[] {
  const lineOffsets1 = LineOffsetsImpl.create(text1);
  const lineOffsets2 = LineOffsetsImpl.create(text2);
  return compareLinesWithOffsets(text1, text2, lineOffsets1, lineOffsets2, policy, indicator);
}

export function compareLinesWithOffsets(
  text1: string,
  text2: string,
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): ILineFragment[] {
  const boundaryRange = new Range(0, lineOffsets1.lineCount, 0, lineOffsets2.lineCount);
  return compareLinesRange(
    boundaryRange,
    text1,
    text2,
    lineOffsets1,
    lineOffsets2,
    policy,
    indicator
  );
}

export function compareLinesRange(
  boundaryRange: Range,
  text1: string,
  text2: string,
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): ILineFragment[] {
  const lineTexts1 = getLineContents(boundaryRange.start1, boundaryRange.end1, text1, lineOffsets1);
  const lineTexts2 = getLineContents(boundaryRange.start2, boundaryRange.end2, text2, lineOffsets2);

  const iterable = ByLineRt.compare(lineTexts1, lineTexts2, policy, indicator);
  return convertIntoLineFragments(boundaryRange, lineOffsets1, lineOffsets2, iterable);
}

export function compareLinesThreeside(
  text1: string,
  text2: string,
  text3: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IMergeLineFragment[] {
  const ranges = ByLineRt.compareThreeside(
    getAllLineContents(text1),
    getAllLineContents(text2),
    getAllLineContents(text3),
    policy,
    indicator
  );
  return ByLineRt.convertIntoMergeLineFragments(ranges);
}

export function mergeLines(
  text1: string,
  text2: string,
  text3: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IMergeLineFragment[] {
  const ranges = ByLineRt.merge(
    getAllLineContents(text1),
    getAllLineContents(text2),
    getAllLineContents(text3),
    policy,
    indicator
  );
  return ByLineRt.convertIntoMergeLineFragments(ranges);
}

export function compareLinesInner(
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker,
  fragmentsPolicy: InnerFragmentsPolicy = 'WORDS'
): ILineFragment[] {
  const lineFragments = compareLines(text1, text2, policy, indicator);
  return createInnerFragments(lineFragments, text1, text2, policy, fragmentsPolicy, indicator);
}

export function compareWords(
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IDiffFragment[] {
  return ByWordRt.compare(text1, text2, policy, indicator);
}

/** Line fragments built around the by-word delta rather than the by-line one. */
export function compareLinesWordFirst(
  text1: string,
  text2: string,
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): ILineFragment[] {
  const lineBlocks = ByWordRt.compareWordsFirst(
    text1,
    text2,
    lineOffsets1,
    lineOffsets2,
    policy,
    indicator
  );
  return lineBlocks.map((block) => {
    const lineRange = block.lineRange;
    const fragment = createLineFragment(
      lineRange.start1,
      lineRange.end1,
      lineRange.start2,
      lineRange.end2,
      lineOffsets1,
      lineOffsets2
    );
    return LineFragmentImpl.withInnerFragments(fragment, block.fragments);
  });
}

export function compareChars(
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IDiffFragment[] {
  return doCompareChars(text1, text2, policy, indicator);
}

function doCompareChars(
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IDiffFragment[] {
  let iterable: IDiffIterable;
  if (policy === ComparisonPolicy.DEFAULT) {
    iterable = ByCharRt.compareTwoStep(text1, text2, indicator);
  } else if (policy === ComparisonPolicy.TRIM_WHITESPACES) {
    iterable = ByCharRt.compareTrimWhitespaces(text1, text2, indicator);
  } else {
    iterable = ByCharRt.compareIgnoreWhitespaces(text1, text2, indicator);
  }

  return ByWordRt.convertIntoDiffFragments(iterable);
}

function createInnerFragments(
  lineFragments: readonly ILineFragment[],
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  fragmentsPolicy: InnerFragmentsPolicy,
  indicator: ICancellationChecker
): ILineFragment[] {
  const result: ILineFragment[] = [];

  let tooBigChunksCount = 0;
  for (const fragment of lineFragments) {
    if (fragment.innerFragments !== undefined) {
      throw new Error('line fragments must not already carry inner fragments');
    }

    try {
      // Do not try to build fine blocks after a few failures
      const tryComputeDifferences = tooBigChunksCount < DiffConfig.MAX_BAD_LINES;
      result.push(
        ...createInnerFragmentsForFragment(
          fragment,
          text1,
          text2,
          policy,
          fragmentsPolicy,
          indicator,
          tryComputeDifferences
        )
      );
    } catch (e) {
      if (!(e instanceof DiffTooBigException)) {
        throw e;
      }
      result.push(fragment);
      tooBigChunksCount++;
    }
  }

  return result;
}

function createInnerFragmentsForFragment(
  fragment: ILineFragment,
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  fragmentsPolicy: InnerFragmentsPolicy,
  indicator: ICancellationChecker,
  tryComputeDifferences: boolean
): ILineFragment[] {
  if (fragmentsPolicy === 'NONE') {
    return [fragment];
  }

  const subSequence1 = text1.substring(fragment.startOffset1, fragment.endOffset1);
  const subSequence2 = text2.substring(fragment.startOffset2, fragment.endOffset2);

  if (fragment.startLine1 === fragment.endLine1 || fragment.startLine2 === fragment.endLine2) {
    // Insertion / Deletion
    if (isEqualTextsForPolicy(subSequence1, subSequence2, policy)) {
      return [LineFragmentImpl.withInnerFragments(fragment, [])];
    }
    return [fragment];
  }

  if (!tryComputeDifferences) {
    return [fragment];
  }

  if (fragmentsPolicy === 'WORDS') {
    return createInnerWordFragments(fragment, subSequence1, subSequence2, policy, indicator);
  }
  return createInnerCharFragments(fragment, subSequence1, subSequence2, policy, indicator);
}

function createInnerWordFragments(
  fragment: ILineFragment,
  subSequence1: string,
  subSequence2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): ILineFragment[] {
  const lineBlocks = ByWordRt.compareAndSplit(subSequence1, subSequence2, policy, indicator);
  if (lineBlocks.length === 0) {
    throw new Error('compareAndSplit must produce at least one block');
  }

  const startOffset1 = fragment.startOffset1;
  const startOffset2 = fragment.startOffset2;

  let currentStartLine1 = fragment.startLine1;
  let currentStartLine2 = fragment.startLine2;

  const chunks: ILineFragment[] = [];
  for (let i = 0; i < lineBlocks.length; i++) {
    const block = lineBlocks[i];
    const offsets = block.offsets;

    // special case for the last line to avoid problems with an empty last line
    const currentEndLine1 =
      i !== lineBlocks.length - 1 ? currentStartLine1 + block.newlines1 : fragment.endLine1;
    const currentEndLine2 =
      i !== lineBlocks.length - 1 ? currentStartLine2 + block.newlines2 : fragment.endLine2;

    chunks.push(
      new LineFragmentImpl(
        currentStartLine1,
        currentEndLine1,
        currentStartLine2,
        currentEndLine2,
        offsets.start1 + startOffset1,
        offsets.end1 + startOffset1,
        offsets.start2 + startOffset2,
        offsets.end2 + startOffset2,
        block.fragments
      )
    );

    currentStartLine1 = currentEndLine1;
    currentStartLine2 = currentEndLine2;
  }
  return chunks;
}

function createInnerCharFragments(
  fragment: ILineFragment,
  subSequence1: string,
  subSequence2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): ILineFragment[] {
  const innerChanges = doCompareChars(subSequence1, subSequence2, policy, indicator);
  return [LineFragmentImpl.withInnerFragments(fragment, innerChanges)];
}

function isEqualTextsForPolicy(text1: string, text2: string, policy: ComparisonPolicy): boolean {
  switch (policy) {
    case ComparisonPolicy.DEFAULT:
      return text1 === text2;
    case ComparisonPolicy.TRIM_WHITESPACES:
      return equalsTrimWhitespacesLineAware(text1, text2);
    case ComparisonPolicy.IGNORE_WHITESPACES:
      return equalsIgnoreWhitespacesText(text1, text2);
  }
}

//
// Fragments
//

export function convertIntoLineFragments(
  boundaryRange: Range,
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets,
  changes: IDiffIterable
): ILineFragment[] {
  const fragments: ILineFragment[] = [];
  for (const range of changes.iterateChanges()) {
    const startLine1 = range.start1 + boundaryRange.start1;
    const startLine2 = range.start2 + boundaryRange.start2;
    const endLine1 = range.end1 + boundaryRange.start1;
    const endLine2 = range.end2 + boundaryRange.start2;
    fragments.push(
      createLineFragment(startLine1, endLine1, startLine2, endLine2, lineOffsets1, lineOffsets2)
    );
  }
  return fragments;
}

export function createLineFragment(
  startLine1: number,
  endLine1: number,
  startLine2: number,
  endLine2: number,
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets
): ILineFragment {
  const offsets1 = getOffsets(lineOffsets1, startLine1, endLine1);
  const offsets2 = getOffsets(lineOffsets2, startLine2, endLine2);
  return new LineFragmentImpl(
    startLine1,
    endLine1,
    startLine2,
    endLine2,
    offsets1[0],
    offsets1[1],
    offsets2[0],
    offsets2[1]
  );
}

function getOffsets(
  lineOffsets: ILineOffsets,
  startIndex: number,
  endIndex: number
): readonly [number, number] {
  if (startIndex === endIndex) {
    const offset =
      startIndex < lineOffsets.lineCount
        ? lineOffsets.getLineStart(startIndex)
        : lineOffsets.getLineEnd(lineOffsets.lineCount - 1, true);
    return [offset, offset];
  }
  const offset1 = lineOffsets.getLineStart(startIndex);
  const offset2 = lineOffsets.getLineEnd(endIndex - 1, true);
  return [offset1, offset2];
}

//
// Post process line fragments
//

export function squash(oldFragments: readonly ILineFragment[]): ILineFragment[] {
  if (oldFragments.length === 0) {
    return [...oldFragments];
  }

  const newFragments: ILineFragment[] = [];
  processAdjoining(oldFragments, (fragments) => newFragments.push(doSquash(fragments)));
  return newFragments;
}

export function processBlocks(
  oldFragments: readonly ILineFragment[],
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  shouldSquash: boolean,
  trim: boolean
): ILineFragment[] {
  if (!shouldSquash && !trim) {
    return [...oldFragments];
  }
  if (oldFragments.length === 0) {
    return [...oldFragments];
  }

  const newFragments: ILineFragment[] = [];
  processAdjoining(oldFragments, (fragments) =>
    newFragments.push(...processAdjoiningBlock(fragments, text1, text2, policy, shouldSquash, trim))
  );
  return newFragments;
}

function processAdjoining(
  oldFragments: readonly ILineFragment[],
  consumer: (fragments: readonly ILineFragment[]) => void
): void {
  let startIndex = 0;
  for (let i = 1; i < oldFragments.length; i++) {
    if (!isAdjoining(oldFragments[i - 1], oldFragments[i])) {
      consumer(oldFragments.slice(startIndex, i));
      startIndex = i;
    }
  }
  if (startIndex < oldFragments.length) {
    consumer(oldFragments.slice(startIndex));
  }
}

function processAdjoiningBlock(
  fragments: readonly ILineFragment[],
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  shouldSquash: boolean,
  trim: boolean
): ILineFragment[] {
  let start = 0;
  let end = fragments.length;

  if (trim && policy === ComparisonPolicy.IGNORE_WHITESPACES) {
    while (start < end) {
      const fragment = fragments[start];
      const sequence1 = text1.substring(fragment.startOffset1, fragment.endOffset1);
      const sequence2 = text2.substring(fragment.startOffset2, fragment.endOffset2);

      if (
        (fragment.innerFragments === undefined || fragment.innerFragments.length !== 0) &&
        !equalsIgnoreWhitespacesText(sequence1, sequence2)
      ) {
        break;
      }
      start++;
    }
    while (start < end) {
      const fragment = fragments[end - 1];
      const sequence1 = text1.substring(fragment.startOffset1, fragment.endOffset1);
      const sequence2 = text2.substring(fragment.startOffset2, fragment.endOffset2);

      if (
        (fragment.innerFragments === undefined || fragment.innerFragments.length !== 0) &&
        !equalsIgnoreWhitespacesText(sequence1, sequence2)
      ) {
        break;
      }
      end--;
    }
  }

  if (start === end) {
    return [];
  }
  if (shouldSquash) {
    return [doSquash(fragments.slice(start, end))];
  }
  return fragments.slice(start, end);
}

function doSquash(oldFragments: readonly ILineFragment[]): ILineFragment {
  if (oldFragments.length === 0) {
    throw new Error('cannot squash an empty fragment list');
  }
  if (oldFragments.length === 1) {
    return oldFragments[0];
  }

  const firstFragment = oldFragments[0];
  const lastFragment = oldFragments[oldFragments.length - 1];

  const newInnerFragments: IDiffFragment[] = [];
  for (const fragment of oldFragments) {
    for (const innerFragment of extractInnerFragments(fragment)) {
      const shift1 = fragment.startOffset1 - firstFragment.startOffset1;
      const shift2 = fragment.startOffset2 - firstFragment.startOffset2;

      const previousFragment =
        newInnerFragments.length === 0
          ? undefined
          : newInnerFragments[newInnerFragments.length - 1];
      if (
        previousFragment === undefined ||
        !isAdjoiningInner(previousFragment, innerFragment, shift1, shift2)
      ) {
        newInnerFragments.push(
          new DiffFragmentImpl(
            innerFragment.startOffset1 + shift1,
            innerFragment.endOffset1 + shift1,
            innerFragment.startOffset2 + shift2,
            innerFragment.endOffset2 + shift2
          )
        );
      } else {
        newInnerFragments.pop();
        newInnerFragments.push(
          new DiffFragmentImpl(
            previousFragment.startOffset1,
            innerFragment.endOffset1 + shift1,
            previousFragment.startOffset2,
            innerFragment.endOffset2 + shift2
          )
        );
      }
    }
  }

  return new LineFragmentImpl(
    firstFragment.startLine1,
    lastFragment.endLine1,
    firstFragment.startLine2,
    lastFragment.endLine2,
    firstFragment.startOffset1,
    lastFragment.endOffset1,
    firstFragment.startOffset2,
    lastFragment.endOffset2,
    newInnerFragments
  );
}

function isAdjoining(beforeFragment: ILineFragment, afterFragment: ILineFragment): boolean {
  return (
    beforeFragment.endLine1 === afterFragment.startLine1 &&
    beforeFragment.endLine2 === afterFragment.startLine2 &&
    beforeFragment.endOffset1 === afterFragment.startOffset1 &&
    beforeFragment.endOffset2 === afterFragment.startOffset2
  );
}

function isAdjoiningInner(
  beforeFragment: IDiffFragment,
  afterFragment: IDiffFragment,
  shift1: number,
  shift2: number
): boolean {
  return (
    beforeFragment.endOffset1 === afterFragment.startOffset1 + shift1 &&
    beforeFragment.endOffset2 === afterFragment.startOffset2 + shift2
  );
}

function extractInnerFragments(lineFragment: ILineFragment): readonly IDiffFragment[] {
  if (lineFragment.innerFragments !== undefined) {
    return lineFragment.innerFragments;
  }

  const length1 = lineFragment.endOffset1 - lineFragment.startOffset1;
  const length2 = lineFragment.endOffset2 - lineFragment.startOffset2;
  return [new DiffFragmentImpl(0, length1, 0, length2)];
}

//
// Lines
//

function getAllLineContents(text: string): string[] {
  const lineOffsets = LineOffsetsImpl.create(text);
  return getLineContents(0, lineOffsets.lineCount, text, lineOffsets);
}

function getLineContents(
  start: number,
  end: number,
  text: string,
  lineOffsets: ILineOffsets
): string[] {
  const lines: string[] = [];
  for (let line = start; line < end; line++) {
    lines.push(text.substring(lineOffsets.getLineStart(line), lineOffsets.getLineEnd(line)));
  }
  return lines;
}
