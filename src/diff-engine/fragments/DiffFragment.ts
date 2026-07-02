// Ported from intellij-community platform/util/diff/src/com/intellij/diff/fragments/DiffFragment.kt
// and DiffFragmentImpl.kt. Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

/** Modified part of the text, as half-open char-offset ranges into both sides. */
export interface IDiffFragment {
  readonly startOffset1: number;
  readonly endOffset1: number;
  readonly startOffset2: number;
  readonly endOffset2: number;
}

export class DiffFragmentImpl implements IDiffFragment {
  constructor(
    readonly startOffset1: number,
    readonly endOffset1: number,
    readonly startOffset2: number,
    readonly endOffset2: number
  ) {
    if (startOffset1 === endOffset1 && startOffset2 === endOffset2) {
      throw new Error(`DiffFragmentImpl should not be empty: ${this.toString()}`);
    }
    if (startOffset1 > endOffset1 || startOffset2 > endOffset2) {
      throw new Error(`DiffFragmentImpl is invalid: ${this.toString()}`);
    }
  }

  equals(o: IDiffFragment): boolean {
    return (
      this.startOffset1 === o.startOffset1 &&
      this.endOffset1 === o.endOffset1 &&
      this.startOffset2 === o.startOffset2 &&
      this.endOffset2 === o.endOffset2
    );
  }

  toString(): string {
    return `DiffFragmentImpl [${this.startOffset1}, ${this.endOffset1}) - [${this.startOffset2}, ${this.endOffset2})`;
  }
}
