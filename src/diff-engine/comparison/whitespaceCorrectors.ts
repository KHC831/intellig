// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ByWordRt.kt
// (the whitespace-matching correctors). Copyright 2000-2024 JetBrains s.r.o. and
// contributors. Apache 2.0 license.

import { MergeRange } from '../util/MergeRange';
import { Range } from '../util/Range';
import { ICancellationChecker } from './CancellationChecker';
import { IDiffIterable } from './iterables/DiffIterable';
import { create } from './iterables/DiffIterableUtil';
import { isSpaceEnterOrTabAt } from './strings';
import {
  expandWhitespacesBackward,
  expandWhitespacesBackward3,
  expandWhitespacesForward,
  expandWhitespacesForward3,
  expandWhitespacesRange,
  expandWhitespacesRange3,
  isEquals,
  isEquals3,
  isEqualsIgnoreWhitespaces,
  isEqualsIgnoreWhitespaces3,
  trimEnd,
  trimRange2,
  trimRange3,
  trimStart,
} from './TrimUtil';

export class DefaultCorrector {
  private readonly changes: Range[] = [];

  constructor(
    private readonly iterable: IDiffIterable,
    private readonly text1: string,
    private readonly text2: string,
    _indicator: ICancellationChecker
  ) {}

  build(): IDiffIterable {
    for (const range of this.iterable.iterateChanges()) {
      const endCut = expandWhitespacesBackward(
        this.text1,
        this.text2,
        range.start1,
        range.start2,
        range.end1,
        range.end2
      );
      const startCut = expandWhitespacesForward(
        this.text1,
        this.text2,
        range.start1,
        range.start2,
        range.end1 - endCut,
        range.end2 - endCut
      );

      const expanded = new Range(
        range.start1 + startCut,
        range.end1 - endCut,
        range.start2 + startCut,
        range.end2 - endCut
      );

      if (!expanded.isEmpty) {
        this.changes.push(expanded);
      }
    }

    return create(this.changes, this.text1.length, this.text2.length);
  }
}

export class MergeDefaultCorrector {
  private readonly changes: MergeRange[] = [];

  constructor(
    private readonly iterable: readonly MergeRange[],
    private readonly text1: string,
    private readonly text2: string,
    private readonly text3: string,
    _indicator: ICancellationChecker
  ) {}

  build(): MergeRange[] {
    for (const range of this.iterable) {
      const endCut = expandWhitespacesBackward3(
        this.text1,
        this.text2,
        this.text3,
        range.start1,
        range.start2,
        range.start3,
        range.end1,
        range.end2,
        range.end3
      );
      const startCut = expandWhitespacesForward3(
        this.text1,
        this.text2,
        this.text3,
        range.start1,
        range.start2,
        range.start3,
        range.end1 - endCut,
        range.end2 - endCut,
        range.end3 - endCut
      );

      const expanded = new MergeRange(
        range.start1 + startCut,
        range.end1 - endCut,
        range.start2 + startCut,
        range.end2 - endCut,
        range.start3 + startCut,
        range.end3 - endCut
      );

      if (!expanded.isEmpty) {
        this.changes.push(expanded);
      }
    }

    return this.changes;
  }
}

export class IgnoreSpacesCorrector {
  private readonly changes: Range[] = [];

  constructor(
    private readonly iterable: IDiffIterable,
    private readonly text1: string,
    private readonly text2: string,
    _indicator: ICancellationChecker
  ) {}

  build(): IDiffIterable {
    for (const range of this.iterable.iterateChanges()) {
      // match spaces if we can, ignore them if we can't
      const expanded = expandWhitespacesRange(this.text1, this.text2, range);
      const trimmed = trimRange2(this.text1, this.text2, expanded);

      if (!trimmed.isEmpty && !isEqualsIgnoreWhitespaces(this.text1, this.text2, trimmed)) {
        this.changes.push(trimmed);
      }
    }

    return create(this.changes, this.text1.length, this.text2.length);
  }
}

export class MergeIgnoreSpacesCorrector {
  private readonly changes: MergeRange[] = [];

  constructor(
    private readonly iterable: readonly MergeRange[],
    private readonly text1: string,
    private readonly text2: string,
    private readonly text3: string,
    _indicator: ICancellationChecker
  ) {}

