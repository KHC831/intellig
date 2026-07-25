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
  PANE_FOCUSED_CLASS,
  wireSingleSelection,
} from '../../../src/conflicts/merge-window/singleSelection';

interface IFakePane extends ISelectionPane {
  /** Drive a selection change the way Monaco would. */
  select(empty: boolean): void;
  /** Drive focus the way clicking into a pane would. */
  focus(focused: boolean): void;
  collapsedTo: { lineNumber: number; column: number } | undefined;
  hasSelection: boolean;
  classes: Set<string>;
}

function fakePane(caret = { lineNumber: 7, column: 3 }): IFakePane {
  let listener: ((e: { selection: { isEmpty(): boolean } }) => void) | undefined;
  let onFocus: (() => void) | undefined;
  let onBlur: (() => void) | undefined;
  const pane: IFakePane = {
    hasSelection: false,
    collapsedTo: undefined,
    classes: new Set<string>(),
    onDidChangeCursorSelection(l) {
      listener = l;
    },
    onDidFocusEditorText(l) {
      onFocus = l;
    },
    onDidBlurEditorText(l) {
      onBlur = l;
    },
    getDomNode() {
      return {
        classList: {
          add: (c: string): void => void pane.classes.add(c),
          remove: (c: string): void => void pane.classes.delete(c),
        },
      };
    },
    focus(focused: boolean) {
      (focused ? onFocus : onBlur)?.();
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

  it('marks the focused pane so the stylesheet can colour its selection', () => {
    // Monaco's own focused-selection CSS cannot match (its focus class lands on
    // the .monaco-editor element while the rule expects a descendant), so every
    // selection painted the inactive grey. The class is applied here instead,
    // driven by Monaco's focus EVENTS rather than its class name.
    const left = fakePane();
    const right = fakePane();
    wireSingleSelection([left, right]);

    left.focus(true);
    assert.ok(left.classes.has(PANE_FOCUSED_CLASS), 'the focused pane must be marked');
    assert.ok(!right.classes.has(PANE_FOCUSED_CLASS), 'an unfocused pane must not be marked');

    left.focus(false);
    assert.ok(
      !left.classes.has(PANE_FOCUSED_CLASS),
      'blur must unmark the pane so it falls back to the inactive colour'
    );
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
