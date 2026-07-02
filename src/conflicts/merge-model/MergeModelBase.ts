// Ported from intellij-community platform/diff-impl/src/com/intellij/diff/merge/MergeModelBase.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.
//
// Tracks one line range per change in the result document and keeps those
// ranges correct while the document is edited. IntelliJ's UndoManager and
// write commands are replaced by MergeUndoManager.

import { LineRange } from '../../diff-engine/util/LineRange';
import {
  applyModification,
  countLinesShift,
  getAffectedLineRange,
  updateRangeOnModification,
} from './documentUtil';
import type { IDocumentEvent, IMergeDocument, IMergeDocumentListener } from './MergeDocument';
import { IUndoableAction, MergeUndoManager } from './MergeUndoManager';

export class MergeModelState {
  constructor(
    readonly index: number,
    readonly startLine: number,
    readonly endLine: number
  ) {}
}

class StateUndoableAction<S extends MergeModelState> implements IUndoableAction {
  constructor(
    private readonly model: MergeModelBase<S>,
    private readonly states: readonly S[],
    private readonly isUndo: boolean
  ) {}

  undo(): void {
    if (this.isUndo) {
      this.model.restoreStates(this.states);
    }
  }

  redo(): void {
    if (!this.isUndo) {
      this.model.restoreStates(this.states);
    }
  }
}

export abstract class MergeModelBase<S extends MergeModelState> {
  private readonly startLines: number[] = [];
  private readonly endLines: number[] = [];

  private readonly changesToUpdate = new Set<number>();
  private bulkChangeUpdateDepth = 0;

  private insideCommand = false;
  private disposed = false;

  private readonly documentListener: IMergeDocumentListener;

  constructor(
    private readonly document: IMergeDocument,
    private readonly undoManager: MergeUndoManager
  ) {
    this.documentListener = {
      beforeDocumentChange: (event: IDocumentEvent): void => this.beforeDocumentChange(event),
      documentChanged: (): void => this.documentChanged(),
    };
    document.addDocumentListener(this.documentListener);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    if (this.bulkChangeUpdateDepth !== 0) {
      throw new Error('disposed inside a bulk change update');
    }

    this.clearAll();
    this.document.removeDocumentListener(this.documentListener);
  }

  get changesCount(): number {
    return this.startLines.length;
  }

  getLineStart(index: number): number {
    return this.startLines[index];
  }

  getLineEnd(index: number): number {
    return this.endLines[index];
  }

  setChanges(changes: readonly LineRange[]): void {
    this.clearAll();

    for (const range of changes) {
      this.startLines.push(range.start);
      this.endLines.push(range.end);
    }
  }

  private setLineStart(index: number, line: number): void {
    this.startLines[index] = line;
  }

  private setLineEnd(index: number, line: number): void {
    this.endLines[index] = line;
  }

  private clearAll(): void {
    this.startLines.length = 0;
    this.endLines.length = 0;
  }

  //
  // Repaint
  //

  invalidateChange(index: number): void {
    if (this.bulkChangeUpdateDepth > 0) {
      this.changesToUpdate.add(index);
    } else {
      this.onChangeUpdated(index);
    }
  }

  private enterBulkChangeUpdateBlock(): void {
    this.bulkChangeUpdateDepth++;
  }

  private exitBulkChangeUpdateBlock(): void {
    this.bulkChangeUpdateDepth--;
    if (this.bulkChangeUpdateDepth < 0) {
      throw new Error('unbalanced bulk change update block');
    }

    if (this.bulkChangeUpdateDepth === 0) {
      for (const index of this.changesToUpdate) {
        this.onChangeUpdated(index);
      }
      this.changesToUpdate.clear();
      this.onBulkUpdateFinished();
    }
  }

  protected abstract onChangeUpdated(index: number): void;

  protected onBulkUpdateFinished(): void {}

  //
  // Undo
  //

  protected abstract storeChangeState(index: number): S;

  protected restoreChangeState(state: S): void {
    this.setLineStart(state.index, state.startLine);
    this.setLineEnd(state.index, state.endLine);
  }

