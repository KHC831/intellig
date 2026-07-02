// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/ThreeSide.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

/** One of the three sides of a merge: left (yours), base, right (theirs). */
export class ThreeSide {
  static readonly LEFT = new ThreeSide(0);
  static readonly BASE = new ThreeSide(1);
  static readonly RIGHT = new ThreeSide(2);

  private constructor(readonly index: number) {}

  select<T>(left: T, base: T, right: T): T {
    if (this.index === 0) {
      return left;
    }
    if (this.index === 1) {
      return base;
    }
    return right;
  }

  selectFrom<T>(triple: readonly T[]): T {
    if (triple.length !== 3) {
      throw new Error(`expected a triple, got ${triple.length} items`);
    }
    return triple[this.index];
  }

  static fromIndex(index: number): ThreeSide {
    if (index === 0) {
      return ThreeSide.LEFT;
    }
    if (index === 1) {
      return ThreeSide.BASE;
    }
    if (index === 2) {
      return ThreeSide.RIGHT;
    }
    throw new RangeError(`index: ${index}`);
  }

  static fromValue<T>(triple: readonly T[], value: T): ThreeSide | undefined {
    if (triple.length !== 3) {
      throw new Error(`expected a triple, got ${triple.length} items`);
    }
    const index = triple.indexOf(value);
    return index !== -1 ? ThreeSide.fromIndex(index) : undefined;
  }

  static map<T>(fn: (side: ThreeSide) => T): T[] {
    return [fn(ThreeSide.LEFT), fn(ThreeSide.BASE), fn(ThreeSide.RIGHT)];
  }
}
