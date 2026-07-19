// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/merge/MergeTestBase.kt
// Copyright 2000-2025 JetBrains s.r.o. Apache 2.0 license.
//
// Headless: drives MergeConflictModel directly instead of a Swing viewer.
// Upstream's ViewerState records change end lines via getStartLine (a
// copy-paste slip); this harness records the real end lines.

import * as assert from 'assert';
import { ComparisonPolicy } from '../../../src/diff-engine/comparison/ComparisonPolicy';
import { MergeConflictTypeKind } from '../../../src/diff-engine/util/MergeConflictType';
import { Side } from '../../../src/diff-engine/util/Side';
import { ThreeSide } from '../../../src/diff-engine/util/ThreeSide';
import {
  ITextMergeRequest,
  MergeConflictModel,
} from '../../../src/conflicts/merge-model/MergeConflictModel';
import {
  IMergeDocument,
  StringMergeDocument,
} from '../../../src/conflicts/merge-model/MergeDocument';
import { MergeUndoManager } from '../../../src/conflicts/merge-model/MergeUndoManager';
import { TextMergeChange } from '../../../src/conflicts/merge-model/TextMergeChange';
import { getLinesContent } from '../../../src/conflicts/merge-model/documentUtil';
import { parseSource } from '../diff-engine/comparisonTestUtil';

export type SidesState = 'LEFT' | 'RIGHT' | 'BOTH' | 'NONE';

export function doTest1(
  left: string,
  base: string,
  right: string,
  f: (t: MergeTestBuilder) => void
): void {
  doTest(left, base, right, 1, ComparisonPolicy.DEFAULT, f);
}

export function doTest2(
  left: string,
  base: string,
  right: string,
  f: (t: MergeTestBuilder) => void
): void {
  doTest(left, base, right, 2, ComparisonPolicy.DEFAULT, f);
}

export function doTestN(
  left: string,
  base: string,
  right: string,
  f: (t: MergeTestBuilder) => void
): void {
  doTest(left, base, right, -1, ComparisonPolicy.DEFAULT, f);
}

export function doTest(
  left: string,
  base: string,
  right: string,
  changesCount: number,
  policy: ComparisonPolicy,
  f: (t: MergeTestBuilder) => void
): void {
  const undoManager = new MergeUndoManager();
  const output = new StringMergeDocument('', undoManager);
  const request: ITextMergeRequest = {
    contents: [
      new StringMergeDocument(parseSource(left)),
      new StringMergeDocument(parseSource(base)),
      new StringMergeDocument(parseSource(right)),
    ],
    outputContent: output,
  };
  const model = new MergeConflictModel(request, undoManager);
  try {
    model.rediff(policy);
    const t = new MergeTestBuilder(model, output, undoManager);
    t.assertChangesCount(changesCount);
    f(t);
  } finally {
    model.dispose();
  }
}

interface IChangeState {
  readonly content: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
  readonly resolved: SidesState;
}

interface IViewerState {
  readonly content: string;
  readonly changes: readonly IChangeState[];
}

export class MergeTestBuilder {
  constructor(
    readonly model: MergeConflictModel,
    readonly document: IMergeDocument,
    readonly undoManager: MergeUndoManager
  ) {}

  get changes(): readonly TextMergeChange[] {
    return this.model.getAllChanges();
  }

  change(num: number): TextMergeChange {
    const changes = this.changes;
    if (changes.length < num) {
      throw new Error(`changes: ${changes.length}, index: ${num}`);
    }
    return changes[num];
  }

  activeChanges(): readonly TextMergeChange[] {
    return this.model.getUnresolvedChanges();
  }

  rediff(policy: ComparisonPolicy): void {
    this.model.rediff(policy);
  }

  //
  // Actions
  //

  runApplyNonConflictsAction(side: ThreeSide): void {
    this.model.applyNonConflictedChanges(side);
  }

  //
  // Modification
  //

  command(affected: TextMergeChange | readonly TextMergeChange[] | undefined, f: () => void): void {
    const list =
      affected === undefined
        ? undefined
        : affected instanceof TextMergeChange
          ? [affected]
          : affected;
    this.model.executeMergeCommand(
      list?.map((c) => c.index),
      () => {
        f();
        return true;
      }
    );
  }

  write(f: () => void): void {
    this.undoManager.executeCommand(f);
  }

  ignore(num: number, side: Side, modifier: boolean = false): void {
    const change = this.change(num);
    this.command(change, () => this.model.ignoreChange(change.index, side, modifier));
  }

  apply(num: number, side: Side, modifier: boolean = false): void {
    const change = this.change(num);
    this.command(change, () => this.model.replaceChange(change.index, side, modifier));
  }

  resolve(num: number): void {
    const change = this.change(num);
    this.command(change, () => {
      assert.ok(
        change.isConflict && this.model.canResolveChangeAutomatically(change.index, ThreeSide.BASE)
      );
      this.model.resolveChangeAutomatically(change.index, ThreeSide.BASE);
    });
  }

  canResolveConflict(num: number): boolean {
    const change = this.change(num);
    return this.model.canResolveChangeAutomatically(change.index, ThreeSide.BASE);
  }

  resetAll(): void {
    this.command(this.changes, () => {
      this.model.resetAllChanges();
    });
  }

  //
  // Text modification
  //

  insertText(offset: number, newContent: string): void {
    this.replaceText(offset, offset, newContent);
  }

  deleteTextRange(startOffset: number, endOffset: number): void {
    this.replaceText(startOffset, endOffset, '');
  }

  replaceText(startOffset: number, endOffset: number, newContent: string): void {
    this.write(() => this.document.replaceString(startOffset, endOffset, parseSource(newContent)));
  }

