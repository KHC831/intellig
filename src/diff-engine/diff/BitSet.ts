// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/BitSet.kt
// (itself copied from the Kotlin/Native stdlib), reduced to the operations the diff
// engine uses and stored in 32-bit words (JS bitwise operators are 32-bit).
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

const ELEMENT_SIZE = 32;

export class BitSet {
  private bits: Uint32Array;
  /** Actual number of bits available in the set. All bits with indices >= size are 0. */
  private _size: number;

  constructor(size: number = ELEMENT_SIZE) {
    this._size = size;
    this.bits = new Uint32Array(bitToElementSize(size));
  }

  get size(): number {
    return this._size;
  }

  get(index: number): boolean {
    if (index < 0) {
      throw new RangeError(`index: ${index}`);
    }
    if (index >= this._size) {
      return false;
    }
    return (this.bits[(index / ELEMENT_SIZE) | 0] & (1 << (index % ELEMENT_SIZE))) !== 0;
  }

  set(index: number, value: boolean = true): void {
    this.ensureCapacity(index);
    const elementIndex = (index / ELEMENT_SIZE) | 0;
    const mask = 1 << (index % ELEMENT_SIZE);
    if (value) {
      this.bits[elementIndex] |= mask;
    } else {
      this.bits[elementIndex] &= ~mask;
    }
  }

  /** Sets the bits with indices between from (inclusive) and to (exclusive). */
  setRange(from: number, to: number, value: boolean = true): void {
    if (from < 0 || to < 0) {
      throw new RangeError(`range: [${from}, ${to})`);
    }
    if (from >= to) {
      return;
    }
    this.ensureCapacity(to - 1);
    for (let index = from; index < to; index++) {
      this.set(index, value);
    }
  }

  /**
   * Index of the next false bit at or after startIndex; size if there is none below size
   * (the set is assumed to continue with infinite false bits), startIndex itself when
   * startIndex >= size.
   */
  nextClearBit(startIndex: number = 0): number {
    if (startIndex < 0) {
      throw new RangeError(`startIndex: ${startIndex}`);
    }
    if (startIndex >= this._size) {
      return startIndex;
    }
    for (let i = startIndex; i < this._size; i++) {
      if (!this.get(i)) {
        return i;
      }
    }
    return this._size;
  }

  cardinality(): number {
    let count = 0;
    for (let i = 0; i < this._size; i++) {
      if (this.get(i)) {
        count++;
      }
    }
    return count;
  }

  equals(other: BitSet): boolean {
    const shorter = this.bits.length <= other.bits.length ? this.bits : other.bits;
    const longer = this.bits.length <= other.bits.length ? other.bits : this.bits;
    for (let i = 0; i < shorter.length; i++) {
      if (this.bits[i] !== other.bits[i]) {
        return false;
      }
    }
    for (let i = shorter.length; i < longer.length; i++) {
      if (longer[i] !== 0) {
        return false;
      }
    }
    return true;
  }

  toString(): string {
    const indices: number[] = [];
    for (let i = 0; i < this._size; i++) {
      if (this.get(i)) {
        indices.push(i);
      }
    }
    return `[${indices.join('|')}]`;
  }

  private ensureCapacity(index: number): void {
    if (index < 0) {
      throw new RangeError(`index: ${index}`);
    }
    if (index >= this._size) {
      this._size = index + 1;
      const neededElements = bitToElementSize(index + 1);
      if (neededElements > this.bits.length) {
        const grown = new Uint32Array(neededElements);
        grown.set(this.bits);
        this.bits = grown;
      }
    }
  }
}

function bitToElementSize(bitSize: number): number {
  return ((bitSize + ELEMENT_SIZE - 1) / ELEMENT_SIZE) | 0;
}
