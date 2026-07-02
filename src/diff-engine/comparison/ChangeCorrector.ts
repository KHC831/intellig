// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ChangeCorrector.kt
// (base class + SmartLineChangeCorrector; DefaultCharChangeCorrector lives in ByCharRt.ts to
// mirror the Kotlin mutual recursion without a module cycle).
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { ICancellationChecker } from './CancellationChecker';
import { IFairDiffIterable } from './iterables/DiffIterable';
import { ChangeBuilder, diff, fair } from './iterables/DiffIterableUtil';
import { expand } from './TrimUtil';

/** An element whose diff equality is decided by a canonical key (Kotlin relies on equals/hashCode). */
export interface IKeyedElement {
  readonly equalityKey: string;
}

/**
 * Base class for two-step diff algorithms. Given a matching between some sub-sequences
 * of the base sequences, builds a matching on the whole base sequences.
 */
export abstract class ChangeCorrector {
  protected readonly builder: ChangeBuilder;

  constructor(
    private readonly length1: number,
    private readonly length2: number,
    private readonly changes: IFairDiffIterable,
    protected readonly indicator: ICancellationChecker
  ) {
    this.builder = new ChangeBuilder(length1, length2);
  }

  build(): IFairDiffIterable {
    this.execute();
    return fair(this.builder.finish());
  }

  protected execute(): void {
    let last1 = 0;
    let last2 = 0;

    for (const ch of this.changes.iterateUnchanged()) {
      const count = ch.end1 - ch.start1;
      for (let i = 0; i < count; i++) {
        const range1 = this.getOriginalRange1(ch.start1 + i);
        const range2 = this.getOriginalRange2(ch.start2 + i);

        const start1 = range1[0];
        const start2 = range2[0];
        const end1 = range1[1];
        const end2 = range2[1];

        this.matchGap(last1, start1, last2, start2);
        this.builder.markEqualRange(start1, start2, end1, end2);

        last1 = end1;
        last2 = end2;
      }
    }
    this.matchGap(last1, this.length1, last2, this.length2);
  }

  /** Match elements in range [start1, end1) -> [start2, end2). */
  protected abstract matchGap(start1: number, end1: number, start2: number, end2: number): void;

  protected abstract getOriginalRange1(index: number): readonly [number, number];

  protected abstract getOriginalRange2(index: number): readonly [number, number];
}

export class SmartLineChangeCorrector extends ChangeCorrector {
  constructor(
    private readonly indexes1: readonly number[],
    private readonly indexes2: readonly number[],
    private readonly lines1: readonly IKeyedElement[],
    private readonly lines2: readonly IKeyedElement[],
    changes: IFairDiffIterable,
    indicator: ICancellationChecker
  ) {
    super(lines1.length, lines2.length, changes, indicator);
  }

  protected matchGap(start1: number, end1: number, start2: number, end2: number): void {
    const expanded = expand(
      this.lines1,
      this.lines2,
      start1,
      start2,
      end1,
      end2,
      (index1, index2) => this.lines1[index1].equalityKey === this.lines2[index2].equalityKey
    );

    const inner1 = this.lines1.slice(expanded.start1, expanded.end1);
    const inner2 = this.lines2.slice(expanded.start2, expanded.end2);
    const innerChanges = diff(inner1, inner2, this.indicator, (line) => line.equalityKey);

    this.builder.markEqualRange(start1, start2, expanded.start1, expanded.start2);

    for (const chunk of innerChanges.iterateUnchanged()) {
      this.builder.markEqual(
        expanded.start1 + chunk.start1,
        expanded.start2 + chunk.start2,
        chunk.end1 - chunk.start1
      );
    }

    this.builder.markEqualRange(expanded.end1, expanded.end2, end1, end2);
  }

  protected getOriginalRange1(index: number): readonly [number, number] {
    const offset = this.indexes1[index];
    return [offset, offset + 1];
  }

  protected getOriginalRange2(index: number): readonly [number, number] {
    const offset = this.indexes2[index];
    return [offset, offset + 1];
  }
}
