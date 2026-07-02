// Ported from intellij-community platform/util/diff/src/com/intellij/diff/fragments/LineFragment.kt
// and LineFragmentImpl.kt. Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { IDiffFragment } from './DiffFragment';

/**
 * Modified part of the text.
 *
 * Offset ranges cover whole lines, including the '\n' at the end (which can be absent
 * for the last line).
 */
export interface ILineFragment extends IDiffFragment {
  readonly startLine1: number;
  readonly endLine1: number;
  readonly startLine2: number;
  readonly endLine2: number;

  /**
   * High-granularity changes inside the line fragment (e.g. detected by ByWord),
   * with offsets relative to the start of the fragment.
   *
   * undefined - no inner similarities were found
   */
  readonly innerFragments: readonly IDiffFragment[] | undefined;
}

export class LineFragmentImpl implements ILineFragment {
  readonly innerFragments: readonly IDiffFragment[] | undefined;

  constructor(
    readonly startLine1: number,
    readonly endLine1: number,
    readonly startLine2: number,
    readonly endLine2: number,
    readonly startOffset1: number,
    readonly endOffset1: number,
    readonly startOffset2: number,
    readonly endOffset2: number,
    innerFragments: readonly IDiffFragment[] | undefined = undefined
  ) {
    this.innerFragments = dropWholeChangedFragments(
      innerFragments,
      endOffset1 - startOffset1,
      endOffset2 - startOffset2
    );
    if (startLine1 === endLine1 && startLine2 === endLine2) {
      throw new Error(`LineFragmentImpl should not be empty: ${this.toString()}`);
    }
    if (
      startLine1 > endLine1 ||
      startLine2 > endLine2 ||
      startOffset1 > endOffset1 ||
      startOffset2 > endOffset2
    ) {
      throw new Error(`LineFragmentImpl is invalid: ${this.toString()}`);
    }
  }

  static withInnerFragments(
    fragment: ILineFragment,
    fragments: readonly IDiffFragment[] | undefined
  ): LineFragmentImpl {
    return new LineFragmentImpl(
      fragment.startLine1,
      fragment.endLine1,
      fragment.startLine2,
      fragment.endLine2,
      fragment.startOffset1,
      fragment.endOffset1,
      fragment.startOffset2,
      fragment.endOffset2,
      fragments
    );
  }

  toString(): string {
    return (
      `LineFragmentImpl: Lines [${this.startLine1}, ${this.endLine1}) - [${this.startLine2}, ${this.endLine2}); ` +
      `Offsets [${this.startOffset1}, ${this.endOffset1}) - [${this.startOffset2}, ${this.endOffset2}); ` +
      `Inner ${this.innerFragments?.length}`
    );
  }
}

function dropWholeChangedFragments(
  fragments: readonly IDiffFragment[] | undefined,
  length1: number,
  length2: number
): readonly IDiffFragment[] | undefined {
  if (fragments !== undefined && fragments.length === 1) {
    const diffFragment = fragments[0];
    if (
      diffFragment.startOffset1 === 0 &&
      diffFragment.startOffset2 === 0 &&
      diffFragment.endOffset1 === length1 &&
      diffFragment.endOffset2 === length2
    ) {
      return undefined;
    }
  }
  return fragments;
}
