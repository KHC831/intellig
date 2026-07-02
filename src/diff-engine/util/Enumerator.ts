// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/Enumerator.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

/** Assigns a stable positive integer to each distinct value it sees (equal values share a number). */
export class Enumerator<T> {
  private readonly numbers = new Map<T, number>();
  private nextNumber = 1;

  enumerate(objects: readonly T[], startShift: number = 0, endCut: number = 0): number[] {
    const result = new Array<number>(objects.length - startShift - endCut);
    for (let i = 0; i < result.length; i++) {
      result[i] = this.enumerateOne(objects[startShift + i]);
    }
    return result;
  }

  private enumerateOne(obj: T): number {
    let number = this.numbers.get(obj);
    if (number === undefined) {
      number = this.nextNumber++;
      this.numbers.set(obj, number);
    }
    return number;
  }
}
