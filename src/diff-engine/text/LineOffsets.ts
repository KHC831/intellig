// Ported from intellij-community platform/util/diff/src/com/intellij/diff/tools/util/text/LineOffsets.kt
// and LineOffsetsImpl.kt. Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

export interface ILineOffsets {
  getLineStart(line: number): number;
  /** End offset of the line, excluding the newline unless includeNewline is true. */
  getLineEnd(line: number, includeNewline?: boolean): number;
  getLineNumber(offset: number): number;
  readonly lineCount: number;
  readonly textLength: number;
}

export class LineOffsetsImpl implements ILineOffsets {
  private constructor(
    private readonly lineEnds: readonly number[],
    readonly textLength: number
  ) {}

  static create(text: string): ILineOffsets {
    const ends: number[] = [];
    let index = 0;
    for (;;) {
      const lineEnd = text.indexOf('\n', index);
      if (lineEnd !== -1) {
        ends.push(lineEnd);
        index = lineEnd + 1;
      } else {
        ends.push(text.length);
        break;
      }
    }
    return new LineOffsetsImpl(ends, text.length);
  }

  getLineStart(line: number): number {
    this.checkLineIndex(line);
    if (line === 0) {
      return 0;
    }
    return this.lineEnds[line - 1] + 1;
  }

  getLineEnd(line: number, includeNewline: boolean = false): number {
    this.checkLineIndex(line);
    return this.lineEnds[line] + (includeNewline && line !== this.lineEnds.length - 1 ? 1 : 0);
  }

  getLineNumber(offset: number): number {
    if (offset < 0 || offset > this.textLength) {
      throw new RangeError(`Wrong offset: ${offset}. Available text length: ${this.textLength}`);
    }
    if (offset === 0) {
      return 0;
    }
    if (offset === this.textLength) {
      return this.lineCount - 1;
    }

    // Find the first line whose end offset is >= the queried offset.
    let low = 0;
    let high = this.lineEnds.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.lineEnds[mid] < offset) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  get lineCount(): number {
    return this.lineEnds.length;
  }

  private checkLineIndex(index: number): void {
    if (index < 0 || index >= this.lineCount) {
      throw new RangeError(`Wrong line: ${index}. Available lines count: ${this.lineCount}`);
    }
  }
}
