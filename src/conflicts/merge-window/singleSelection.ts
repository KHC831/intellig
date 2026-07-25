/**
 * One visible selection across the merge window's three panes.
 *
 * Each Monaco editor owns its own selection, so selecting in a second pane left
 * the first pane's highlight painted as well and the window showed two live
 * selections at once. When a pane takes a real (non-empty) selection, the others
 * collapse theirs to their own caret.
 *
 * Structural interface rather than the Monaco types: this keeps the rule
 * testable without a DOM or the AMD monaco global, and a real
 * `monaco.editor.ICodeEditor` satisfies it as-is.
 */

/** The slice of a Monaco editor these rules need. */
export interface ISelectionPane {
  onDidChangeCursorSelection(listener: (e: { selection: { isEmpty(): boolean } }) => void): void;
  getSelection(): { isEmpty(): boolean } | null;
  getPosition(): { lineNumber: number; column: number } | null;
  /** Collapses any selection to `position` — Monaco's setPosition clears it. */
  setPosition(position: { lineNumber: number; column: number }): void;
  onDidFocusEditorText(listener: () => void): void;
  onDidBlurEditorText(listener: () => void): void;
  /** The `.monaco-editor` element, which carries {@link PANE_FOCUSED_CLASS}. */
  getDomNode(): { classList: { add(c: string): void; remove(c: string): void } } | null;
}

/**
 * Marks the pane whose text has focus, so the stylesheet can give it the active
 * selection colour.
 *
 * Monaco already tracks focus, but the CSS it ships to use it —
 * ".monaco-editor .focused .selected-text" — is a DESCENDANT selector while the
 * class lands on the .monaco-editor element itself, so it never matches and
 * every selection falls through to the inactive grey. Rather than depend on
 * that class at all, the active pane is marked here.
 */
export const PANE_FOCUSED_CLASS = 'intellig-pane-focused';

/** Give the focused pane {@link PANE_FOCUSED_CLASS} and take it back on blur. */
export function wireFocusedPaneClass(panes: readonly ISelectionPane[]): void {
  for (const pane of panes) {
    pane.onDidFocusEditorText(() => pane.getDomNode()?.classList.add(PANE_FOCUSED_CLASS));
    pane.onDidBlurEditorText(() => pane.getDomNode()?.classList.remove(PANE_FOCUSED_CLASS));
  }
}

/**
 * Keep at most one pane's selection visible.
 *
 * Collapsing never steals focus, and cannot cascade: an empty selection is
 * ignored, and collapsing is all this produces.
 */
export function wireSingleSelection(panes: readonly ISelectionPane[]): void {
  wireFocusedPaneClass(panes);
  for (const owner of panes) {
    owner.onDidChangeCursorSelection((e) => {
      if (e.selection.isEmpty()) {
        return;
      }
      for (const other of panes) {
        if (other === owner) {
          continue;
        }
        const selection = other.getSelection();
        const position = other.getPosition();
        if (selection && !selection.isEmpty() && position) {
          other.setPosition(position);
        }
      }
    });
  }
}
