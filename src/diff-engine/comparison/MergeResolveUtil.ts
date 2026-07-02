// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/MergeResolveUtil.kt
// (plus tryResolveConflict from ComparisonMergeUtil.kt). This module and MergeRangeUtil
// reference each other only inside function bodies, mirroring the Kotlin originals.
// Copyright 2000-2023 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { DiffConfig } from '../diff/DiffConfig';
import { IDiffFragment } from '../fragments/DiffFragment';
import { MergeWordFragmentImpl } from '../fragments/MergeWordFragment';
import { MergeConflictTypeKind } from '../util/MergeConflictType';
import { MergeRange } from '../util/MergeRange';
import { compareWordMergeContents, getWordMergeType } from '../util/MergeRangeUtil';
import { Side } from '../util/Side';
import { ThreeSide } from '../util/ThreeSide';
import * as ByWordRt from './ByWordRt';
import { EMPTY_CANCELLATION_CHECKER } from './CancellationChecker';
import { ComparisonPolicy } from './ComparisonPolicy';
import { isEqualTexts } from './ComparisonUtil';
import { DiffTooBigException } from './DiffTooBigException';

/** ComparisonMergeUtil.tryResolveConflict */
export function tryResolveConflict(
  leftText: string,
  baseText: string,
  rightText: string
): string | undefined {
  if (DiffConfig.USE_GREEDY_MERGE_MAGIC_RESOLVE) {
    return tryGreedyResolve(leftText, baseText, rightText);
  }
  return tryResolve(leftText, baseText, rightText);
}

export function tryResolve(
  leftText: string,
  baseText: string,
  rightText: string
): string | undefined {
  try {
    const resolved = trySimpleResolve(leftText, baseText, rightText, ComparisonPolicy.DEFAULT);
    if (resolved !== undefined) {
      return resolved;
    }

    return trySimpleResolve(leftText, baseText, rightText, ComparisonPolicy.IGNORE_WHITESPACES);
  } catch (e) {
    if (e instanceof DiffTooBigException) {
      return undefined;
    }
    throw e;
  }
}

/*
 * Here we assume that resolve results are explicitly verified by the user and can be
 * safely undone. Thus we trade higher chances of an incorrect resolve for higher chances
 * of a correct resolve.
 *
 * We're making an assertion that "A-X-B" and "B-X-A" conflicts should produce equal
 * results. This leads to the conclusion that insertion-insertion conflicts can't
 * possibly be resolved (if the inserted fragments are different), because we don't know
 * the right order of the inserted chunks (and sorting them alphabetically or by length
 * makes no sense).
 *
 * deleted-inserted conflicts can be resolved by applying both of them.
 * deleted-deleted conflicts can be resolved by merging the deleted intervals.
 * modifications can be considered as "insertion + deletion" and resolved accordingly.
 */
export function tryGreedyResolve(
  leftText: string,
  baseText: string,
  rightText: string
): string | undefined {
  try {
    const resolved = tryGreedyResolveWithPolicy(
      leftText,
      baseText,
      rightText,
      ComparisonPolicy.DEFAULT
    );
    if (resolved !== undefined) {
      return resolved;
    }

    return tryGreedyResolveWithPolicy(
      leftText,
      baseText,
      rightText,
      ComparisonPolicy.IGNORE_WHITESPACES
    );
  } catch (e) {
    if (e instanceof DiffTooBigException) {
      return undefined;
    }
    throw e;
  }
}

function trySimpleResolve(
  leftText: string,
  baseText: string,
  rightText: string,
  policy: ComparisonPolicy
): string | undefined {
  return new SimpleHelper(leftText, baseText, rightText).execute(policy);
}

function tryGreedyResolveWithPolicy(
  leftText: string,
  baseText: string,
  rightText: string,
  policy: ComparisonPolicy
): string | undefined {
  return new GreedyHelper(leftText, baseText, rightText).execute(policy);
}

class SimpleHelper {
  private newContent = '';

  private last1 = 0;
  private last2 = 0;
  private last3 = 0;

  private readonly texts: readonly string[];

  constructor(
    private readonly leftText: string,
    private readonly baseText: string,
    private readonly rightText: string
  ) {
    this.texts = [leftText, baseText, rightText];
  }

  execute(policy: ComparisonPolicy): string | undefined {
    const changes = ByWordRt.compareThreeside(
      this.leftText,
      this.baseText,
      this.rightText,
      policy,
      EMPTY_CANCELLATION_CHECKER
    );

    for (const fragment of changes) {
      const baseRange = this.nextMergeRange(
        fragment.getStartOffset(ThreeSide.LEFT),
        fragment.getStartOffset(ThreeSide.BASE),
        fragment.getStartOffset(ThreeSide.RIGHT)
      );
      this.appendBase(baseRange);

      const conflictRange = this.nextMergeRange(
        fragment.getEndOffset(ThreeSide.LEFT),
        fragment.getEndOffset(ThreeSide.BASE),
        fragment.getEndOffset(ThreeSide.RIGHT)
      );
      if (!this.appendConflict(conflictRange, policy)) {
        return undefined;
      }
    }

    const trailingRange = this.nextMergeRange(
      this.leftText.length,
      this.baseText.length,
      this.rightText.length
    );
    this.appendBase(trailingRange);

    return this.newContent;
  }

  private nextMergeRange(end1: number, end2: number, end3: number): MergeRange {
    const range = new MergeRange(this.last1, end1, this.last2, end2, this.last3, end3);
    this.last1 = end1;
    this.last2 = end2;
    this.last3 = end3;
    return range;
  }

