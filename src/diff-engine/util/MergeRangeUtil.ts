// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/MergeRangeUtil.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { ComparisonPolicy } from '../comparison/ComparisonPolicy';
import { isEqualTexts } from '../comparison/ComparisonUtil';
import { tryResolveConflict } from '../comparison/MergeResolveUtil';
import { IMergeLineFragment } from '../fragments/MergeLineFragment';
import { IMergeWordFragment } from '../fragments/MergeWordFragment';
import { ILineOffsets } from '../text/LineOffsets';
import { getLinesContent } from './DiffRangeUtil';
import { MergeConflictResolutionStrategy } from './MergeConflictResolutionStrategy';
import { MergeConflictType, MergeConflictTypeKind } from './MergeConflictType';
import { ThreeSide } from './ThreeSide';

export function getMergeType(
  emptiness: (side: ThreeSide) => boolean,
  equality: (side1: ThreeSide, side2: ThreeSide) => boolean,
  trueEquality: ((side1: ThreeSide, side2: ThreeSide) => boolean) | undefined,
  conflictResolver: () => boolean
): MergeConflictType {
  const isLeftEmpty = emptiness(ThreeSide.LEFT);
  const isBaseEmpty = emptiness(ThreeSide.BASE);
  const isRightEmpty = emptiness(ThreeSide.RIGHT);
  if (isLeftEmpty && isBaseEmpty && isRightEmpty) {
    throw new Error('a merge range must be non-empty on at least one side');
  }

  if (isBaseEmpty) {
    if (isLeftEmpty) {
      // --=
      return new MergeConflictType(
        MergeConflictTypeKind.INSERTED,
        false,
        true,
        MergeConflictResolutionStrategy.DEFAULT
      );
    } else if (isRightEmpty) {
      // =--
      return new MergeConflictType(
        MergeConflictTypeKind.INSERTED,
        true,
        false,
        MergeConflictResolutionStrategy.DEFAULT
      );
    } else {
      // =-=
      const equalModifications = equality(ThreeSide.LEFT, ThreeSide.RIGHT);
      if (equalModifications) {
        return new MergeConflictType(
          MergeConflictTypeKind.INSERTED,
          true,
          true,
          MergeConflictResolutionStrategy.DEFAULT
        );
      }
      return new MergeConflictType(MergeConflictTypeKind.CONFLICT, true, true, undefined);
    }
  }

  if (isLeftEmpty && isRightEmpty) {
    // -=-
    return new MergeConflictType(
      MergeConflictTypeKind.DELETED,
      true,
      true,
      MergeConflictResolutionStrategy.DEFAULT
    );
  }

  // -==, ==-, ===
  const unchangedLeft = equality(ThreeSide.BASE, ThreeSide.LEFT);
  const unchangedRight = equality(ThreeSide.BASE, ThreeSide.RIGHT);

  if (unchangedLeft && unchangedRight) {
    if (trueEquality === undefined) {
      throw new Error('a fully-unchanged range needs the strict-equality check');
    }
    const trueUnchangedLeft = trueEquality(ThreeSide.BASE, ThreeSide.LEFT);
    const trueUnchangedRight = trueEquality(ThreeSide.BASE, ThreeSide.RIGHT);
    if (trueUnchangedLeft && trueUnchangedRight) {
      throw new Error('a fully-equal range is not a change');
    }
    return new MergeConflictType(
      MergeConflictTypeKind.MODIFIED,
      !trueUnchangedLeft,
      !trueUnchangedRight,
      MergeConflictResolutionStrategy.DEFAULT
    );
  }

  if (unchangedLeft) {
    return new MergeConflictType(
      isRightEmpty ? MergeConflictTypeKind.DELETED : MergeConflictTypeKind.MODIFIED,
      false,
      true,
      MergeConflictResolutionStrategy.DEFAULT
    );
  }
  if (unchangedRight) {
    return new MergeConflictType(
      isLeftEmpty ? MergeConflictTypeKind.DELETED : MergeConflictTypeKind.MODIFIED,
      true,
      false,
      MergeConflictResolutionStrategy.DEFAULT
    );
  }

  const equalModifications = equality(ThreeSide.LEFT, ThreeSide.RIGHT);
  if (equalModifications) {
    return new MergeConflictType(
      MergeConflictTypeKind.MODIFIED,
      true,
      true,
      MergeConflictResolutionStrategy.DEFAULT
    );
  }

  const canBeResolved = !isLeftEmpty && !isRightEmpty && conflictResolver();
  return new MergeConflictType(
    MergeConflictTypeKind.CONFLICT,
    true,
    true,
    canBeResolved ? MergeConflictResolutionStrategy.TEXT : undefined
  );
}

