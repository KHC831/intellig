// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/DiffFragmentsDiffIterable.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { IDiffFragment } from '../../fragments/DiffFragment';
import { ChangeDiffIterableBase, IChangeIterable } from './ChangeDiffIterableBase';

export class DiffFragmentsDiffIterable extends ChangeDiffIterableBase {
  constructor(
    private readonly fragments: readonly IDiffFragment[],
    length1: number,
    length2: number
  ) {
    super(length1, length2);
  }

  protected createChangeIterable(): IChangeIterable {
    return new FragmentsChangeIterable(this.fragments);
  }
}

class FragmentsChangeIterable implements IChangeIterable {
  private index = 0;
  private last: IDiffFragment | undefined;

  constructor(private readonly fragments: readonly IDiffFragment[]) {
    this.next();
  }

  valid(): boolean {
    return this.last !== undefined;
  }

  next(): void {
    this.last = this.index < this.fragments.length ? this.fragments[this.index++] : undefined;
  }

  get start1(): number {
    return (this.last as IDiffFragment).startOffset1;
  }

  get start2(): number {
    return (this.last as IDiffFragment).startOffset2;
  }

  get end1(): number {
    return (this.last as IDiffFragment).endOffset1;
  }

  get end2(): number {
    return (this.last as IDiffFragment).endOffset2;
  }
}
