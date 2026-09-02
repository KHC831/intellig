/**
 * The context-menu stylesheet, shared by every webview that draws one.
 *
 * Each webview is its own document with its own inline styles, so the rules
 * travel as a string rather than a file. Both documents include this block, so
 * a menu looks the same wherever it opens.
 *
 * The computed-style lane renders these rules in a real engine; keeping them
 * addressable on their own lets the coverage manifest name what is covered.
 */
export function contextMenuStyles(): string {
  return `
      /* Context Menu Styles */
      .context-menu {
        position: fixed;
        background-color: var(--vscode-menu-background, var(--vscode-editorWidget-background));
        border: 1px solid var(--vscode-menu-border, var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.35)));
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        min-width: 180px;
        z-index: 1000;
        padding: 4px 0;
      }

      .context-menu-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 6px 12px;
        cursor: pointer;
        color: var(--vscode-menu-foreground, var(--vscode-editorWidget-foreground));
        font-size: 13px;
        white-space: nowrap;
      }

      .context-menu-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .context-menu-shortcut {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
      }

      .context-menu-item:hover {
        background-color: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
        color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
      }

      /* showAt() focuses the first row on open and handleKey() moves focus
         with Arrow/Home/End — without this, keyboard movement through the
         menu is invisible. */
      .context-menu-item:focus {
        outline: 1px solid var(--vscode-focusBorder);
      }

      /* The generic hover sets a matched background/foreground pair; swapping
         only the background leaves the selection foreground over the error
         tint, which is white-on-pale-pink in light themes. Set both. */
      .context-menu-item.context-menu-danger:hover {
        background-color: var(--vscode-inputValidation-errorBackground);
        color: var(--vscode-foreground);
      }

      /* A greyed row fires nothing, but it still takes the click, so the menu
         can close on it the way it closes on a click outside. NO
         pointer-events: none here — that would retarget the click to the menu
         box, which the click-away handler reads as a click INSIDE the menu,
         and the menu would swallow it and stay open. */
      .context-menu-item.disabled {
        opacity: 0.4;
        cursor: default;
      }

      /* Visibility flag for multi-select menu items. Keeps single-only
         items hidden when N>=2 and multi-only items hidden when their N
         constraint isn't met. display: none takes the row out of the flow
         so the menu collapses naturally. */
      .context-menu-item.menu-multi-hidden {
        display: none;
      }

      .context-menu-separator {
        height: 1px;
        background-color: var(--vscode-menu-separatorBackground);
        margin: 4px 0;
      }
`;
}
