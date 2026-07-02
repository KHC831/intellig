// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/Diff.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Enumerator } from '../util/Enumerator';
import { BitSet } from './BitSet';
import { DiffConfig } from './DiffConfig';
import { FilesTooBigForDiffException } from './FilesTooBigForDiffException';
import { ILCSBuilder } from './LCSBuilder';
import { MyersLCS } from './MyersLCS';
import { PatienceIntLCS } from './PatienceIntLCS';
import { Reindexer } from './Reindexer';

/**
 * One entry of an edit script, as a linked list.
 *
 * line0 and line1 are the first affected lines in the two files (origin 0).
 * If deleted is 0 then line0 is the number of the line before which the
 * insertion was done; vice versa for inserted and line1.
 */
export class Change {
  constructor(
    /** Line number of the 1st deleted line. */
    readonly line0: number,
    /** Line number of the 1st inserted line. */
    readonly line1: number,
    /** Number of lines of file 0 changed here. */
    readonly deleted: number,
    /** Number of lines of file 1 changed here. */
    readonly inserted: number,
    /** Previous or next edit command. */
    public link: Change | undefined
  ) {}

  toString(): string {
    return `change[inserted=${this.inserted}, deleted=${this.deleted}, line0=${this.line0}, line1=${this.line1}]`;
  }

  toList(): Change[] {
    const result: Change[] = [this];
    let current = this.link;
    while (current !== undefined) {
      result.push(current);
      current = current.link;
    }
    return result;
  }
}

export class ChangeBuilder implements ILCSBuilder {
  private index1 = 0;
  private index2 = 0;
  private _firstChange: Change | undefined;
  private lastChange: Change | undefined;

  constructor(startShift: number) {
    this.skip(startShift, startShift);
  }

  get firstChange(): Change | undefined {
    return this._firstChange;
  }

  addChange(first: number, second: number): void {
    const change = new Change(this.index1, this.index2, first, second, undefined);
    if (this.lastChange !== undefined) {
      this.lastChange.link = change;
    } else {
      this._firstChange = change;
    }
    this.lastChange = change;
    this.skip(first, second);
  }

  addEqual(length: number): void {
    this.skip(length, length);
  }

  private skip(first: number, second: number): void {
    this.index1 += first;
    this.index2 += second;
  }
}

export function buildChanges<T>(
  objects1: readonly T[],
  objects2: readonly T[]
): Change | undefined {
  const startShift = getStartShift(objects1, objects2);
  const endCut = getEndCut(objects1, objects2, startShift);

  const changeRef = doBuildChangesFast(objects1.length, objects2.length, startShift, endCut);
  if (changeRef !== undefined) {
    return changeRef.value;
  }

  const enumerator = new Enumerator<T>();
  const ints1 = enumerator.enumerate(objects1, startShift, endCut);
  const ints2 = enumerator.enumerate(objects2, startShift, endCut);
  return doBuildChanges(ints1, ints2, new ChangeBuilder(startShift));
}

export function buildChangesInts(
  array1: readonly number[],
  array2: readonly number[]
): Change | undefined {
  const startShift = getStartShift(array1, array2);
  const endCut = getEndCut(array1, array2, startShift);

  const changeRef = doBuildChangesFast(array1.length, array2.length, startShift, endCut);
  if (changeRef !== undefined) {
    return changeRef.value;
  }

  const copyArray = startShift !== 0 || endCut !== 0;
  const ints1 = copyArray ? array1.slice(startShift, array1.length - endCut) : array1;
  const ints2 = copyArray ? array2.slice(startShift, array2.length - endCut) : array2;
  return doBuildChanges(ints1, ints2, new ChangeBuilder(startShift));
}

// Distinguishes "fast path applies, and the answer is value (possibly no change at all)"
// (a Ref) from "fast path does not apply" (undefined).
type Ref = { readonly value: Change | undefined };

function doBuildChangesFast(
  length1: number,
  length2: number,
  startShift: number,
  endCut: number
): Ref | undefined {
  const trimmedLength1 = length1 - startShift - endCut;
  const trimmedLength2 = length2 - startShift - endCut;
  if (trimmedLength1 !== 0 && trimmedLength2 !== 0) {
    return undefined;
  }
  const change =
    trimmedLength1 !== 0 || trimmedLength2 !== 0
      ? new Change(startShift, startShift, trimmedLength1, trimmedLength2, undefined)
      : undefined;
  return { value: change };
}

function doBuildChanges(
  ints1: readonly number[],
  ints2: readonly number[],
  builder: ChangeBuilder
): Change | undefined {
  const reindexer = new Reindexer(); // discard unique elements, that have no chance to be matched
  const discarded = reindexer.discardUnique(ints1, ints2);

  if (discarded[0].length === 0 && discarded[1].length === 0) {
    // assert trimmedLength > 0
    builder.addChange(ints1.length, ints2.length);
    return builder.firstChange;
  }

  let changes: [BitSet, BitSet];
  if (DiffConfig.USE_PATIENCE_ALG) {
    const patienceIntLCS = new PatienceIntLCS(discarded[0], discarded[1]);
    patienceIntLCS.execute();
    changes = patienceIntLCS.changes;
  } else {
    try {
      const intLCS = new MyersLCS(discarded[0], discarded[1]);
      intLCS.executeWithThreshold();
      changes = intLCS.changes;
    } catch (e) {
      if (!(e instanceof FilesTooBigForDiffException)) {
        throw e;
      }
      const patienceIntLCS = new PatienceIntLCS(discarded[0], discarded[1]);
      patienceIntLCS.execute(true);
      changes = patienceIntLCS.changes;
    }
  }

  reindexer.reindex(changes, builder);
  return builder.firstChange;
}

function getStartShift<T>(o1: readonly T[], o2: readonly T[]): number {
  const size = Math.min(o1.length, o2.length);
  let idx = 0;
  for (let i = 0; i < size; i++) {
    if (o1[i] !== o2[i]) {
      break;
    }
    ++idx;
  }
  return idx;
}

function getEndCut<T>(o1: readonly T[], o2: readonly T[], startShift: number): number {
  const size = Math.min(o1.length, o2.length) - startShift;
  let idx = 0;

  for (let i = 0; i < size; i++) {
    if (o1[o1.length - i - 1] !== o2[o2.length - i - 1]) {
      break;
    }
    ++idx;
  }
  return idx;
}
