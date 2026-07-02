// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/PatienceIntLCS.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { BitSet } from './BitSet';
import { FilesTooBigForDiffException } from './FilesTooBigForDiffException';
import { MyersLCS } from './MyersLCS';
import { UniqueLCS } from './UniqueLCS';

export class PatienceIntLCS {
  constructor(
    private readonly first: readonly number[],
    private readonly second: readonly number[],
    private readonly start1: number = 0,
    private readonly count1: number = first.length,
    private readonly start2: number = 0,
    private readonly count2: number = second.length,
    private readonly changes1: BitSet = new BitSet(first.length),
    private readonly changes2: BitSet = new BitSet(second.length)
  ) {}

  execute(failOnSmallReduction: boolean = false): void {
    const thresholdCheckCounter = failOnSmallReduction ? 2 : -1;
    this.executeRange(this.start1, this.count1, this.start2, this.count2, thresholdCheckCounter);
  }

  private executeRange(
    start1: number,
    count1: number,
    start2: number,
    count2: number,
    thresholdCheckCounter: number
  ): void {
    if (count1 === 0 && count2 === 0) {
      return;
    }

    if (count1 === 0 || count2 === 0) {
      this.addChange(start1, count1, start2, count2);
      return;
    }

    const startOffset = this.matchForward(start1, count1, start2, count2);
    start1 += startOffset;
    start2 += startOffset;
    count1 -= startOffset;
    count2 -= startOffset;

    const endOffset = this.matchBackward(start1, count1, start2, count2);
    count1 -= endOffset;
    count2 -= endOffset;

    if (count1 === 0 || count2 === 0) {
      this.addChange(start1, count1, start2, count2);
    } else {
      if (thresholdCheckCounter === 0) {
        this.checkReduction(count1, count2);
      }
      thresholdCheckCounter = Math.max(-1, thresholdCheckCounter - 1);

      const uniqueLCS = new UniqueLCS(this.first, this.second, start1, count1, start2, count2);
      const matching = uniqueLCS.execute();

      if (matching === undefined) {
        if (thresholdCheckCounter >= 0) {
          this.checkReduction(count1, count2);
        }
        const intLCS = new MyersLCS(
          this.first,
          this.second,
          start1,
          count1,
          start2,
          count2,
          this.changes1,
          this.changes2
        );
        intLCS.executeLinear();
      } else {
        let s1: number;
        let s2: number;
        let c1: number;
        let c2: number;
        const matched = matching[0].length;
        if (matched <= 0) {
          throw new Error('unique LCS returned an empty matching');
        }

        c1 = matching[0][0];
        c2 = matching[1][0];

        this.executeRange(start1, c1, start2, c2, thresholdCheckCounter);

        for (let i = 1; i < matching[0].length; i++) {
          s1 = matching[0][i - 1] + 1;
          s2 = matching[1][i - 1] + 1;

          c1 = matching[0][i] - s1;
          c2 = matching[1][i] - s2;

          if (c1 > 0 || c2 > 0) {
            this.executeRange(start1 + s1, c1, start2 + s2, c2, thresholdCheckCounter);
          }
        }

        if (matching[0][matched - 1] === count1 - 1) {
          s1 = count1 - 1;
          c1 = 0;
        } else {
          s1 = matching[0][matched - 1] + 1;
          c1 = count1 - s1;
        }
        if (matching[1][matched - 1] === count2 - 1) {
          s2 = count2 - 1;
          c2 = 0;
        } else {
          s2 = matching[1][matched - 1] + 1;
          c2 = count2 - s2;
        }

        this.executeRange(start1 + s1, c1, start2 + s2, c2, thresholdCheckCounter);
      }
    }
  }

  private matchForward(start1: number, count1: number, start2: number, count2: number): number {
    const size = Math.min(count1, count2);
    let idx = 0;
    for (let i = 0; i < size; i++) {
      if (this.first[start1 + i] !== this.second[start2 + i]) {
        break;
      }
      ++idx;
    }
    return idx;
  }

  private matchBackward(start1: number, count1: number, start2: number, count2: number): number {
    const size = Math.min(count1, count2);
    let idx = 0;
    for (let i = 1; i <= size; i++) {
      if (this.first[start1 + count1 - i] !== this.second[start2 + count2 - i]) {
        break;
      }
      ++idx;
    }
    return idx;
  }

  private addChange(start1: number, count1: number, start2: number, count2: number): void {
    this.changes1.setRange(start1, start1 + count1);
    this.changes2.setRange(start2, start2 + count2);
  }

  get changes(): [BitSet, BitSet] {
    return [this.changes1, this.changes2];
  }

  private checkReduction(count1: number, count2: number): void {
    if (count1 * 2 < this.count1) {
      return;
    }
    if (count2 * 2 < this.count2) {
      return;
    }
    throw new FilesTooBigForDiffException();
  }
}
