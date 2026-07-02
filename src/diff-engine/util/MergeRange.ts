// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/MergeRange.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

/** Three half-open intervals — left [start1, end1), base [start2, end2), right [start3, end3). */
export class MergeRange {
  constructor(
    readonly start1: number,
    readonly end1: number,
    readonly start2: number,
    readonly end2: number,
    readonly start3: number,
    readonly end3: number
  ) {}

  equals(o: MergeRange): boolean {
    return (
      this.start1 === o.start1 &&
      this.end1 === o.end1 &&
      this.start2 === o.start2 &&
      this.end2 === o.end2 &&
      this.start3 === o.start3 &&
      this.end3 === o.end3
    );
  }

  toString(): string {
    return `[${this.start1}, ${this.end1}) - [${this.start2}, ${this.end2}) - [${this.start3}, ${this.end3})`;
  }

  get isEmpty(): boolean {
    return this.start1 === this.end1 && this.start2 === this.end2 && this.start3 === this.end3;
  }
}