  build(): MergeRange[] {
    for (const range of this.iterable) {
      const expanded = expandWhitespacesRange3(this.text1, this.text2, this.text3, range);
      const trimmed = trimRange3(this.text1, this.text2, this.text3, expanded);

      if (
        !trimmed.isEmpty &&
        !isEqualsIgnoreWhitespaces3(this.text1, this.text2, this.text3, trimmed)
      ) {
        this.changes.push(trimmed);
      }
    }

    return this.changes;
  }
}

export class TrimSpacesCorrector {
  private readonly changes: Range[] = [];

  constructor(
    private readonly iterable: IDiffIterable,
    private readonly text1: string,
    private readonly text2: string,
    _indicator: ICancellationChecker
  ) {}

  build(): IDiffIterable {
    for (const range of this.iterable.iterateChanges()) {
      let start1 = range.start1;
      let start2 = range.start2;
      let end1 = range.end1;
      let end2 = range.end2;

      if (isLeadingTrailingSpace(this.text1, start1)) {
        start1 = trimStart(this.text1, start1, end1);
      }
      if (isLeadingTrailingSpace(this.text1, end1 - 1)) {
        end1 = trimEnd(this.text1, start1, end1);
      }
      if (isLeadingTrailingSpace(this.text2, start2)) {
        start2 = trimStart(this.text2, start2, end2);
      }
      if (isLeadingTrailingSpace(this.text2, end2 - 1)) {
        end2 = trimEnd(this.text2, start2, end2);
      }

      const trimmed = new Range(start1, end1, start2, end2);

      if (!trimmed.isEmpty && !isEquals(this.text1, this.text2, trimmed)) {
        this.changes.push(trimmed);
      }
    }

    return create(this.changes, this.text1.length, this.text2.length);
  }
}

export class MergeTrimSpacesCorrector {
  private readonly changes: MergeRange[] = [];

  constructor(
    private readonly iterable: readonly MergeRange[],
    private readonly text1: string,
    private readonly text2: string,
    private readonly text3: string,
    _indicator: ICancellationChecker
  ) {}

  build(): MergeRange[] {
    for (const range of this.iterable) {
      let start1 = range.start1;
      let start2 = range.start2;
      let start3 = range.start3;
      let end1 = range.end1;
      let end2 = range.end2;
      let end3 = range.end3;

      if (isLeadingTrailingSpace(this.text1, start1)) {
        start1 = trimStart(this.text1, start1, end1);
      }
      if (isLeadingTrailingSpace(this.text1, end1 - 1)) {
        end1 = trimEnd(this.text1, start1, end1);
      }
      if (isLeadingTrailingSpace(this.text2, start2)) {
        start2 = trimStart(this.text2, start2, end2);
      }
      if (isLeadingTrailingSpace(this.text2, end2 - 1)) {
        end2 = trimEnd(this.text2, start2, end2);
      }
      if (isLeadingTrailingSpace(this.text3, start3)) {
        start3 = trimStart(this.text3, start3, end3);
      }
      if (isLeadingTrailingSpace(this.text3, end3 - 1)) {
        end3 = trimEnd(this.text3, start3, end3);
      }

      const trimmed = new MergeRange(start1, end1, start2, end2, start3, end3);

      if (!trimmed.isEmpty && !isEquals3(this.text1, this.text2, this.text3, trimmed)) {
        this.changes.push(trimmed);
      }
    }

    return this.changes;
  }
}

export function isLeadingTrailingSpace(text: string, start: number): boolean {
  return isLeadingSpace(text, start) || isTrailingSpace(text, start);
}

function isLeadingSpace(text: string, start: number): boolean {
  if (start < 0) {
    return false;
  }
  if (start === text.length) {
    return false;
  }
  if (!isSpaceEnterOrTabAt(text, start)) {
    return false;
  }

  start--;
  while (start >= 0) {
    if (text[start] === '\n') {
      return true;
    }
    if (!isSpaceEnterOrTabAt(text, start)) {
      return false;
    }
    start--;
  }
  return true;
}

function isTrailingSpace(text: string, end: number): boolean {
  if (end < 0) {
    return false;
  }
  if (end === text.length) {
    return false;
  }
  if (!isSpaceEnterOrTabAt(text, end)) {
    return false;
  }

  while (end < text.length) {
    if (text[end] === '\n') {
      return true;
    }
    if (!isSpaceEnterOrTabAt(text, end)) {
      return false;
    }
    end++;
  }
  return true;
}
