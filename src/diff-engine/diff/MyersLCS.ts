// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/MyersLCS.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { BitSet } from './BitSet';
import { DiffConfig } from './DiffConfig';
import { FilesTooBigForDiffException } from './FilesTooBigForDiffException';

/**
 * Algorithm for finding the longest common subsequence of two sequences.
 * Based on E.W. Myers / An O(ND) Difference Algorithm and Its Variations / 1986.
 * O(ND) runtime, O(N) memory.
 */
export class MyersLCS {
  private readonly vForward: Int32Array;
  private readonly vBackward: Int32Array;

  constructor(
    private readonly first: readonly number[],
    private readonly second: readonly number[],
    private readonly start1: number = 0,
    private readonly count1: number = first.length,
    private readonly start2: number = 0,
    private readonly count2: number = second.length,
    private readonly changes1: BitSet = new BitSet(first.length),
    private readonly changes2: BitSet = new BitSet(second.length)
  ) {
    this.changes1.setRange(start1, start1 + count1);
    this.changes2.setRange(start2, start2 + count2);

    const totalSequenceLength = count1 + count2;
    this.vForward = new Int32Array(totalSequenceLength + 1);
    this.vBackward = new Int32Array(totalSequenceLength + 1);
  }

  /**
   * Runs the O(ND) Myers algorithm where D is bound by A + B * sqrt(N).
   *
   * Under certain assumptions about the distribution of the elements of the sequences
   * the expected running time of the Myers algorithm is O(N + D^2). Thus under the given
   * constraints it reduces to O(N).
   */
  executeLinear(): void {
    const threshold = 20000 + 10 * Math.floor(Math.sqrt(this.count1 + this.count2));
    this.executeBounded(threshold, false);
  }

  execute(): void {
    this.executeBounded(this.count1 + this.count2, false);
  }

  executeWithThreshold(): void {
    const threshold = Math.max(
      20000 + 10 * Math.floor(Math.sqrt(this.count1 + this.count2)),
      DiffConfig.DELTA_THRESHOLD_SIZE
    );
    this.executeBounded(threshold, true);
  }

  private executeBounded(threshold: number, throwException: boolean): void {
    if (this.count1 === 0 || this.count2 === 0) {
      return;
    }
    this.executeRange(
      0,
      this.count1,
      0,
      this.count2,
      Math.min(threshold, this.count1 + this.count2),
      throwException
    );
  }