  protected processDocumentChange(
    index: number,
    oldLine1: number,
    oldLine2: number,
    shift: number
  ): S | undefined {
    const line1 = this.getLineStart(index);
    const line2 = this.getLineEnd(index);

    const newRange = updateRangeOnModification(line1, line2, oldLine1, oldLine2, shift);

    // RangeMarker can be updated in a different way
    const rangeAffected = newRange.damaged || (oldLine2 >= line1 && oldLine1 <= line2);

    const rangeManuallyEdit = newRange.damaged || (oldLine2 > line1 && oldLine1 < line2);
    if (rangeManuallyEdit && !this.insideCommand && !this.undoManager.isUndoOrRedoInProgress) {
      this.onRangeManuallyEdit(index);
    }

    const oldState = rangeAffected ? this.storeChangeState(index) : undefined;

    this.setLineStart(index, newRange.startLine);
    this.setLineEnd(index, newRange.endLine);

    return oldState;
  }

  protected onRangeManuallyEdit(_index: number): void {}

  private beforeDocumentChange(event: IDocumentEvent): void {
    if (this.disposed) {
      return;
    }
    this.enterBulkChangeUpdateBlock();

    if (this.changesCount === 0) {
      return;
    }

    const lineRange = getAffectedLineRange(this.document, event);
    const shift = countLinesShift(event);

    const corruptedStates: S[] = [];
    for (let index = 0; index < this.changesCount; index++) {
      const oldState = this.processDocumentChange(index, lineRange.start, lineRange.end, shift);
      if (oldState === undefined) {
        continue;
      }

      this.invalidateChange(index);
      if (!this.insideCommand) {
        corruptedStates.push(oldState);
      }
    }

    if (corruptedStates.length > 0) {
      // The document registers its own restore action after this one, so on
      // undo the text comes back first and these states then repair the ranges.
      this.undoManager.undoableActionPerformed(
        new StateUndoableAction<S>(this, corruptedStates, true)
      );
    }
  }

  private documentChanged(): void {
    if (this.disposed) {
      return;
    }
    this.exitBulkChangeUpdateBlock();
  }

  executeMergeCommand(affectedChanges: readonly number[] | undefined, task: () => void): boolean {
    const allAffectedChanges =
      affectedChanges !== undefined ? this.collectAffectedChanges(affectedChanges) : [];
    this.undoManager.executeCommand(() => {
      if (this.insideCommand) {
        throw new Error('nested merge command');
      }
      // We should restore states after changes in the document to avoid
      // corruption by our beforeDocumentChange().
      // Undo actions are performed in backward order, while redo actions are
      // performed in forward order. Thus we register two UndoableActions.
      this.insideCommand = true;
      this.enterBulkChangeUpdateBlock();
      try {
        this.registerUndoRedo(true, allAffectedChanges);
        try {
          task();
        } finally {
          this.registerUndoRedo(false, allAffectedChanges);
        }
      } finally {
        this.exitBulkChangeUpdateBlock();
        this.insideCommand = false;
      }
    });
    return true;
  }

  private registerUndoRedo(undo: boolean, affectedChanges: readonly number[]): void {
    const states: S[] = [];
    if (affectedChanges.length > 0) {
      for (const index of affectedChanges) {
        states.push(this.storeChangeState(index));
      }
    } else {
      for (let index = 0; index < this.changesCount; index++) {
        states.push(this.storeChangeState(index));
      }
    }
    this.undoManager.undoableActionPerformed(new StateUndoableAction<S>(this, states, undo));
  }

  /** Restores saved change states; called by undo/redo actions. */
  restoreStates(states: readonly S[]): void {
    if (this.disposed) {
      return;
    }
    if (this.changesCount === 0) {
      return;
    }

    this.enterBulkChangeUpdateBlock();
    try {
      for (const state of states) {
        this.restoreChangeState(state);
        this.invalidateChange(state.index);
      }
    } finally {
      this.exitBulkChangeUpdateBlock();
    }
  }

