// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/Range.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

/** Stores a pair of half-open intervals [start1, end1) / [start2, end2). */
export class Range {
  constructor(
    readonly start1: number,
    readonly end1: number,
    readonly start2: number,
    readonly end2: number
  ) {
    if (start1 > end1 || start2 > end2) {
      throw new Error(`[${start1}, ${end1}, ${start2}, ${end2}]`);
    }
  }

  equals(o: Range): boolean {
    return (
      this.start1 === o.start1 &&
      this.end1 === o.end1 &&
      this.start2 === o.start2 &&
      this.end2 === o.end2
    );
  }

  toString(): string {
    return `[${this.start1}, ${this.end1}) - [${this.start2}, ${this.end2})`;
  }

  get isEmpty(): boolean {
    return this.start1 === this.end1 && this.start2 === this.end2;
  }
}
