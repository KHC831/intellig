// Ported from intellij-community platform/util/diff/src/com/intellij/diff/fragments/MergeLineFragment.kt
// and MergeLineFragmentImpl.kt. Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { MergeRange } from '../util/MergeRange';
import { ThreeSide } from '../util/ThreeSide';

export interface IMergeLineFragment {
  getStartLine(side: ThreeSide): number;
  getEndLine(side: ThreeSide): number;
}

export class MergeLineFragmentImpl implements IMergeLineFragment {
  constructor(
    private readonly startLine1: number,
    private readonly endLine1: number,
    private readonly startLine2: number,
    private readonly endLine2: number,
    private readonly startLine3: number,
    private readonly endLine3: number
  ) {}

  static fromFragment(fragment: IMergeLineFragment): MergeLineFragmentImpl {
    return new MergeLineFragmentImpl(
      fragment.getStartLine(ThreeSide.LEFT),
      fragment.getEndLine(ThreeSide.LEFT),
      fragment.getStartLine(ThreeSide.BASE),
      fragment.getEndLine(ThreeSide.BASE),
      fragment.getStartLine(ThreeSide.RIGHT),
      fragment.getEndLine(ThreeSide.RIGHT)
    );
  }

  static fromRange(range: MergeRange): MergeLineFragmentImpl {
    return new MergeLineFragmentImpl(
      range.start1,
      range.end1,
      range.start2,
      range.end2,
      range.start3,
      range.end3
    );
  }

  getStartLine(side: ThreeSide): number {
    return side.select(this.startLine1, this.startLine2, this.startLine3);
  }

  getEndLine(side: ThreeSide): number {
    return side.select(this.endLine1, this.endLine2, this.endLine3);
  }
}