  //
  // Actions
  //

  replaceChange(index: number, newContent: readonly string[]): void {
    if (!this.insideCommand) {
      throw new Error('replaceChange outside a merge command');
    }
    const outputStartLine = this.getLineStart(index);
    const outputEndLine = this.getLineEnd(index);

    applyModification(this.document, outputStartLine, outputEndLine, newContent);

    if (outputStartLine === outputEndLine) {
      // beforeDocumentChange() should process other cases correctly
      const newOutputEndLine = outputStartLine + newContent.length;
      this.moveChangesAfterInsertion(index, outputStartLine, newOutputEndLine);
    }
  }

  appendChange(index: number, newContent: readonly string[]): void {
    if (!this.insideCommand) {
      throw new Error('appendChange outside a merge command');
    }
    const outputStartLine = this.getLineStart(index);
    const outputEndLine = this.getLineEnd(index);

    applyModification(this.document, outputEndLine, outputEndLine, newContent);

    const newOutputEndLine = outputEndLine + newContent.length;
    this.moveChangesAfterInsertion(index, outputStartLine, newOutputEndLine);
  }

  /*
   * We want to include inserted block into change, so we are updating endLine(BASE).
   *
   * It could break order of changes if there are other changes that starts/ends at this line.
   * So we should check all other changes and shift them if necessary.
   */
  private moveChangesAfterInsertion(
    index: number,
    newOutputStartLine: number,
    newOutputEndLine: number
  ): void {
    if (!this.insideCommand) {
      throw new Error('moveChangesAfterInsertion outside a merge command');
    }

    if (
      this.getLineStart(index) !== newOutputStartLine ||
      this.getLineEnd(index) !== newOutputEndLine
    ) {
      this.setLineStart(index, newOutputStartLine);
      this.setLineEnd(index, newOutputEndLine);
      this.invalidateChange(index);
    }

    let beforeChange = true;
    for (let otherIndex = 0; otherIndex < this.changesCount; otherIndex++) {
      const startLine = this.getLineStart(otherIndex);
      const endLine = this.getLineEnd(otherIndex);
      if (endLine < newOutputStartLine) {
        continue;
      }
      if (startLine > newOutputEndLine) {
        break;
      }
      if (index === otherIndex) {
        beforeChange = false;
        continue;
      }

      const newStartLine = beforeChange
        ? Math.min(startLine, newOutputStartLine)
        : newOutputEndLine;
      const newEndLine = beforeChange
        ? Math.min(endLine, newOutputStartLine)
        : Math.max(endLine, newOutputEndLine);
      if (startLine !== newStartLine || endLine !== newEndLine) {
        this.setLineStart(otherIndex, newStartLine);
        this.setLineEnd(otherIndex, newEndLine);
        this.invalidateChange(otherIndex);
      }
    }
  }

  /*
   * Nearby changes could be affected as well (ex: by moveChangesAfterInsertion)
   */
  private collectAffectedChanges(directChanges: readonly number[]): number[] {
    const result: number[] = [];

    let directArrayIndex = 0;
    let otherIndex = 0;
    while (directArrayIndex < directChanges.length && otherIndex < this.changesCount) {
      const directIndex = directChanges[directArrayIndex];

      if (directIndex === otherIndex) {
        result.push(directIndex);
        otherIndex++;
        continue;
      }

      const directStart = this.getLineStart(directIndex);
      const directEnd = this.getLineEnd(directIndex);
      const otherStart = this.getLineStart(otherIndex);
      const otherEnd = this.getLineEnd(otherIndex);

      if (otherEnd < directStart) {
        otherIndex++;
        continue;
      }
      if (otherStart > directEnd) {
        directArrayIndex++;
        continue;
      }

      result.push(otherIndex);
      otherIndex++;
    }

    if (directChanges.length > result.length) {
      throw new Error(
        `affected changes lost: direct ${directChanges.length}, collected ${result.length}`
      );
    }
    return result;
  }
}
