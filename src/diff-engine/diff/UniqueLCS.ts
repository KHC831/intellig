// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/UniqueLCS.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

export class UniqueLCS {
  constructor(
    private readonly first: readonly number[],
    private readonly second: readonly number[],
    private readonly start1: number = 0,
    private readonly count1: number = first.length,
    private readonly start2: number = 0,
    private readonly count2: number = second.length
  ) {}

  execute(): [number[], number[]] | undefined {
    // map: key -> (offset1 + 1); -1 marks non-unique keys
    // match: offset1 -> (offset2 + 1)
    const map = new Map<number, number>();
    const match = new Array<number>(this.count1).fill(0);

    for (let i = 0; i < this.count1; i++) {
      const index = this.start1 + i;
      const value = map.get(this.first[index]) ?? 0;

      if (value === -1) {
        continue;
      }
      if (value === 0) {
        map.set(this.first[index], i + 1);
      } else {
        map.set(this.first[index], -1);
      }
    }

    let count = 0;
    for (let i = 0; i < this.count2; i++) {
      const index = this.start2 + i;
      const value = map.get(this.second[index]) ?? 0;

      if (value === 0 || value === -1) {
        continue;
      }
      if (match[value - 1] === 0) {
        match[value - 1] = i + 1;
        count++;
      } else {
        match[value - 1] = 0;
        map.set(this.second[index], -1);
        count--;
      }
    }

    if (count === 0) {
      return undefined;
    }

    // Longest increasing subsequence on unique elements
    const sequence = new Array<number>(count).fill(0);
    const lastElement = new Array<number>(count).fill(0);
    const predecessor = new Array<number>(this.count1).fill(0);

    let length = 0;
    for (let i = 0; i < this.count1; i++) {
      if (match[i] === 0) {
        continue;
      }

      const j = insertionPoint(sequence, match[i], length);
      if (j === length || match[i] < sequence[j]) {
        sequence[j] = match[i];
        lastElement[j] = i;
        predecessor[i] = j > 0 ? lastElement[j - 1] : -1;
        if (j === length) {
          length++;
        }
      }
    }

    const ret: [number[], number[]] = [new Array<number>(length), new Array<number>(length)];

    let i = length - 1;
    let curr = lastElement[length - 1];
    while (curr !== -1) {
      ret[0][i] = curr;
      ret[1][i] = match[curr] - 1;
      i--;
      curr = predecessor[curr];
    }

    return ret;
  }
}

// find max i: a[i] < value, return i + 1 (the values are unique, so no equal element exists)
function insertionPoint(sequence: readonly number[], value: number, length: number): number {
  let low = 0;
  let high = length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (sequence[mid] < value) {
      low = mid + 1;
    } else if (sequence[mid] > value) {
      high = mid - 1;
    } else {
      throw new Error('unexpected equal element in unique sequence');
    }
  }
  return low;
}