export function getLineThreeWayDiffType(
  fragment: IMergeLineFragment,
  sequences: readonly string[],
  lineOffsets: readonly ILineOffsets[],
  policy: ComparisonPolicy
): MergeConflictType {
  return getMergeType(
    (side) => isLineMergeIntervalEmpty(fragment, side),
    (side1, side2) =>
      compareLineMergeContents(fragment, sequences, lineOffsets, policy, side1, side2),
    undefined,
    () => canResolveLineConflict(fragment, sequences, lineOffsets)
  );
}

export function getLineMergeType(
  fragment: IMergeLineFragment,
  sequences: readonly string[],
  lineOffsets: readonly ILineOffsets[],
  policy: ComparisonPolicy
): MergeConflictType {
  return getMergeType(
    (side) => isLineMergeIntervalEmpty(fragment, side),
    (side1, side2) =>
      compareLineMergeContents(fragment, sequences, lineOffsets, policy, side1, side2),
    (side1, side2) =>
      compareLineMergeContents(
        fragment,
        sequences,
        lineOffsets,
        ComparisonPolicy.DEFAULT,
        side1,
        side2
      ),
    () => canResolveLineConflict(fragment, sequences, lineOffsets)
  );
}

function canResolveLineConflict(
  fragment: IMergeLineFragment,
  sequences: readonly string[],
  lineOffsets: readonly ILineOffsets[]
): boolean {
  const contents = ThreeSide.map((side) =>
    getLinesContent(
      side.selectFrom(sequences),
      side.selectFrom(lineOffsets),
      fragment.getStartLine(side),
      fragment.getEndLine(side)
    )
  );
  return tryResolveConflict(contents[0], contents[1], contents[2]) !== undefined;
}

function compareLineMergeContents(
  fragment: IMergeLineFragment,
  sequences: readonly string[],
  lineOffsets: readonly ILineOffsets[],
  policy: ComparisonPolicy,
  side1: ThreeSide,
  side2: ThreeSide
): boolean {
  const start1 = fragment.getStartLine(side1);
  const end1 = fragment.getEndLine(side1);
  const start2 = fragment.getStartLine(side2);
  const end2 = fragment.getEndLine(side2);

  if (end2 - start2 !== end1 - start1) {
    return false;
  }

  const sequence1 = side1.selectFrom(sequences);
  const sequence2 = side2.selectFrom(sequences);
  const offsets1 = side1.selectFrom(lineOffsets);
  const offsets2 = side2.selectFrom(lineOffsets);

  for (let i = 0; i < end1 - start1; i++) {
    const line1 = start1 + i;
    const line2 = start2 + i;

    const content1 = getLinesContent(sequence1, offsets1, line1, line1 + 1);
    const content2 = getLinesContent(sequence2, offsets2, line2, line2 + 1);
    if (!isEqualTexts(content1, content2, policy)) {
      return false;
    }
  }

  return true;
}

function isLineMergeIntervalEmpty(fragment: IMergeLineFragment, side: ThreeSide): boolean {
  return fragment.getStartLine(side) === fragment.getEndLine(side);
}

export function getWordMergeType(
  fragment: IMergeWordFragment,
  texts: readonly string[],
  policy: ComparisonPolicy
): MergeConflictType {
  return getMergeType(
    (side) => isWordMergeIntervalEmpty(fragment, side),
    (side1, side2) => compareWordMergeContents(fragment, texts, policy, side1, side2),
    undefined,
    () => false
  );
}