  replaceContent(oldContent: string, newContent: string): void {
    this.write(() => {
      const range = this.findRange(parseSource(oldContent));
      this.document.replaceString(range[0], range[1], parseSource(newContent));
    });
  }

  deleteContent(oldContent: string): void {
    this.replaceContent(oldContent, '');
  }

  insertTextBefore(oldContent: string, newContent: string): void {
    this.write(() => {
      const offset = this.findRange(parseSource(oldContent))[0];
      this.document.replaceString(offset, offset, parseSource(newContent));
    });
  }

  insertTextAfter(oldContent: string, newContent: string): void {
    this.write(() => {
      const offset = this.findRange(parseSource(oldContent))[1];
      this.document.replaceString(offset, offset, parseSource(newContent));
    });
  }

  private findRange(oldContent: string): [number, number] {
    const text = this.document.getText();
    const index1 = text.indexOf(oldContent);
    assert.ok(index1 >= 0, `content - '\n${oldContent}\n'\ntext - '\n${text}'`);
    const index2 = text.indexOf(oldContent, index1 + 1);
    assert.ok(index2 === -1, `content - '\n${oldContent}\n'\ntext - '\n${text}'`);
    return [index1, index1 + oldContent.length];
  }

  /** Offset of (line, col) in the output document; col may be negative. */
  lineCol(line: number, col: number): number {
    return this.document.getLineOffsets().getLineStart(line) + col;
  }

  //
  // Undo
  //

  assertCantUndo(): void {
    assert.ok(!this.undoManager.isUndoAvailable());
  }

  undo(count: number = 1): void {
    if (count === -1) {
      while (this.undoManager.isUndoAvailable()) {
        this.undoManager.undo();
      }
    } else {
      for (let i = 0; i < count; i++) {
        assert.ok(this.undoManager.isUndoAvailable());
        this.undoManager.undo();
      }
    }
  }

  redo(count: number = 1): void {
    if (count === -1) {
      while (this.undoManager.isRedoAvailable()) {
        this.undoManager.redo();
      }
    } else {
      for (let i = 0; i < count; i++) {
        assert.ok(this.undoManager.isRedoAvailable());
        this.undoManager.redo();
      }
    }
  }

  checkUndo(count: number, f: () => void): void {
    const initialState = this.recordState();
    f();
    const afterState = this.recordState();
    this.undo(count);
    assert.deepStrictEqual(this.recordState(), initialState, 'undo did not restore the state');
    this.redo(count);
    assert.deepStrictEqual(this.recordState(), afterState, 'redo did not restore the state');
  }

  private recordState(): IViewerState {
    return {
      content: this.document.getText(),
      changes: this.changes.map((change) => ({
        content: getLinesContent(this.document, change.resultStartLine, change.resultEndLine),
        starts: ThreeSide.map((side) => change.getStartLine(side)),
        ends: ThreeSide.map((side) => change.getEndLine(side)),
        resolved: change.isResolved()
          ? 'BOTH'
          : change.isResolved(Side.LEFT)
            ? 'LEFT'
            : change.isResolved(Side.RIGHT)
              ? 'RIGHT'
              : 'NONE',
      })),
    };
  }

  //
  // Checks
  //

  assertChangesCount(expected: number): void {
    if (expected === -1) {
      return;
    }
    assert.strictEqual(this.activeChanges().length, expected);
  }

  assertType(num: number, kind: MergeConflictTypeKind, changeType?: SidesState): void {
    const change = this.change(num);
    assert.strictEqual(change.conflictType.type, kind);
    if (changeType !== undefined) {
      assert.notStrictEqual(changeType, 'NONE');
      const isLeftChange = changeType !== 'RIGHT';
      const isRightChange = changeType !== 'LEFT';
      assert.deepStrictEqual(
        [change.conflictType.isChange(Side.LEFT), change.conflictType.isChange(Side.RIGHT)],
        [isLeftChange, isRightChange]
      );
    }
  }

  assertResolved(num: number, type: SidesState): void {
    const change = this.change(num);
    const isLeftResolved = type === 'LEFT' || type === 'BOTH';
    const isRightResolved = type === 'RIGHT' || type === 'BOTH';
    assert.deepStrictEqual(
      [change.isResolved(Side.LEFT), change.isResolved(Side.RIGHT)],
      [isLeftResolved, isRightResolved]
    );
  }

  assertRange(num: number, start: number, end: number): void {
    const change = this.change(num);
    assert.deepStrictEqual([change.resultStartLine, change.resultEndLine], [start, end]);
  }

  assertRange6(
    num: number,
    start1: number,
    end1: number,
    start2: number,
    end2: number,
    start3: number,
    end3: number
  ): void {
    const change = this.change(num);
    assert.deepStrictEqual(
      [
        change.getStartLine(ThreeSide.LEFT),
        change.getEndLine(ThreeSide.LEFT),
        change.getStartLine(ThreeSide.BASE),
        change.getEndLine(ThreeSide.BASE),
        change.getStartLine(ThreeSide.RIGHT),
        change.getEndLine(ThreeSide.RIGHT),
      ],
      [start1, end1, start2, end2, start3, end3]
    );
  }

  assertChangeContent(num: number, expected: string, start?: number, end?: number): void {
    const change = this.change(num);
    const actual = getLinesContent(this.document, change.resultStartLine, change.resultEndLine);
    assert.strictEqual(actual, parseSource(expected));
    if (start !== undefined && end !== undefined) {
      this.assertRange(num, start, end);
    }
  }

  assertContent(expected: string): void {
    assert.strictEqual(this.document.getText(), parseSource(expected));
  }
}
