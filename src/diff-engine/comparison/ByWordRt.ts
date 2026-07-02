// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ByWordRt.kt
// (the InlineChunk family lives in wordChunks.ts, the whitespace correctors in
// whitespaceCorrectors.ts). Copyright 2000-2024 JetBrains s.r.o. and contributors.
// Apache 2.0 license.

import { DiffFragmentImpl, IDiffFragment } from '../fragments/DiffFragment';
import { IMergeWordFragment, MergeWordFragmentImpl } from '../fragments/MergeWordFragment';
import { ILineOffsets } from '../text/LineOffsets';
import { getLinesRange } from '../util/DiffRangeUtil';
import { MergeRange } from '../util/MergeRange';
import { Range } from '../util/Range';
import * as ByCharRt from './ByCharRt';
import { ICancellationChecker } from './CancellationChecker';
import { WordChunkOptimizer } from './ChunkOptimizer';
import { ComparisonPolicy } from './ComparisonPolicy';
import * as ComparisonMergeUtil from './ComparisonMergeUtil';
import { isEqualTexts } from './ComparisonUtil';
import { IDiffIterable, IFairDiffIterable } from './iterables/DiffIterable';
import { ChangeBuilder, createUnchanged, diff, fair } from './iterables/DiffIterableUtil';
import { SubiterableDiffIterable } from './iterables/SubiterableDiffIterable';
import { LineFragmentSplitter, WordBlock } from './LineFragmentSplitter';
import {
  DefaultCorrector,
  IgnoreSpacesCorrector,
  MergeDefaultCorrector,
  MergeIgnoreSpacesCorrector,
  MergeTrimSpacesCorrector,
  TrimSpacesCorrector,
} from './whitespaceCorrectors';
import {
  countNewlines,
  getInlineChunks,
  IInlineChunk,
  NewlineChunk,
  WordChunk,
} from './wordChunks';

const chunkKey = (chunk: IInlineChunk): string => chunk.equalityKey;

