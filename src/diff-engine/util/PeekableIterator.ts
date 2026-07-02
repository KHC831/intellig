// Substitute for IntelliJ's com.intellij.util.containers.PeekableIteratorWrapper,
// over the engine's hasNext/next iterator shape.

import { IKtIterator } from '../comparison/iterables/DiffIterable';

export interface IPeekableIterator<T> extends IKtIterator<T> {
  peek(): T;
}

export class PeekableIteratorWrapper<T> implements IPeekableIterator<T> {
  private value: T | undefined;
  private hasValue = false;

  constructor(private readonly iterator: IKtIterator<T>) {
    this.advance();
  }

  hasNext(): boolean {
    return this.hasValue;
  }

  next(): T {
    if (!this.hasValue) {
      throw new Error('no more elements');
    }
    const result = this.value as T;
    this.advance();
    return result;
  }

  peek(): T {
    if (!this.hasValue) {
      throw new Error('no more elements');
    }
    return this.value as T;
  }

  private advance(): void {
    if (this.iterator.hasNext()) {
      this.value = this.iterator.next();
      this.hasValue = true;
    } else {
      this.value = undefined;
      this.hasValue = false;
    }
  }
}
