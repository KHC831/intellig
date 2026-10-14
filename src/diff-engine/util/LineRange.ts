// Ported from intellij-community platform/diff-api/src/com/intellij/diff/util/LineRange.java
// Copyright 2000-2020 JetBrains s.r.o. and contributors. Apache 2.0 license.

/** A half-open interval of lines [start, end). */
export class LineRange {
  constructor(
    readonly start: number,
    readonly end: number
  ) {}

  get isEmpty(): boolean {
    return this.start === this.end;
  }

  equals(other: LineRange): boolean {
    return this.start === other.start && this.end === other.end;
  }

  toString(): string {
    return `[${this.start}, ${this.end})`;
  }
}
