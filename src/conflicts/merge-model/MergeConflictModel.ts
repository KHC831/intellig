// Ported from intellij-community platform/diff-impl/src/com/intellij/diff/merge/MergeConflictModel.kt
// Copyright 2000-2026 JetBrains s.r.o. and contributors. Apache 2.0 license.
//
// Handles all merge-related state without knowing anything about the UI.
// Call rediff() after construction to initialize. The PSI/import/AI lanes are
// not ported; applyNonConflictedChanges comes from MergeThreesideViewer since
// it is pure model logic.

import { ComparisonPolicy } from '../../diff-engine/comparison/ComparisonPolicy';
import { tryResolveConflict } from '../../diff-engine/comparison/MergeResolveUtil';
import { LineRange } from '../../diff-engine/util/LineRange';
import { MergeConflictResolutionStrategy } from '../../diff-engine/util/MergeConflictResolutionStrategy';
import { MergeConflictTypeKind } from '../../diff-engine/util/MergeConflictType';
import { Side } from '../../diff-engine/util/Side';
import { ThreeSide } from '../../diff-engine/util/ThreeSide';
import { getLines, getLinesContent } from './documentUtil';
import { MergeDiffData, buildMergeDiffData } from './MergeDiffBuilder';
import type { IMergeDocument } from './MergeDocument';
import { MergeModelBase } from './MergeModelBase';
import { MergeUndoManager } from './MergeUndoManager';
import { TextMergeChange, TextMergeChangeState } from './TextMergeChange';

export interface ITextMergeRequest {
  /** Left (yours), base, right (theirs). */
  readonly contents: readonly [IMergeDocument, IMergeDocument, IMergeDocument];
  readonly outputContent: IMergeDocument;
}

export type MergeEvent =
  | { readonly kind: 'changeResolved'; readonly change: TextMergeChange }
  | { readonly kind: 'changeSideResolved'; readonly change: TextMergeChange; readonly side: Side }
  | { readonly kind: 'changeReset'; readonly change: TextMergeChange }
  | { readonly kind: 'changeProcessed'; readonly change: TextMergeChange }
  | { readonly kind: 'bulkProcessingFinished' };

export type MergeModelEventListener = (event: MergeEvent) => void;

/** Splits resolved-conflict content into lines, like IntelliJ's LineTokenizer. */
function tokenizeLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

class MergeModelImpl extends MergeModelBase<TextMergeChangeState> {
  constructor(
    document: IMergeDocument,
    undoManager: MergeUndoManager,
    private readonly owner: MergeConflictModel
  ) {
    super(document, undoManager);
  }

  protected override onChangeUpdated(index: number): void {
    this.owner.fireChangeProcessed(this.owner.changeByIndex(index));
  }

  protected override onBulkUpdateFinished(): void {
    this.owner.fireBulkProcessingFinished();
  }

  protected override storeChangeState(index: number): TextMergeChangeState {
    return this.owner.changeByIndex(index).storeState();
  }

  protected override restoreChangeState(state: TextMergeChangeState): void {
    super.restoreChangeState(state);
    const change = this.owner.changeByIndex(state.index);

    const wasResolved = change.isResolved();

    change.restoreState(state);
    if (wasResolved !== change.isResolved()) {
      this.owner.fireChangeResolved(change);
    }
  }

  protected override processDocumentChange(
    index: number,
    oldLine1: number,
    oldLine2: number,
    shift: number
  ): TextMergeChangeState | undefined {
    const state = super.processDocumentChange(index, oldLine1, oldLine2, shift);

    const change = this.owner.changeByIndex(index);
    if (
      change.resultStartLine === change.resultEndLine &&
      change.conflictType.type === MergeConflictTypeKind.DELETED &&
      !change.isResolved()
    ) {
      this.owner.markChangeResolved(change.index);
    }

    return state;
  }
}

export class MergeConflictModel {
  private mergeChanges: TextMergeChange[] = [];

  private readonly resultModel: MergeModelImpl;

  private readonly listeners: MergeModelEventListener[] = [];

  private precalculated: MergeDiffData | undefined;

  contentModified = false;
  private reviewed = false;

