// Ported from intellij-community platform/diff-impl/src/com/intellij/diff/merge/TextMergeChange.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.
// The import-conflict and AI-resolve lanes are not ported.

import { IMergeLineFragment } from '../../diff-engine/fragments/MergeLineFragment';
import { MergeConflictType } from '../../diff-engine/util/MergeConflictType';
import { Side } from '../../diff-engine/util/Side';
import { ThreeSide } from '../../diff-engine/util/ThreeSide';
import { MergeModelBase, MergeModelState } from './MergeModelBase';
import { ThreesideDiffChangeBase } from './ThreesideDiffChangeBase';

export class TextMergeChangeState extends MergeModelState {
  constructor(
    index: number,
    startLine: number,
    endLine: number,
    readonly resolved1: boolean,
    readonly resolved2: boolean,
    readonly onesideAppliedConflict: boolean
  ) {
    super(index, startLine, endLine);
  }
}

export class TextMergeChange extends ThreesideDiffChangeBase {
  private readonly resolved: boolean[] = [false, false];
  private onesideAppliedConflict = false;

  constructor(
    readonly index: number,
    readonly fragment: IMergeLineFragment,
    conflictType: MergeConflictType,
    private readonly model: MergeModelBase<TextMergeChangeState>
  ) {
    super(conflictType);
  }

  setResolved(side: Side, value: boolean): void {
    this.resolved[side.index] = value;
  }

  isResolved(side?: Side | ThreeSide): boolean {
    if (side === undefined) {
      return this.resolved[0] && this.resolved[1];
    }
    if (side instanceof Side) {
      return side.selectFrom(this.resolved);
    }
    return side.select(this.resolved[0], this.isResolved(), this.resolved[1]);
  }

  get isOnesideAppliedConflict(): boolean {
    return this.onesideAppliedConflict;
  }

  markOnesideAppliedConflict(): void {
    this.onesideAppliedConflict = true;
  }

  get resultStartLine(): number {
    return this.model.getLineStart(this.index);
  }

  get resultEndLine(): number {
    return this.model.getLineEnd(this.index);
  }

  getStartLine(side: ThreeSide): number {
    if (side === ThreeSide.BASE) {
      return this.resultStartLine;
    }
    return this.fragment.getStartLine(side);
  }

  getEndLine(side: ThreeSide): number {
    if (side === ThreeSide.BASE) {
      return this.resultEndLine;
    }
    return this.fragment.getEndLine(side);
  }

  //
  // State
  //

  storeState(): TextMergeChangeState {
    return new TextMergeChangeState(
      this.index,
      this.resultStartLine,
      this.resultEndLine,
      this.resolved[0],
      this.resolved[1],
      this.onesideAppliedConflict
    );
  }

  restoreState(state: TextMergeChangeState): void {
    this.resolved[0] = state.resolved1;
    this.resolved[1] = state.resolved2;
    this.onesideAppliedConflict = state.onesideAppliedConflict;
  }

  resetState(): void {
    this.resolved[0] = false;
    this.resolved[1] = false;
    this.onesideAppliedConflict = false;
  }
}