export function compareWordMergeContents(
  fragment: IMergeWordFragment,
  texts: readonly string[],
  policy: ComparisonPolicy,
  side1: ThreeSide,
  side2: ThreeSide
): boolean {
  const start1 = fragment.getStartOffset(side1);
  const end1 = fragment.getEndOffset(side1);
  const start2 = fragment.getStartOffset(side2);
  const end2 = fragment.getEndOffset(side2);

  const document1 = side1.selectFrom(texts);
  const document2 = side2.selectFrom(texts);

  const content1 = document1.substring(start1, end1);
  const content2 = document2.substring(start2, end2);
  return isEqualTexts(content1, content2, policy);
}

function isWordMergeIntervalEmpty(fragment: IMergeWordFragment, side: ThreeSide): boolean {
  return fragment.getStartOffset(side) === fragment.getEndOffset(side);
}

export function getLineLeftToRightThreeSideDiffType(
  fragment: IMergeLineFragment,
  sequences: readonly string[],
  lineOffsets: readonly ILineOffsets[],
  policy: ComparisonPolicy
): MergeConflictType {
  return getLeftToRightDiffType(
    (side) => isLineMergeIntervalEmpty(fragment, side),
    (side1, side2) =>
      compareLineMergeContents(fragment, sequences, lineOffsets, policy, side1, side2)
  );
}

function getLeftToRightDiffType(
  emptiness: (side: ThreeSide) => boolean,
  equality: (side1: ThreeSide, side2: ThreeSide) => boolean
): MergeConflictType {
  const isLeftEmpty = emptiness(ThreeSide.LEFT);
  const isBaseEmpty = emptiness(ThreeSide.BASE);
  const isRightEmpty = emptiness(ThreeSide.RIGHT);
  if (isLeftEmpty && isBaseEmpty && isRightEmpty) {
    throw new Error('a merge range must be non-empty on at least one side');
  }

  if (isBaseEmpty) {
    if (isLeftEmpty) {
      // --=
      return new MergeConflictType(
        MergeConflictTypeKind.INSERTED,
        false,
        true,
        MergeConflictResolutionStrategy.DEFAULT
      );
    } else if (isRightEmpty) {
      // =--
      return new MergeConflictType(
        MergeConflictTypeKind.DELETED,
        true,
        false,
        MergeConflictResolutionStrategy.DEFAULT
      );
    } else {
      // =-=
      return new MergeConflictType(
        MergeConflictTypeKind.MODIFIED,
        true,
        true,
        MergeConflictResolutionStrategy.DEFAULT
      );
    }
  }

  if (isLeftEmpty && isRightEmpty) {
    // -=-
    return new MergeConflictType(
      MergeConflictTypeKind.MODIFIED,
      true,
      true,
      MergeConflictResolutionStrategy.DEFAULT
    );
  }

  // -==, ==-, ===
  const unchangedLeft = equality(ThreeSide.BASE, ThreeSide.LEFT);
  const unchangedRight = equality(ThreeSide.BASE, ThreeSide.RIGHT);
  if (unchangedLeft && unchangedRight) {
    throw new Error('a fully-equal range is not a change');
  }

  if (unchangedLeft) {
    return new MergeConflictType(
      isRightEmpty ? MergeConflictTypeKind.DELETED : MergeConflictTypeKind.MODIFIED,
      false,
      true,
      MergeConflictResolutionStrategy.DEFAULT
    );
  }
  if (unchangedRight) {
    return new MergeConflictType(
      isLeftEmpty ? MergeConflictTypeKind.INSERTED : MergeConflictTypeKind.MODIFIED,
      true,
      false,
      MergeConflictResolutionStrategy.DEFAULT
    );
  }

  return new MergeConflictType(
    MergeConflictTypeKind.MODIFIED,
    true,
    true,
    MergeConflictResolutionStrategy.DEFAULT
  );
}
