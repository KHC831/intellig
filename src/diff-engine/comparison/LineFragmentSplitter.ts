// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/LineFragmentSplitter.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Range } from '../util/Range';
import { ICancellationChecker } from './CancellationChecker';
import { ComparisonPolicy } from './ComparisonPolicy';
import { isEqualTexts } from './ComparisonUtil';
import { IFairDiffIterable } from './iterables/DiffIterable';
import { IInlineChunk, NewlineChunk } from './wordChunks';

export class WordBlock {
  constructor(
    readonly words: Range,
    readonly offsets: Range
  ) {}
}

class PendingChunk {
  constructor(
    readonly block: WordBlock,
    readonly hasEqualWords: boolean,
    readonly hasWordsInside: boolean,
    readonly isEqualIgnoreWhitespaces: boolean
  ) {}
}

/*
 * Given matchings on words, split the initial line block into 'logically different' line
 * blocks.
 */
export class LineFragmentSplitter {
  private readonly result: WordBlock[] = [];

  private last1 = -1;
  private last2 = -1;
  private pendingChunk: PendingChunk | undefined;

  constructor(
    private readonly text1: string,
    private readonly text2: string,
    private readonly words1: readonly IInlineChunk[],
    private readonly words2: readonly IInlineChunk[],
    private readonly iterable: IFairDiffIterable,
    _indicator: ICancellationChecker
  ) {}

  // indexes here are a bit tricky
  // -1 - the beginning of file, words.length - end of file, everything in between - InlineChunks (words or newlines)
  run(): WordBlock[] {
    let hasEqualWords = false;
    for (const range of this.iterable.iterateUnchanged()) {
      const count = range.end1 - range.start1;
      for (let i = 0; i < count; i++) {
        const index1 = range.start1 + i;
        const index2 = range.start2 + i;

        if (isNewline(this.words1, index1) && isNewline(this.words2, index2)) {
          // split by matched newlines
          this.addLineChunk(index1, index2, hasEqualWords);
          hasEqualWords = false;
        } else {
          if (isFirstInLine(this.words1, index1) && isFirstInLine(this.words2, index2)) {
            // split by matched first word in line
            this.addLineChunk(index1 - 1, index2 - 1, hasEqualWords);
            hasEqualWords = false;
          }
          hasEqualWords = true;
        }
      }
    }
    this.addLineChunk(this.words1.length, this.words2.length, hasEqualWords);

    if (this.pendingChunk !== undefined) {
      this.result.push(this.pendingChunk.block);
    }

    return this.result;
  }

  private addLineChunk(end1: number, end2: number, hasEqualWords: boolean): void {
    if (this.last1 > end1 || this.last2 > end2) {
      return;
    }

    const chunk = this.createChunk(this.last1, this.last2, end1, end2, hasEqualWords);
    if (chunk.block.offsets.isEmpty) {
      return;
    }

    const pending = this.pendingChunk;
    if (pending !== undefined) {
      if (shouldMergeChunks(pending, chunk)) {
        this.pendingChunk = mergeChunks(pending, chunk);
      } else {
        this.result.push(pending.block);
        this.pendingChunk = chunk;
      }
    } else {
      this.pendingChunk = chunk;
    }

    this.last1 = end1;
    this.last2 = end2;
  }

  private createChunk(
    start1: number,
    start2: number,
    end1: number,
    end2: number,
    hasEqualWords: boolean
  ): PendingChunk {
    const startOffset1 = getOffset(this.words1, this.text1, start1);
    const startOffset2 = getOffset(this.words2, this.text2, start2);
    const endOffset1 = getOffset(this.words1, this.text1, end1);
    const endOffset2 = getOffset(this.words2, this.text2, end2);

    const wordStart1 = Math.max(0, start1 + 1);
    const wordStart2 = Math.max(0, start2 + 1);
    const wordEnd1 = Math.min(end1 + 1, this.words1.length);
    const wordEnd2 = Math.min(end2 + 1, this.words2.length);

    const block = new WordBlock(
      new Range(wordStart1, wordEnd1, wordStart2, wordEnd2),
      new Range(startOffset1, endOffset1, startOffset2, endOffset2)
    );

    return new PendingChunk(
      block,
      hasEqualWords,
      this.hasWordsInside(block),
      this.isEqualsIgnoreWhitespace(block)
    );
  }

  private isEqualsIgnoreWhitespace(block: WordBlock): boolean {
    const sequence1 = this.text1.substring(block.offsets.start1, block.offsets.end1);
    const sequence2 = this.text2.substring(block.offsets.start2, block.offsets.end2);
    return isEqualTexts(sequence1, sequence2, ComparisonPolicy.IGNORE_WHITESPACES);
  }

  private hasWordsInside(block: WordBlock): boolean {
    for (let i = block.words.start1; i < block.words.end1; i++) {
      if (!(this.words1[i] instanceof NewlineChunk)) {
        return true;
      }
    }
    for (let i = block.words.start2; i < block.words.end2; i++) {
      if (!(this.words2[i] instanceof NewlineChunk)) {
        return true;
      }
    }
    return false;
  }
}

function shouldMergeChunks(chunk1: PendingChunk, chunk2: PendingChunk): boolean {
  if (!chunk1.hasEqualWords && !chunk2.hasEqualWords) {
    return true; // combine lines, that matched only by '\n'
  }

  if (chunk1.isEqualIgnoreWhitespaces && chunk2.isEqualIgnoreWhitespaces) {
    return true; // combine whitespace-only changed lines
  }

  if (!chunk1.hasWordsInside || !chunk2.hasWordsInside) {
    return true; // squash block without words in it
  }

  return false;
}

function mergeChunks(chunk1: PendingChunk, chunk2: PendingChunk): PendingChunk {
  const block1 = chunk1.block;
  const block2 = chunk2.block;
  const newBlock = new WordBlock(
    new Range(block1.words.start1, block2.words.end1, block1.words.start2, block2.words.end2),
    new Range(
      block1.offsets.start1,
      block2.offsets.end1,
      block1.offsets.start2,
      block2.offsets.end2
    )
  );
  return new PendingChunk(
    newBlock,
    chunk1.hasEqualWords || chunk2.hasEqualWords,
    chunk1.hasWordsInside || chunk2.hasWordsInside,
    chunk1.isEqualIgnoreWhitespaces && chunk2.isEqualIgnoreWhitespaces
  );
}

function getOffset(words: readonly IInlineChunk[], text: string, index: number): number {
  if (index === -1) {
    return 0;
  }
  if (index === words.length) {
    return text.length;
  }
  const chunk = words[index];
  if (!(chunk instanceof NewlineChunk)) {
    throw new Error('line blocks must be bounded by newline chunks');
  }
  return chunk.offset2;
}

function isNewline(words: readonly IInlineChunk[], index: number): boolean {
  return words[index] instanceof NewlineChunk;
}

function isFirstInLine(words: readonly IInlineChunk[], index: number): boolean {
  if (index === 0) {
    return true;
  }
  return words[index - 1] instanceof NewlineChunk;
}
