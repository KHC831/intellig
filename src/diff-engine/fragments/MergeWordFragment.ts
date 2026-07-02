// Ported from intellij-community platform/util/diff/src/com/intellij/diff/fragments/MergeWordFragment.kt
// and MergeWordFragmentImpl.kt. Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { MergeRange } from '../util/MergeRange';
import { ThreeSide } from '../util/ThreeSide';

export interface IMergeWordFragment {
  getStartOffset(side: ThreeSide): number;
  getEndOffset(side: ThreeSide): number;
}

export class MergeWordFragmentImpl implements IMergeWordFragment {
  constructor(
    private readonly startOffset1: number,
    private readonly endOffset1: number,
    private readonly startOffset2: number,
    private readonly endOffset2: number,
    private readonly startOffset3: number,
    private readonly endOffset3: number
  ) {}

  static fromRange(range: MergeRange): MergeWordFragmentImpl {
    return new MergeWordFragmentImpl(
      range.start1,
      range.end1,
      range.start2,
      range.end2,
      range.start3,
      range.end3
    );
  }

  getStartOffset(side: ThreeSide): number {
    return side.select(this.startOffset1, this.startOffset2, this.startOffset3);
  }

  getEndOffset(side: ThreeSide): number {
    return side.select(this.endOffset1, this.endOffset2, this.endOffset3);
  }
}
