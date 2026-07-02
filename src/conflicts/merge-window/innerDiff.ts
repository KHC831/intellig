// Ported from intellij-community platform/diff-impl/src/com/intellij/diff/util/DiffUtil.java
// (compareThreesideInner + MergeInnerDifferences). Copyright 2000-2025
// JetBrains s.r.o. and contributors. Apache 2.0 license.
//
// Word-level differences inside one merge change: each side's ranges are
// offsets within that side's chunk text. A null chunk means the side has no
// lines in the change; a null range list means that side gets no inner
// highlights.

import * as ByWordRt from '../../diff-engine/comparison/ByWordRt';
import { EMPTY_CANCELLATION_CHECKER } from '../../diff-engine/comparison/CancellationChecker';
import { ComparisonPolicy } from '../../diff-engine/comparison/ComparisonPolicy';
import { isEqualTexts } from '../../diff-engine/comparison/ComparisonUtil';
import { ThreeSide } from '../../diff-engine/util/ThreeSide';

export interface ITextSpan {
  readonly start: number;
  readonly end: number;
}

export interface IMergeInnerDifferences {
  readonly left: readonly ITextSpan[] | null;
  readonly base: readonly ITextSpan[] | null;
  readonly right: readonly ITextSpan[] | null;
}

function chunksEqual(
  chunk1: string | null,
  chunk2: string | null,
  policy: ComparisonPolicy
): boolean {
  return isEqualTexts(chunk1 ?? '', chunk2 ?? '', policy);
}

export function compareThreesideInner(
  chunks: readonly [string | null, string | null, string | null],
  policy: ComparisonPolicy
): IMergeInnerDifferences | null {
  const [left, base, right] = chunks;
  if (left === null && base === null && right === null) {
    return null; // ---
  }

  if (policy === ComparisonPolicy.IGNORE_WHITESPACES) {
    if (chunksEqual(left, base, policy) && chunksEqual(left, right, policy)) {
      // whitespace-only changes, ex: empty lines added/removed
      return { left: [], base: [], right: [] };
    }
  }

  if (
    (left === null && base === null) ||
    (left === null && right === null) ||
    (base === null && right === null)
  ) {
    return null; // =--, -=-, --=
  }

  if (left !== null && base !== null && right !== null) {
    // ===
    const fragments1 = ByWordRt.compare(base, left, policy, EMPTY_CANCELLATION_CHECKER);
    const fragments2 = ByWordRt.compare(base, right, policy, EMPTY_CANCELLATION_CHECKER);

    const leftSpans: ITextSpan[] = [];
    const baseSpans: ITextSpan[] = [];
    const rightSpans: ITextSpan[] = [];

    for (const fragment of fragments1) {
      baseSpans.push({ start: fragment.startOffset1, end: fragment.endOffset1 });
      leftSpans.push({ start: fragment.startOffset2, end: fragment.endOffset2 });
    }
    for (const fragment of fragments2) {
      baseSpans.push({ start: fragment.startOffset1, end: fragment.endOffset1 });
      rightSpans.push({ start: fragment.startOffset2, end: fragment.endOffset2 });
    }

    return { left: leftSpans, base: baseSpans, right: rightSpans };
  }

  // ==-, =-=, -==
  const side1 = left !== null ? ThreeSide.LEFT : ThreeSide.BASE;
  const side2 = right !== null ? ThreeSide.RIGHT : ThreeSide.BASE;
  const chunk1 = side1.selectFrom(chunks) as string;
  const chunk2 = side2.selectFrom(chunks) as string;

  const wordConflicts = ByWordRt.compare(chunk1, chunk2, policy, EMPTY_CANCELLATION_CHECKER);

  const spans = ThreeSide.map((side): ITextSpan[] | null => {
    if (side === side1) {
      return wordConflicts.map((f) => ({ start: f.startOffset1, end: f.endOffset1 }));
    }
    if (side === side2) {
      return wordConflicts.map((f) => ({ start: f.startOffset2, end: f.endOffset2 }));
    }
    return null;
  });

  return { left: spans[0], base: spans[1], right: spans[2] };
}