  /**
   * Tracks how this file's conflicts were resolved (accepted left, accepted
   * right, or merged manually = undefined), for the finalizing VCS action.
   */
  chosenSide: Side | undefined;

  constructor(
    private readonly request: ITextMergeRequest,
    undoManager: MergeUndoManager
  ) {
    this.resultModel = new MergeModelImpl(request.outputContent, undoManager, this);
  }

  get wasReviewed(): boolean {
    return this.reviewed;
  }

  get precalculatedData(): MergeDiffData | undefined {
    return this.precalculated;
  }

  rediff(policy: ComparisonPolicy): MergeDiffData {
    const cached = this.precalculated;
    if (cached !== undefined && cached.policy === policy) {
      return cached;
    }

    this.precalculated = undefined;
    const data = buildMergeDiffData(this.request.contents, policy);
    this.request.outputContent.setTextNonUndoable(
      ThreeSide.BASE.selectFrom(this.request.contents).getText()
    );
    this.contentModified = false;
    this.precalculated = data;
    this.initWithData(data);
    return data;
  }

  private initWithData(data: MergeDiffData): void {
    const lineRanges = data.fragments.map(
      (fragment) =>
        new LineRange(fragment.getStartLine(ThreeSide.BASE), fragment.getEndLine(ThreeSide.BASE))
    );
    this.resultModel.setChanges(lineRanges);

    this.mergeChanges = data.fragments.map(
      (fragment, index) =>
        new TextMergeChange(index, fragment, data.conflictTypes[index], this.resultModel)
    );
  }