  // LCS( old[oldStart, oldEnd), new[newStart, newEnd) )
  private executeRange(
    oldStart: number,
    oldEnd: number,
    newStart: number,
    newEnd: number,
    differenceEstimate: number,
    throwException: boolean
  ): void {
    if (oldStart > oldEnd || newStart > newEnd) {
      throw new Error('invalid range');
    }
    if (oldStart < oldEnd && newStart < newEnd) {
      const oldLength = oldEnd - oldStart;
      const newLength = newEnd - newStart;
      this.vForward[newLength + 1] = 0;
      this.vBackward[newLength + 1] = 0;
      const halfD = ((differenceEstimate + 1) / 2) | 0;
      let xx = -1;
      let kk = -1;
      let td = -1;

      loop: for (let d = 0; d <= halfD; d++) {
        const left = newLength + Math.max(-d, -newLength + ((d ^ newLength) & 1));
        const right = newLength + Math.min(d, oldLength - ((d ^ oldLength) & 1));
        for (let k = left; k <= right; k += 2) {
          let x =
            k === left || (k !== right && this.vForward[k - 1] < this.vForward[k + 1])
              ? this.vForward[k + 1]
              : this.vForward[k - 1] + 1;
          const y = x - k + newLength;
          x += this.commonSubsequenceLengthForward(
            oldStart + x,
            newStart + y,
            Math.min(oldEnd - oldStart - x, newEnd - newStart - y)
          );
          this.vForward[k] = x;
        }

        if ((oldLength - newLength) % 2 !== 0) {
          for (let k = left; k <= right; k += 2) {
            if (oldLength - (d - 1) <= k && k <= oldLength + (d - 1)) {
              if (this.vForward[k] + this.vBackward[newLength + oldLength - k] >= oldLength) {
                xx = this.vForward[k];
                kk = k;
                td = 2 * d - 1;
                break loop;
              }
            }
          }
        }

        for (let k = left; k <= right; k += 2) {
          let x =
            k === left || (k !== right && this.vBackward[k - 1] < this.vBackward[k + 1])
              ? this.vBackward[k + 1]
              : this.vBackward[k - 1] + 1;
          const y = x - k + newLength;
          x += this.commonSubsequenceLengthBackward(
            oldEnd - 1 - x,
            newEnd - 1 - y,
            Math.min(oldEnd - oldStart - x, newEnd - newStart - y)
          );
          this.vBackward[k] = x;
        }

        if ((oldLength - newLength) % 2 === 0) {
          for (let k = left; k <= right; k += 2) {
            if (oldLength - d <= k && k <= oldLength + d) {
              if (this.vForward[oldLength + newLength - k] + this.vBackward[k] >= oldLength) {
                xx = oldLength - this.vBackward[k];
                kk = oldLength + newLength - k;
                td = 2 * d;
                break loop;
              }
            }
          }
        }
      }

      if (td > 1) {
        const yy = xx - kk + newLength;
        const oldDiff = ((td + 1) / 2) | 0;
        if (0 < xx && 0 < yy) {
          this.executeRange(
            oldStart,
            oldStart + xx,
            newStart,
            newStart + yy,
            oldDiff,
            throwException
          );
        }
        if (oldStart + xx < oldEnd && newStart + yy < newEnd) {
          this.executeRange(
            oldStart + xx,
            oldEnd,
            newStart + yy,
            newEnd,
            td - oldDiff,
            throwException
          );
        }
      } else if (td >= 0) {
        let x = oldStart;
        let y = newStart;
        while (x < oldEnd && y < newEnd) {
          const commonLength = this.commonSubsequenceLengthForward(
            x,
            y,
            Math.min(oldEnd - x, newEnd - y)
          );
          if (commonLength > 0) {
            this.addUnchanged(x, y, commonLength);
            x += commonLength;
            y += commonLength;
          } else if (oldEnd - oldStart > newEnd - newStart) {
            ++x;
          } else {
            ++y;
          }
        }
      } else {
        // The difference is more than the given estimate
        if (throwException) {
          throw new FilesTooBigForDiffException();
        }
      }
    }
  }

  private addUnchanged(start1: number, start2: number, count: number): void {
    this.changes1.setRange(this.start1 + start1, this.start1 + start1 + count, false);
    this.changes2.setRange(this.start2 + start2, this.start2 + start2 + count, false);
  }

  private commonSubsequenceLengthForward(
    oldIndex: number,
    newIndex: number,
    maxLength: number
  ): number {
    let x = oldIndex;
    let y = newIndex;

    maxLength = Math.min(maxLength, Math.min(this.count1 - oldIndex, this.count2 - newIndex));
    while (
      x - oldIndex < maxLength &&
      this.first[this.start1 + x] === this.second[this.start2 + y]
    ) {
      ++x;
      ++y;
    }
    return x - oldIndex;
  }

  private commonSubsequenceLengthBackward(
    oldIndex: number,
    newIndex: number,
    maxLength: number
  ): number {
    let x = oldIndex;
    let y = newIndex;

    maxLength = Math.min(maxLength, Math.min(oldIndex, newIndex) + 1);
    while (
      oldIndex - x < maxLength &&
      this.first[this.start1 + x] === this.second[this.start2 + y]
    ) {
      --x;
      --y;
    }
    return oldIndex - x;
  }

  get changes(): [BitSet, BitSet] {
    return [this.changes1, this.changes2];
  }
}
