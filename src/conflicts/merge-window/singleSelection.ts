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

/** The slice of a Monaco editor this rule needs. */
export interface ISelectionPane {
  onDidChangeCursorSelection(listener: (e: { selection: { isEmpty(): boolean } }) => void): void;
  getSelection(): { isEmpty(): boolean } | null;
  getPosition(): { lineNumber: number; column: number } | null;
  /** Collapses any selection to `position` — Monaco's setPosition clears it. */
  setPosition(position: { lineNumber: number; column: number }): void;
}

/**
 * Keep at most one pane's selection visible.
 *
 * Collapsing never steals focus, and cannot cascade: an empty selection is
 * ignored, and collapsing is all this produces.
 */
export function wireSingleSelection(panes: readonly ISelectionPane[]): void {
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