export function compare(
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IDiffFragment[] {
  indicator.checkCanceled();

  const words1 = getInlineChunks(text1);
  const words2 = getInlineChunks(text2);

  return compareChunks(text1, words1, text2, words2, policy, indicator);
}

export function compareChunks(
  text1: string,
  words1: readonly IInlineChunk[],
  text2: string,
  words2: readonly IInlineChunk[],
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IDiffFragment[] {
  let wordChanges = diff(words1, words2, indicator, chunkKey);
  wordChanges = optimizeWordChunks(text1, text2, words1, words2, wordChanges, indicator);

  const delimitersIterable = matchAdjustmentDelimiters(
    text1,
    text2,
    words1,
    words2,
    wordChanges,
    0,
    0,
    indicator
  );
  const iterable = matchAdjustmentWhitespaces(text1, text2, delimitersIterable, policy, indicator);

  return convertIntoDiffFragments(iterable);
}

export function compareThreeside(
  text1: string,
  text2: string,
  text3: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IMergeWordFragment[] {
  indicator.checkCanceled();

  const words1 = getInlineChunks(text1);
  const words2 = getInlineChunks(text2);
  const words3 = getInlineChunks(text3);

  let wordChanges1 = diff(words2, words1, indicator, chunkKey);
  wordChanges1 = optimizeWordChunks(text2, text1, words2, words1, wordChanges1, indicator);
  const iterable1 = matchAdjustmentDelimiters(
    text2,
    text1,
    words2,
    words1,
    wordChanges1,
    0,
    0,
    indicator
  );

  let wordChanges2 = diff(words2, words3, indicator, chunkKey);
  wordChanges2 = optimizeWordChunks(text2, text3, words2, words3, wordChanges2, indicator);
  const iterable2 = matchAdjustmentDelimiters(
    text2,
    text3,
    words2,
    words3,
    wordChanges2,
    0,
    0,
    indicator
  );

  const wordConflicts = ComparisonMergeUtil.buildSimple(iterable1, iterable2, indicator);
  const result = matchAdjustmentWhitespaces3(text1, text2, text3, wordConflicts, policy, indicator);

  return convertIntoMergeWordFragments(result);
}

export class LineBlock {
  constructor(
    readonly fragments: readonly IDiffFragment[],
    readonly offsets: Range,
    readonly newlines1: number,
    readonly newlines2: number
  ) {}
}

export class WordLineBlock {
  constructor(
    readonly lineRange: Range,
    readonly fragments: readonly IDiffFragment[]
  ) {}
}

export function compareAndSplit(
  text1: string,
  text2: string,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): LineBlock[] {
  indicator.checkCanceled();

  const words1 = getInlineChunks(text1);
  const words2 = getInlineChunks(text2);

  let wordChanges = diff(words1, words2, indicator, chunkKey);
  wordChanges = optimizeWordChunks(text1, text2, words1, words2, wordChanges, indicator);

  const wordBlocks = new LineFragmentSplitter(
    text1,
    text2,
    words1,
    words2,
    wordChanges,
    indicator
  ).run();

  const subIterables = collectWordBlockSubIterables(wordChanges, wordBlocks);

  const lineBlocks: LineBlock[] = [];
  for (let i = 0; i < wordBlocks.length; i++) {
    const block = wordBlocks[i];
    const offsets = block.offsets;
    const words = block.words;

    const subtext1 = text1.substring(offsets.start1, offsets.end1);
    const subtext2 = text2.substring(offsets.start2, offsets.end2);

    const subwords1 = words1.slice(words.start1, words.end1);
    const subwords2 = words2.slice(words.start2, words.end2);

    const subiterable = subIterables[i];

    const delimitersIterable = matchAdjustmentDelimiters(
      subtext1,
      subtext2,
      subwords1,
      subwords2,
      subiterable,
      offsets.start1,
      offsets.start2,
      indicator
    );
    const iterable = matchAdjustmentWhitespaces(
      subtext1,
      subtext2,
      delimitersIterable,
      policy,
      indicator
    );

    const fragments = convertIntoDiffFragments(iterable);

    const newlines1 = countNewlines(subwords1);
    const newlines2 = countNewlines(subwords2);

    lineBlocks.push(new LineBlock(fragments, offsets, newlines1, newlines2));
  }

  return lineBlocks;
}

function collectWordBlockSubIterables(
  wordChanges: IFairDiffIterable,
  wordBlocks: readonly WordBlock[]
): IFairDiffIterable[] {
  const changed: Range[] = [];
  for (const range of wordChanges.iterateChanges()) {
    changed.push(range);
  }

  let index = 0;

  const subIterables: IFairDiffIterable[] = [];
  for (const block of wordBlocks) {
    const words = block.words;

    while (index < changed.length) {
      const range = changed[index];
      if (range.end1 < words.start1 || range.end2 < words.start2) {
        index++;
        continue;
      }

      break;
    }

    subIterables.push(
      fair(
        new SubiterableDiffIterable(
          changed,
          words.start1,
          words.end1,
          words.start2,
          words.end2,
          index
        )
      )
    );
  }
  return subIterables;
}

/**
 * Constructs 'lines + words' differences while giving priority to the 'words' delta.
 *
 * This works better than compare() for inputs that have no matching lines (and get
 * dragged away by the empty lines as a result). For example, 'Java -> Kotlin'
 * conversions (the latter has no trailing ';'), or text in natural language with manual
 * line wrapping that is inconsistent between the compared texts.
 */
export function compareWordsFirst(
  text1: string,
  text2: string,
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): WordLineBlock[] {
  const words1 = getInlineChunks(text1).filter((chunk) => chunk instanceof WordChunk);
  const words2 = getInlineChunks(text2).filter((chunk) => chunk instanceof WordChunk);

  let wordChanges = diff(words1, words2, indicator, chunkKey);
  wordChanges = optimizeWordChunks(text1, text2, words1, words2, wordChanges, indicator);

  const delimitersIterable = matchAdjustmentDelimiters(
    text1,
    text2,
    words1,
    words2,
    wordChanges,
    0,
    0,
    indicator
  );

  const lineBlocks = new LineUplifter(
    text1,
    text2,
    lineOffsets1,
    lineOffsets2,
    delimitersIterable,
    indicator
  ).build();

  const subIterables = collectLineBlockSubIterables(
    delimitersIterable,
    lineBlocks,
    lineOffsets1,
    lineOffsets2
  );

  const result: WordLineBlock[] = [];
  for (let i = 0; i < lineBlocks.length; i++) {
    const lineBlock = lineBlocks[i];
    const subIterable = subIterables[i];

    const subRange1 = getLinesRange(lineOffsets1, lineBlock.start1, lineBlock.end1, true);
    const subRange2 = getLinesRange(lineOffsets2, lineBlock.start2, lineBlock.end2, true);

    const subtext1 = text1.substring(subRange1.startOffset, subRange1.endOffset);
    const subtext2 = text2.substring(subRange2.startOffset, subRange2.endOffset);

    const iterable = matchAdjustmentWhitespaces(subtext1, subtext2, subIterable, policy, indicator);

    const innerFragments = convertIntoDiffFragments(iterable);
    if (innerFragments.length === 0) {
      continue;
    }

    // workaround 'include newline' desync for the last modification in delta
    if (lineBlock.start1 !== lineBlock.end1 && lineBlock.start2 !== lineBlock.end2) {
      if (
        lineBlock.end1 === lineOffsets1.lineCount &&
        lineBlock.end2 !== lineOffsets2.lineCount &&
        subtext2.endsWith('\n')
      ) {
        if (isEqualTexts(subtext1, subtext2.substring(0, subtext2.length - 1), policy)) {
          continue;
        }
      }
      if (
        lineBlock.end2 === lineOffsets2.lineCount &&
        lineBlock.end1 !== lineOffsets1.lineCount &&
        subtext1.endsWith('\n')
      ) {
        if (isEqualTexts(subtext1.substring(0, subtext1.length - 1), subtext2, policy)) {
          continue;
        }
      }
    }

    result.push(new WordLineBlock(lineBlock, innerFragments));
  }

  return result;
}

function collectLineBlockSubIterables(
  iterable: IFairDiffIterable,
  lineBlocks: readonly Range[],
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets
): IFairDiffIterable[] {
  const changed: Range[] = [];
  for (const range of iterable.iterateChanges()) {
    changed.push(range);
  }

  let index = 0;

  const subIterables: IFairDiffIterable[] = [];
  for (const lineBlock of lineBlocks) {
    const subRange1 = getLinesRange(lineOffsets1, lineBlock.start1, lineBlock.end1, true);
    const subRange2 = getLinesRange(lineOffsets2, lineBlock.start2, lineBlock.end2, true);

    while (index < changed.length) {
      const range = changed[index];
      if (range.end1 < subRange1.startOffset || range.end2 < subRange2.startOffset) {
        index++;
        continue;
      }

      break;
    }

    subIterables.push(
      fair(
        new SubiterableDiffIterable(
          changed,
          subRange1.startOffset,
          subRange1.endOffset,
          subRange2.startOffset,
          subRange2.endOffset,
          index
        )
      )
    );
  }
  return subIterables;
}

/**
 * Collects 'changed line blocks' that correspond to the given 'by-word differences'.
 *
 * The result is 'good enough' and may not be optimal from the human's point of view.
 * For example, it leaves the 'unmatched empty lines' inside an unmatched block, when a
 * human would match these empty lines, breaking the changed block into two changed
 * blocks. The correct answer may depend on the context, so we can't blindly match these
 * as post-processing.
 */
export class LineUplifter {
  private readonly lineBlocks: Range[] = [];

  private blockStart1 = 0;
  private blockStart2 = 0;

  constructor(
    private readonly text1: string,
    private readonly text2: string,
    private readonly lineOffsets1: ILineOffsets,
    private readonly lineOffsets2: ILineOffsets,
    private readonly changes: IFairDiffIterable,
    _indicator: ICancellationChecker
  ) {}

  build(): Range[] {
    this.execute();
    return this.lineBlocks;
  }

  private execute(): void {
    let lastIndex1 = -1;
    let lastIndex2 = -1;

    // The possible offset ranges are [-1, textLength + 1) to indicate that the walk has
    // reached the text boundaries. We have an imaginary '\n' at the '-1' and 'textLength'
    // offsets.

    // Walk from 'unchanged' regions deeper into the 'changed' territory, searching for
    // '\n' or text end. For each walk we find the 'closest' and 'furthest' newline,
    // aborting the walk at the first non-whitespace symbol. We try to add two blocks -
    // one with the 'unchanged' fragment, and one that contains whitespace-only changes,
    // if any.

    for (const range of this.changes.iterateUnchanged()) {
      const pair = this.walkForward(lastIndex1, lastIndex2, range.start1, range.start2);
      if (pair !== undefined) {
        this.walkBackward(pair[0], pair[1], range.start1, range.start2);
      } else {
        this.walkBackward(lastIndex1, lastIndex2, range.start1, range.start2);
      }
      lastIndex1 = range.end1;
      lastIndex2 = range.end2;
    }

    const textEnd1 = this.text1.length + 1;
    const textEnd2 = this.text2.length + 1;
    const pair = this.walkForward(lastIndex1, lastIndex2, textEnd1, textEnd2);
    if (pair !== undefined) {
      this.walkBackward(pair[0], pair[1], textEnd1, textEnd2);
    } else {
      this.walkBackward(lastIndex1, lastIndex2, textEnd1, textEnd2);
    }
    this.markNextBlock(this.lineOffsets1.lineCount, this.lineOffsets2.lineCount);
  }

  /** @returns offsets of the nearest block, if found */
  private walkForward(
    start1: number,
    start2: number,
    end1: number,
    end2: number
  ): readonly [number, number] | undefined {
    // match the current 'changed block' edge
    const foundFirst1 = walkSideForward(this.text1, start1, end1);
    if (foundFirst1 === undefined) {
      return undefined;
    }
    const foundFirst2 = walkSideForward(this.text2, start2, end2);
    if (foundFirst2 === undefined) {
      return undefined;
    }

    // match the paired empty lines
    let match1 = foundFirst1;
    let match2 = foundFirst2;
    for (;;) {
      const next1 = walkSideForward(this.text1, match1 + 1, end1);
      const next2 = walkSideForward(this.text2, match2 + 1, end2);
      if (next1 === undefined || next2 === undefined) {
        break;
      }
      match1 = next1;
      match2 = next2;
    }

    // do not match unpaired empty lines during the forward walk if they can be used by the backward walk later
    if (match1 === end1 - 1 || match2 === end2 - 1) {
      // match unpaired empty lines if we fully cover the area
      if (
        match1 !== end1 - 1 &&
        charAt(this.text1, end1 - 1) === '\n' &&
        areAllLinesEmpty(this.text1, match1, end1)
      ) {
        match1 = end1 - 1;
      }
      if (
        match2 !== end2 - 1 &&
        charAt(this.text2, end2 - 1) === '\n' &&
        areAllLinesEmpty(this.text2, match2, end2)
      ) {
        match2 = end2 - 1;
      }
    }

    this.markNextBlockOffset(foundFirst1, foundFirst2);
    this.markNextBlockOffset(match1, match2);
    return [match1, match2];
  }

  private walkBackward(start1: number, start2: number, end1: number, end2: number): void {
    // match the current 'changed block' edge
    const foundFirst1 = walkSideBackward(this.text1, start1, end1);
    if (foundFirst1 === undefined) {
      return;
    }
    const foundFirst2 = walkSideBackward(this.text2, start2, end2);
    if (foundFirst2 === undefined) {
      return;
    }

    // match all the remaining empty lines as a separate block
    let foundLast1 = foundFirst1;
    for (;;) {
      const next = walkSideBackward(this.text1, start1, foundLast1);
      if (next === undefined) {
        break;
      }
      foundLast1 = next;
    }

    let foundLast2 = foundFirst2;
    for (;;) {
      const next = walkSideBackward(this.text2, start2, foundLast2);
      if (next === undefined) {
        break;
      }
      foundLast2 = next;
    }

    this.markNextBlockOffset(foundLast1, foundLast2);
    this.markNextBlockOffset(foundFirst1, foundFirst2);
  }

  private markNextBlockOffset(blockEndOffset1: number, blockEndOffset2: number): void {
    const blockEnd1 = getBlockEndLine(blockEndOffset1, this.lineOffsets1);
    const blockEnd2 = getBlockEndLine(blockEndOffset2, this.lineOffsets2);
    this.markNextBlock(blockEnd1, blockEnd2);
  }

  private markNextBlock(blockEnd1: number, blockEnd2: number): void {
    if (this.blockStart1 === blockEnd1 && this.blockStart2 === blockEnd2) {
      return;
    }

    this.lineBlocks.push(new Range(this.blockStart1, blockEnd1, this.blockStart2, blockEnd2));
    this.blockStart1 = blockEnd1;
    this.blockStart2 = blockEnd2;
  }
}

function areAllLinesEmpty(text: string, start: number, end: number): boolean {
  for (let index = start; index < end; index++) {
    const ch = charAt(text, index);
    if (ch !== '\n' && ch !== '\t' && ch !== ' ') {
      return false;
    }
  }
  return true;
}

function walkSideForward(text: string, start: number, end: number): number | undefined {
  for (let index = start; index < end; index++) {
    const ch = charAt(text, index);
    if (ch === '\n') {
      return index;
    }
    if (ch !== '\t' && ch !== ' ') {
      return undefined;
    }
  }
  return undefined;
}

function walkSideBackward(text: string, start: number, end: number): number | undefined {
  for (let index = end - 1; index >= start; index--) {
    const ch = charAt(text, index);
    if (ch === '\n') {
      return index;
    }
    if (ch !== '\t' && ch !== ' ') {
      return undefined;
    }
  }
  return undefined;
}

function charAt(text: string, offset: number): string {
  if (offset === -1) {
    return '\n';
  }
  if (offset === text.length) {
    return '\n';
  }
  return text[offset];
}

function getBlockEndLine(offset: number, lineOffsets: ILineOffsets): number {
  if (offset === -1) {
    return 0;
  }
  if (offset === lineOffsets.textLength) {
    return lineOffsets.lineCount;
  }
  return lineOffsets.getLineNumber(offset) + 1;
}

//
// Impl
//

function optimizeWordChunks(
  text1: string,
  text2: string,
  words1: readonly IInlineChunk[],
  words2: readonly IInlineChunk[],
  iterable: IFairDiffIterable,
  indicator: ICancellationChecker
): IFairDiffIterable {
  return new WordChunkOptimizer(words1, words2, text1, text2, iterable, indicator).build();
}

function matchAdjustmentDelimiters(
  text1: string,
  text2: string,
  words1: readonly IInlineChunk[],
  words2: readonly IInlineChunk[],
  changes: IFairDiffIterable,
  startShift1: number,
  startShift2: number,
  indicator: ICancellationChecker
): IFairDiffIterable {
  return new AdjustmentPunctuationMatcher(
    text1,
    text2,
    words1,
    words2,
    startShift1,
    startShift2,
    changes,
    indicator
  ).build();
}

function matchAdjustmentWhitespaces(
  text1: string,
  text2: string,
  iterable: IFairDiffIterable,
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): IDiffIterable {
  switch (policy) {
    case ComparisonPolicy.DEFAULT:
      return new DefaultCorrector(iterable, text1, text2, indicator).build();
    case ComparisonPolicy.TRIM_WHITESPACES: {
      const defaultIterable = new DefaultCorrector(iterable, text1, text2, indicator).build();
      return new TrimSpacesCorrector(defaultIterable, text1, text2, indicator).build();
    }
    case ComparisonPolicy.IGNORE_WHITESPACES:
      return new IgnoreSpacesCorrector(iterable, text1, text2, indicator).build();
  }
}

function matchAdjustmentWhitespaces3(
  text1: string,
  text2: string,
  text3: string,
  conflicts: readonly MergeRange[],
  policy: ComparisonPolicy,
  indicator: ICancellationChecker
): MergeRange[] {
  switch (policy) {
    case ComparisonPolicy.DEFAULT:
      return new MergeDefaultCorrector(conflicts, text1, text2, text3, indicator).build();
    case ComparisonPolicy.TRIM_WHITESPACES: {
      const defaultConflicts = new MergeDefaultCorrector(
        conflicts,
        text1,
        text2,
        text3,
        indicator
      ).build();
      return new MergeTrimSpacesCorrector(defaultConflicts, text1, text2, text3, indicator).build();
    }
    case ComparisonPolicy.IGNORE_WHITESPACES:
      return new MergeIgnoreSpacesCorrector(conflicts, text1, text2, text3, indicator).build();
  }
}

export function convertIntoMergeWordFragments(
  conflicts: readonly MergeRange[]
): IMergeWordFragment[] {
  return conflicts.map((range) => MergeWordFragmentImpl.fromRange(range));
}

export function convertIntoDiffFragments(changes: IDiffIterable): IDiffFragment[] {
  const fragments: IDiffFragment[] = [];
  for (const ch of changes.iterateChanges()) {
    fragments.push(new DiffFragmentImpl(ch.start1, ch.end1, ch.start2, ch.end2));
  }
  return fragments;
}

/*
 * Compare one char sequence with two others (as if they were a single sequence).
 *
 * Returns two DiffIterables: (0, len1) - (0, len21) and (0, len1) - (0, len22).
 */
function comparePunctuation2Side(
  text1: string,
  text21: string,
  text22: string,
  indicator: ICancellationChecker
): readonly [IFairDiffIterable, IFairDiffIterable] {
  const text2 = text21 + text22;
  const changes = ByCharRt.comparePunctuation(text1, text2, indicator);

  const [ranges1, ranges2] = splitIterable2Side(changes, text21.length);

  const iterable1 = fair(createUnchanged(ranges1, text1.length, text21.length));
  const iterable2 = fair(createUnchanged(ranges2, text1.length, text22.length));
  return [iterable1, iterable2];
}

function splitIterable2Side(
  changes: IFairDiffIterable,
  offset: number
): readonly [Range[], Range[]] {
  const ranges1: Range[] = [];
  const ranges2: Range[] = [];
  for (const ch of changes.iterateUnchanged()) {
    if (ch.end2 <= offset) {
      ranges1.push(new Range(ch.start1, ch.end1, ch.start2, ch.end2));
    } else if (ch.start2 >= offset) {
      ranges2.push(new Range(ch.start1, ch.end1, ch.start2 - offset, ch.end2 - offset));
    } else {
      const len2 = offset - ch.start2;
      ranges1.push(new Range(ch.start1, ch.start1 + len2, ch.start2, offset));
      ranges2.push(new Range(ch.start1 + len2, ch.end1, 0, ch.end2 - offset));
    }
  }
  return [ranges1, ranges2];
}

//
// Punctuation matching
//

/*
 * sample: "[ X { A ! B } Y ]" "( X ... Y )" will lead to comparison of 3 groups of separators
 *      "["  vs "(",
 *      "{" + "}" vs "..."
 *      "]"  vs ")"
 */
class AdjustmentPunctuationMatcher {
  private readonly len1: number;
  private readonly len2: number;
  private readonly builder: ChangeBuilder;

  private lastStart1 = 0;
  private lastStart2 = 0;
  private lastEnd1 = 0;
  private lastEnd2 = 0;

  constructor(
    private readonly text1: string,
    private readonly text2: string,
    private readonly words1: readonly IInlineChunk[],
    private readonly words2: readonly IInlineChunk[],
    private readonly startShift1: number,
    private readonly startShift2: number,
    private readonly changes: IFairDiffIterable,
    private readonly indicator: ICancellationChecker
  ) {
    this.len1 = text1.length;
    this.len2 = text2.length;
    this.builder = new ChangeBuilder(this.len1, this.len2);
  }

  build(): IFairDiffIterable {
    this.execute();
    return fair(this.builder.finish());
  }

  private execute(): void {
    this.clearLastRange();

    this.matchForwardIndexed(-1, -1);

    for (const ch of this.changes.iterateUnchanged()) {
      const count = ch.end1 - ch.start1;
      for (let i = 0; i < count; i++) {
        const index1 = ch.start1 + i;
        const index2 = ch.start2 + i;

        const start1 = this.getStartOffset1(index1);
        const start2 = this.getStartOffset2(index2);
        const end1 = this.getEndOffset1(index1);
        const end2 = this.getEndOffset2(index2);

        this.matchBackwardIndexed(index1, index2);

        this.builder.markEqualRange(start1, start2, end1, end2);

        this.matchForwardIndexed(index1, index2);
      }
    }

    this.matchBackwardIndexed(this.words1.length, this.words2.length);
  }

  private clearLastRange(): void {
    this.lastStart1 = -1;
    this.lastStart2 = -1;
    this.lastEnd1 = -1;
    this.lastEnd2 = -1;
  }

  private matchBackwardIndexed(index1: number, index2: number): void {
    const start1 = index1 === 0 ? 0 : this.getEndOffset1(index1 - 1);
    const start2 = index2 === 0 ? 0 : this.getEndOffset2(index2 - 1);
    const end1 = index1 === this.words1.length ? this.len1 : this.getStartOffset1(index1);
    const end2 = index2 === this.words2.length ? this.len2 : this.getStartOffset2(index2);

    this.matchBackward(start1, start2, end1, end2);
    this.clearLastRange();
  }

  private matchForwardIndexed(index1: number, index2: number): void {
    const start1 = index1 === -1 ? 0 : this.getEndOffset1(index1);
    const start2 = index2 === -1 ? 0 : this.getEndOffset2(index2);
    const end1 = index1 + 1 === this.words1.length ? this.len1 : this.getStartOffset1(index1 + 1);
    const end2 = index2 + 1 === this.words2.length ? this.len2 : this.getStartOffset2(index2 + 1);

    this.matchForward(start1, start2, end1, end2);
  }

  private matchForward(start1: number, start2: number, end1: number, end2: number): void {
    if (
      this.lastStart1 !== -1 ||
      this.lastStart2 !== -1 ||
      this.lastEnd1 !== -1 ||
      this.lastEnd2 !== -1
    ) {
      throw new Error('previous range was not consumed');
    }

    this.lastStart1 = start1;
    this.lastStart2 = start2;
    this.lastEnd1 = end1;
    this.lastEnd2 = end2;
  }

  private matchBackward(start1: number, start2: number, end1: number, end2: number): void {
    if (
      this.lastStart1 === -1 ||
      this.lastStart2 === -1 ||
      this.lastEnd1 === -1 ||
      this.lastEnd2 === -1
    ) {
      throw new Error('no range to match against');
    }

    if (this.lastStart1 === start1 && this.lastStart2 === start2) {
      // pair of adjustment matched words, match the gap between ("A B" - "A B")
      if (this.lastEnd1 !== end1 || this.lastEnd2 !== end2) {
        throw new Error('matched gaps must be identical');
      }

      this.matchRange(start1, start2, end1, end2);
      return;
    }
    if (this.lastStart1 < start1 && this.lastStart2 < start2) {
      // pair of matched words, with a few unmatched ones between ("A X B" - "A Y B")
      if (this.lastEnd1 > start1 || this.lastEnd2 > start2) {
        throw new Error('gaps must not overlap');
      }

      this.matchRange(this.lastStart1, this.lastStart2, this.lastEnd1, this.lastEnd2);
      this.matchRange(start1, start2, end1, end2);
      return;
    }

    // one side adjustment, and the other has non-matched words between ("A B" - "A Y B")
    this.matchComplexRange(
      this.lastStart1,
      this.lastStart2,
      this.lastEnd1,
      this.lastEnd2,
      start1,
      start2,
      end1,
      end2
    );
  }

  private matchRange(start1: number, start2: number, end1: number, end2: number): void {
    if (start1 === end1 && start2 === end2) {
      return;
    }

    const sequence1 = this.text1.substring(start1, end1);
    const sequence2 = this.text2.substring(start2, end2);

    const changes = ByCharRt.comparePunctuation(sequence1, sequence2, this.indicator);

    for (const ch of changes.iterateUnchanged()) {
      this.builder.markEqualRange(
        start1 + ch.start1,
        start2 + ch.start2,
        start1 + ch.end1,
        start2 + ch.end2
      );
    }
  }

  private matchComplexRange(
    start11: number,
    start12: number,
    end11: number,
    end12: number,
    start21: number,
    start22: number,
    end21: number,
    end22: number
  ): void {
    if (start11 === start21 && end11 === end21) {
      this.matchComplexRangeLeft(start11, end11, start12, end12, start22, end22);
    } else if (start12 === start22 && end12 === end22) {
      this.matchComplexRangeRight(start12, end12, start11, end11, start21, end21);
    } else {
      throw new Error('unexpected complex range shape');
    }
  }

  private matchComplexRangeLeft(
    start1: number,
    end1: number,
    start12: number,
    end12: number,
    start22: number,
    end22: number
  ): void {
    const sequence1 = this.text1.substring(start1, end1);
    const sequence21 = this.text2.substring(start12, end12);
    const sequence22 = this.text2.substring(start22, end22);

    const changes = comparePunctuation2Side(sequence1, sequence21, sequence22, this.indicator);

    for (const ch of changes[0].iterateUnchanged()) {
      this.builder.markEqualRange(
        start1 + ch.start1,
        start12 + ch.start2,
        start1 + ch.end1,
        start12 + ch.end2
      );
    }
    for (const ch of changes[1].iterateUnchanged()) {
      this.builder.markEqualRange(
        start1 + ch.start1,
        start22 + ch.start2,
        start1 + ch.end1,
        start22 + ch.end2
      );
    }
  }

  private matchComplexRangeRight(
    start2: number,
    end2: number,
    start11: number,
    end11: number,
    start21: number,
    end21: number
  ): void {
    const sequence11 = this.text1.substring(start11, end11);
    const sequence12 = this.text1.substring(start21, end21);
    const sequence2 = this.text2.substring(start2, end2);

    const changes = comparePunctuation2Side(sequence2, sequence11, sequence12, this.indicator);

    // Mirrored ch.*1 and ch.*2 as we use "compare2Side" that works with 2 right sides, while we have 2 left here
    for (const ch of changes[0].iterateUnchanged()) {
      this.builder.markEqualRange(
        start11 + ch.start2,
        start2 + ch.start1,
        start11 + ch.end2,
        start2 + ch.end1
      );
    }
    for (const ch of changes[1].iterateUnchanged()) {
      this.builder.markEqualRange(
        start21 + ch.start2,
        start2 + ch.start1,
        start21 + ch.end2,
        start2 + ch.end1
      );
    }
  }

  private getStartOffset1(index: number): number {
    return this.words1[index].offset1 - this.startShift1;
  }

  private getStartOffset2(index: number): number {
    return this.words2[index].offset1 - this.startShift2;
  }

  private getEndOffset1(index: number): number {
    return this.words1[index].offset2 - this.startShift1;
  }

  private getEndOffset2(index: number): number {
    return this.words2[index].offset2 - this.startShift2;
  }
}

// referenced by countNewlines consumers via wordChunks; kept for API parity with ByWordRt
export { getInlineChunks, isWordChunk } from './wordChunks';
export { NewlineChunk };
