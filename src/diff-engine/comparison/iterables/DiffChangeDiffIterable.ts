// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/iterables/DiffChangeDiffIterable.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { Change } from '../../diff/Diff';
import { ChangeDiffIterableBase, IChangeIterable } from './ChangeDiffIterableBase';

export class DiffChangeDiffIterable extends ChangeDiffIterableBase {
  constructor(
    private readonly change: Change | undefined,
    length1: number,
    length2: number
  ) {
    super(length1, length2);
  }

  protected createChangeIterable(): IChangeIterable {
    return new DiffChangeChangeIterable(this.change);
  }
}

class DiffChangeChangeIterable implements IChangeIterable {
  constructor(private change: Change | undefined) {}

  valid(): boolean {
    return this.change !== undefined;
  }

  next(): void {
    this.change = (this.change as Change).link;
  }

  get start1(): number {
    return (this.change as Change).line0;
  }

  get start2(): number {
    return (this.change as Change).line1;
  }

  get end1(): number {
    const change = this.change as Change;
    return change.line0 + change.deleted;
  }

  get end2(): number {
    const change = this.change as Change;
    return change.line1 + change.inserted;
  }
}