  addListener(listener: MergeModelEventListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: MergeModelEventListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  getAllChanges(): TextMergeChange[] {
    return [...this.mergeChanges];
  }

  getUnresolvedChanges(): TextMergeChange[] {
    return this.mergeChanges.filter((change) => !change.isResolved());
  }

  getResolvedChanges(): TextMergeChange[] {
    return this.mergeChanges.filter((change) => change.isResolved());
  }

  getAutoResolvableChanges(): TextMergeChange[] {
    return this.mergeChanges.filter((change) =>
      this.canResolveChangeAutomatically(change.index, ThreeSide.BASE)
    );
  }

  hasNonConflictedChanges(side: ThreeSide): boolean {
    return this.mergeChanges.some(
      (change) => !change.isConflict && this.canResolveChangeAutomatically(change.index, side)
    );
  }

  hasAutoResolvableConflictedChanges(): boolean {
    return this.mergeChanges.some((change) =>
      this.canResolveChangeAutomatically(change.index, ThreeSide.BASE)
    );
  }

  ignoreChange(index: number, side: Side, resolveChange: boolean): void {
    const change = this.changeByIndex(index);
    if (!change.isConflict || resolveChange) {
      this.markChangeResolved(change.index);
    } else {
      this.markChangeSideResolved(change, side);
    }
  }

  resolveAllChangesAutomatically(): void {
    const autoResolvableChanges = this.getAutoResolvableChanges();
    if (autoResolvableChanges.length === 0) {
      return;
    }
    const affected = autoResolvableChanges.map((change) => change.index);
    const success = this.executeMergeCommand(affected, () => {
      let applied = 0;
      for (const change of autoResolvableChanges) {
        if (this.resolveChangeAutomatically(change.index, ThreeSide.BASE) !== undefined) {
          applied++;
        }
      }
      return applied > 0;
    });
    if (success) {
      this.reviewed = false;
    }
  }

  acceptRevisionForSide(side: Side): void {
    const affected = this.mergeChanges.map((change) => change.index);

    this.executeMergeCommand(affected, () => {
      this.resetAllChanges();
      this.replaceAllChanges(side);
      this.markReviewed();
      return true;
    });
  }

  markReviewed(): void {
    this.reviewed = true;
  }

  resolveChangeAutomatically(index: number, side: ThreeSide): LineRange | undefined {
    const change = this.changeByIndex(index);

    if (!this.canResolveChangeAutomatically(change.index, side)) {
      return undefined;
    }

    if (change.isConflict) {
      // Only the TEXT strategy is ported; SEMANTIC needs the PSI resolver.
      if (change.conflictType.resolutionStrategy === MergeConflictResolutionStrategy.TEXT) {
        const newContent = this.textAutoResolve(change);
        if (newContent === undefined) {
          return undefined;
        }
        return this.replaceWithNewContent(change.index, newContent);
      }
      return undefined;
    }

    const masterSide = side.select(
      Side.LEFT,
      change.isChange(Side.LEFT) ? Side.LEFT : Side.RIGHT,
      Side.RIGHT
    );
    return this.replaceChange(change.index, masterSide, false);
  }

  /**
   * Resets a change back to its base content and marks it unresolved.
   * With force, resets regardless of the current resolved state.
   */
  resetResolvedChange(index: number, force: boolean = false): void {
    const change = this.changeByIndex(index);
    if (!force && !change.isResolved()) {
      return;
    }
    const changeFragment = change.fragment;
    const startLine = changeFragment.getStartLine(ThreeSide.BASE);
    const endLine = changeFragment.getEndLine(ThreeSide.BASE);

    const baseDocument = ThreeSide.BASE.selectFrom(this.request.contents);
    const baseContent = getLines(baseDocument, startLine, endLine);

    this.resultModel.replaceChange(change.index, baseContent);
    this.fireChangeReset(change);
    change.resetState();
    this.resultModel.invalidateChange(change.index);
  }

  private replaceWithNewContent(index: number, newContent: string): LineRange {
    const change = this.changeByIndex(index);
    const newContentLines = tokenizeLines(newContent);
    this.resultModel.replaceChange(change.index, newContentLines);
    this.markChangeResolved(change.index);
    return new LineRange(
      this.resultModel.getLineStart(change.index),
      this.resultModel.getLineEnd(change.index)
    );
  }

  replaceChange(index: number, side: Side, resolveChange: boolean): LineRange | undefined {
    const change = this.changeByIndex(index);
    if (change.isResolved(side)) {
      return undefined;
    }
    if (!change.isChange(side)) {
      this.markChangeResolved(change.index);
      return undefined;
    }

    const sourceSide = side.select(ThreeSide.LEFT, ThreeSide.RIGHT);
    const oppositeSide = side.select(ThreeSide.RIGHT, ThreeSide.LEFT);

    const sourceDocument = sourceSide.selectFrom(this.request.contents);
    const sourceStartLine = change.getStartLine(sourceSide);
    const sourceEndLine = change.getEndLine(sourceSide);
    const newContent = getLines(sourceDocument, sourceStartLine, sourceEndLine);

    let newLineStart: number;
    if (change.isConflict) {
      const append = change.isOnesideAppliedConflict;
      if (append) {
        newLineStart = this.resultModel.getLineEnd(change.index);
        this.resultModel.appendChange(change.index, newContent);
      } else {
        this.resultModel.replaceChange(change.index, newContent);
        newLineStart = this.resultModel.getLineStart(change.index);
      }

      if (resolveChange || change.getStartLine(oppositeSide) === change.getEndLine(oppositeSide)) {
        this.markChangeResolved(change.index);
      } else {
        change.markOnesideAppliedConflict();
        this.markChangeSideResolved(change, side);
      }
    } else {
      this.resultModel.replaceChange(change.index, newContent);
      newLineStart = this.resultModel.getLineStart(change.index);
      this.markChangeResolved(change.index);
    }
    const newLineEnd = this.resultModel.getLineEnd(change.index);
    return new LineRange(newLineStart, newLineEnd);
  }

  resetAllChanges(): void {
    for (const change of this.getAllChanges()) {
      this.resetResolvedChange(change.index, true);
    }
    this.resetOutputContent();
  }

  private replaceAllChanges(side: Side): void {
    for (const change of this.getAllChanges()) {
      this.replaceChange(change.index, side, true);
    }
    this.chosenSide = side;
  }

  markAllChangesResolved(): void {
    for (const change of this.getAllChanges()) {
      this.markChangeResolved(change.index);
    }
  }

  private markChangeSideResolved(change: TextMergeChange, side: Side): void {
    if (change.isResolved()) {
      return;
    }
    change.setResolved(side, true);
    this.fireChangeSideResolved(change, side);
    if (change.isResolved()) {
      this.fireChangeResolved(change);
    }
    this.resultModel.invalidateChange(change.index);
  }

  markChangeResolved(changeIndex: number): void {
    const change = this.changeByIndex(changeIndex);
    if (change.isResolved()) {
      return;
    }
    change.setResolved(Side.LEFT, true);
    change.setResolved(Side.RIGHT, true);
    this.fireChangeResolved(change);
    this.resultModel.invalidateChange(change.index);
  }

  canResolveChangeAutomatically(changeIndex: number, side: ThreeSide): boolean {
    const change = this.changeByIndex(changeIndex);

    if (change.isConflict) {
      return (
        side === ThreeSide.BASE &&
        change.conflictType.canBeResolved() &&
        !change.isResolved(Side.LEFT) &&
        !change.isResolved(Side.RIGHT) &&
        (change.conflictType.resolutionStrategy !== MergeConflictResolutionStrategy.TEXT ||
          !this.isChangeRangeModified(change))
      );
    }
    return !change.isResolved() && change.isChange(side) && !this.isChangeRangeModified(change);
  }

  /** Applies every non-conflicting change from the given side, as one undo step. */
  applyNonConflictedChanges(side: ThreeSide): void {
    this.executeMergeCommand(undefined, () => {
      let applied = 0;
      for (const change of this.getAllChanges()) {
        if (
          !change.isConflict &&
          this.resolveChangeAutomatically(change.index, side) !== undefined
        ) {
          applied++;
        }
      }
      return applied > 0;
    });
  }

  private resetOutputContent(): void {
    this.request.outputContent.setText(ThreeSide.BASE.selectFrom(this.request.contents).getText());
  }

  private isChangeRangeModified(change: TextMergeChange): boolean {
    const changeFragment = change.fragment;
    const baseStartLine = changeFragment.getStartLine(ThreeSide.BASE);
    const baseEndLine = changeFragment.getEndLine(ThreeSide.BASE);
    const baseDocument = ThreeSide.BASE.selectFrom(this.request.contents);

    const baseContent = getLinesContent(baseDocument, baseStartLine, baseEndLine);
    const resultContent = getLinesContent(
      this.request.outputContent,
      change.resultStartLine,
      change.resultEndLine
    );
    return baseContent !== resultContent;
  }

  dispose(): void {
    this.resultModel.dispose();
  }

  /**
   * `task` returns whether it actually changed the result. Only then does the
   * content count as modified — a command that applied nothing leaves no work
   * to restore, so it must not raise the restore prompt on the next open.
   */
  executeMergeCommand(
    affectedIndexes: readonly number[] | undefined,
    task: () => boolean
  ): boolean {
    const applied = this.resultModel.executeMergeCommand(affectedIndexes, task);
    if (applied) {
      this.contentModified = true;
    }
    return applied;
  }

  changeByIndex(index: number): TextMergeChange {
    return this.mergeChanges[index];
  }

  private textAutoResolve(change: TextMergeChange): string | undefined {
    if (change.conflictType.resolutionStrategy !== MergeConflictResolutionStrategy.TEXT) {
      throw new Error('text auto-resolve needs the TEXT resolution strategy');
    }

    const texts = ThreeSide.map((side) => {
      const document =
        side === ThreeSide.BASE
          ? this.request.outputContent
          : side.selectFrom(this.request.contents);
      return getLinesContent(document, change.getStartLine(side), change.getEndLine(side));
    });

    return tryResolveConflict(texts[0], texts[1], texts[2]);
  }

  //
  // Events
  //

  private fireEvent(event: MergeEvent): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  fireChangeSideResolved(change: TextMergeChange, side: Side): void {
    this.fireEvent({ kind: 'changeSideResolved', change, side });
  }

  fireChangeResolved(change: TextMergeChange): void {
    this.fireEvent({ kind: 'changeResolved', change });
  }

  fireChangeProcessed(change: TextMergeChange): void {
    this.fireEvent({ kind: 'changeProcessed', change });
  }

  fireBulkProcessingFinished(): void {
    this.fireEvent({ kind: 'bulkProcessingFinished' });
  }

  fireChangeReset(change: TextMergeChange): void {
    this.fireEvent({ kind: 'changeReset', change });
  }
}