  private appendBase(range: MergeRange): void {
    if (range.isEmpty) {
      return;
    }

    const policy = ComparisonPolicy.DEFAULT;

    if (this.isUnchangedRange(range, policy)) {
      this.append(range, ThreeSide.BASE);
    } else {
      const type = this.getConflictType(range, policy);
      if (type.isChange(Side.LEFT)) {
        this.append(range, ThreeSide.LEFT);
      } else if (type.isChange(Side.RIGHT)) {
        this.append(range, ThreeSide.RIGHT);
      } else {
        this.append(range, ThreeSide.BASE);
      }
    }
  }

  private appendConflict(range: MergeRange, policy: ComparisonPolicy): boolean {
    const type = this.getConflictType(range, policy);
    if (type.type === MergeConflictTypeKind.CONFLICT) {
      return false;
    }

    if (type.isChange(Side.LEFT)) {
      this.append(range, ThreeSide.LEFT);
    } else {
      this.append(range, ThreeSide.RIGHT);
    }

    return true;
  }

  private append(range: MergeRange, side: ThreeSide): void {
    if (side === ThreeSide.LEFT) {
      this.newContent += this.leftText.substring(range.start1, range.end1);
    } else if (side === ThreeSide.BASE) {
      this.newContent += this.baseText.substring(range.start2, range.end2);
    } else {
      this.newContent += this.rightText.substring(range.start3, range.end3);
    }
  }

  private getConflictType(
    range: MergeRange,
    policy: ComparisonPolicy
  ): ReturnType<typeof getWordMergeType> {
    return getWordMergeType(MergeWordFragmentImpl.fromRange(range), this.texts, policy);
  }

  private isUnchangedRange(range: MergeRange, policy: ComparisonPolicy): boolean {
    const fragment = MergeWordFragmentImpl.fromRange(range);
    return (
      compareWordMergeContents(fragment, this.texts, policy, ThreeSide.BASE, ThreeSide.LEFT) &&
      compareWordMergeContents(fragment, this.texts, policy, ThreeSide.BASE, ThreeSide.RIGHT)
    );
  }
}

class GreedyHelper {
  private newContent = '';

  private lastBaseOffset = 0;
  private index1 = 0;
  private index2 = 0;

  constructor(
    private readonly leftText: string,
    private readonly baseText: string,
    private readonly rightText: string
  ) {}

  execute(policy: ComparisonPolicy): string | undefined {
    const fragments1 = ByWordRt.compare(
      this.baseText,
      this.leftText,
      policy,
      EMPTY_CANCELLATION_CHECKER
    );
    const fragments2 = ByWordRt.compare(
      this.baseText,
      this.rightText,
      policy,
      EMPTY_CANCELLATION_CHECKER
    );

    for (;;) {
      const changeStart1 = fragments1[this.index1]?.startOffset1 ?? -1;
      const changeStart2 = fragments2[this.index2]?.startOffset1 ?? -1;

      if (changeStart1 === -1 && changeStart2 === -1) {
        // no more changes left
        this.appendBase(this.baseText.length);
        break;
      }

      // skip till the next block of changes
      if (changeStart1 !== -1 && changeStart2 !== -1) {
        this.appendBase(Math.min(changeStart1, changeStart2));
      } else if (changeStart1 !== -1) {
        this.appendBase(changeStart1);
      } else {
        this.appendBase(changeStart2);
      }

      // collect the next block of changes that intersect one another
      let baseOffsetEnd = this.lastBaseOffset;
      let end1 = this.index1;
      let end2 = this.index2;

      for (;;) {
        const next1 = fragments1[end1];
        const next2 = fragments2[end2];

        if (next1 !== undefined && next1.startOffset1 <= baseOffsetEnd) {
          baseOffsetEnd = Math.max(baseOffsetEnd, next1.endOffset1);
          end1++;
          continue;
        }
        if (next2 !== undefined && next2.startOffset1 <= baseOffsetEnd) {
          baseOffsetEnd = Math.max(baseOffsetEnd, next2.endOffset1);
          end2++;
          continue;
        }

        break;
      }
      if (this.index1 === end1 && this.index2 === end2) {
        throw new Error('the change block must consume at least one change');
      }

      const inserted1 = this.getInsertedContent(fragments1, this.index1, end1, Side.LEFT);
      const inserted2 = this.getInsertedContent(fragments2, this.index2, end2, Side.RIGHT);
      this.index1 = end1;
      this.index2 = end2;

      // merge and apply deletions
      this.lastBaseOffset = baseOffsetEnd;

      // merge and apply non-conflicting insertions
      if (inserted1.length === 0 && inserted2.length === 0) {
        continue;
      }
      if (inserted2.length === 0) {
        this.newContent += inserted1;
        continue;
      }
      if (inserted1.length === 0) {
        this.newContent += inserted2;
        continue;
      }

      if (isEqualTexts(inserted1, inserted2, policy)) {
        this.newContent += inserted1.length <= inserted2.length ? inserted1 : inserted2;
        continue;
      }

      // we've hit conflicting insertions - resolve failed
      return undefined;
    }

    return this.newContent;
  }

  private appendBase(endOffset: number): void {
    if (this.lastBaseOffset === endOffset) {
      return;
    }
    this.newContent += this.baseText.substring(this.lastBaseOffset, endOffset);
    this.lastBaseOffset = endOffset;
  }

  private getInsertedContent(
    fragments: readonly IDiffFragment[],
    start: number,
    end: number,
    side: Side
  ): string {
    const text = side.select(this.leftText, this.rightText);

    let inserted = '';
    for (const fragment of fragments.slice(start, end)) {
      inserted += text.substring(fragment.startOffset2, fragment.endOffset2);
    }
    return inserted;
  }
}
