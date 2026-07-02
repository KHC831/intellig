// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/Side.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { IDiffFragment } from '../fragments/DiffFragment';
import { ILineFragment } from '../fragments/LineFragment';

/** One of the two sides of a two-way diff. */
export class Side {
  static readonly LEFT = new Side(0);
  static readonly RIGHT = new Side(1);

  private constructor(readonly index: number) {}

  get isLeft(): boolean {
    return this.index === 0;
  }

  other(flip: boolean = true): Side {
    if (!flip) {
      return this;
    }
    return this.isLeft ? Side.RIGHT : Side.LEFT;
  }

  select<T>(left: T, right: T): T {
    return this.isLeft ? left : right;
  }

  selectFrom<T>(pair: readonly T[]): T {
    if (pair.length !== 2) {
      throw new Error(`expected a pair, got ${pair.length} items`);
    }
    return pair[this.index];
  }

  getStartOffset(fragment: IDiffFragment): number {
    return this.isLeft ? fragment.startOffset1 : fragment.startOffset2;
  }

  getEndOffset(fragment: IDiffFragment): number {
    return this.isLeft ? fragment.endOffset1 : fragment.endOffset2;
  }

  getStartLine(fragment: ILineFragment): number {
    return this.isLeft ? fragment.startLine1 : fragment.startLine2;
  }

  getEndLine(fragment: ILineFragment): number {
    return this.isLeft ? fragment.endLine1 : fragment.endLine2;
  }

  static fromIndex(index: number): Side {
    if (index === 0) {
      return Side.LEFT;
    }
    if (index === 1) {
      return Side.RIGHT;
    }
    throw new RangeError(`index: ${index}`);
  }

  static fromLeft(isLeft: boolean): Side {
    return isLeft ? Side.LEFT : Side.RIGHT;
  }

  static fromRight(isRight: boolean): Side {
    return isRight ? Side.RIGHT : Side.LEFT;
  }

  static fromValue<T>(pair: readonly T[], value: T): Side | undefined {
    if (pair.length !== 2) {
      throw new Error(`expected a pair, got ${pair.length} items`);
    }
    const index = pair.indexOf(value);
    return index !== -1 ? Side.fromIndex(index) : undefined;
  }
}
