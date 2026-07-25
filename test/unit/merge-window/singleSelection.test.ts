/**
 * One visible selection across the merge window's three panes.
 *
 * Each Monaco editor owns its own selection, so selecting in a second pane left
 * the first pane's highlight painted too and the window showed two live
 * selections at once (user-reported). Selecting in a pane must collapse the
 * others.
 */

import '../../setup';
import * as assert from 'assert';
import {
  ISelectionPane,
  wireSingleSelection,
} from '../../../src/conflicts/merge-window/singleSelection';

interface IFakePane extends ISelectionPane {
  /** Drive a selection change the way Monaco would. */
  select(empty: boolean): void;
  collapsedTo: { lineNumber: number; column: number } | undefined;
  hasSelection: boolean;
}

function fakePane(caret = { lineNumber: 7, column: 3 }): IFakePane {
  let listener: ((e: { selection: { isEmpty(): boolean } }) => void) | undefined;
  const pane: IFakePane = {
    hasSelection: false,
    collapsedTo: undefined,
    onDidChangeCursorSelection(l) {
      listener = l;
    },
    getSelection() {
      return { isEmpty: () => !pane.hasSelection };
    },
    getPosition() {
      return caret;
    },
    setPosition(position) {
      pane.collapsedTo = position;
      pane.hasSelection = false;
    },
    select(empty: boolean) {
      pane.hasSelection = !empty;
      listener?.({ selection: { isEmpty: () => empty } });
    },
  };
  return pane;
}

describe('merge window: one visible selection across panes', () => {
  it('collapses the other panes when a pane takes a selection', () => {
    const left = fakePane({ lineNumber: 2, column: 5 });
    const result = fakePane();
    const right = fakePane();
    wireSingleSelection([left, result, right]);

    left.select(false);
    assert.strictEqual(left.hasSelection, true, 'the selecting pane keeps its selection');

    right.select(false);
    assert.strictEqual(right.hasSelection, true, 'the newly selecting pane keeps its selection');
    assert.strictEqual(left.hasSelection, false, "the earlier pane's highlight must be cleared");
    assert.deepStrictEqual(
      left.collapsedTo,
      { lineNumber: 2, column: 5 },
      'the cleared pane collapses to its own caret, not to the other pane position'
    );
  });

  it('ignores an empty selection so a mere caret move clears nothing', () => {
    const left = fakePane();
    const right = fakePane();
    wireSingleSelection([left, right]);

    left.select(false);
    right.select(true); // caret move, no selection
    assert.strictEqual(left.hasSelection, true, 'a caret move must not clear a real selection');
    assert.strictEqual(left.collapsedTo, undefined);
  });

  it('does not touch a pane that has nothing selected', () => {
    const left = fakePane();
    const right = fakePane();
    wireSingleSelection([left, right]);

    left.select(false);
    assert.strictEqual(
      right.collapsedTo,
      undefined,
      'an already-empty pane must not be repositioned (that would move its caret)'
    );
  });
});
