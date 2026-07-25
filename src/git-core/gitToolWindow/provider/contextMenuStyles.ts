/**
 * The context-menu stylesheet shared by the commit, changed-file and revision
 * menus in the Git tool window.
 *
 * Split out of the base stylesheet because it is the one menu surface the
 * computed-style lane renders in a real engine, so keeping it addressable on
 * its own lets the coverage manifest name what is actually covered.
 */
export function contextMenuStyles(): string {
  return `
      /* Context Menu Styles */
      .context-menu {
        position: fixed;
        background-color: var(--vscode-menu-background);
        border: 1px solid var(--vscode-menu-border);
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        min-width: 180px;
        z-index: 1000;
        padding: 4px 0;
      }

      .context-menu-item {
        display: flex;
        align-items: center;
        padding: 6px 12px;
        cursor: pointer;
        color: var(--vscode-menu-foreground);
        font-size: 13px;
      }

      .context-menu-item:hover {
        background-color: var(--vscode-menu-selectionBackground);
        color: var(--vscode-menu-selectionForeground);
      }

      /* The generic hover sets a matched background/foreground pair; swapping
         only the background leaves the selection foreground over the error
         tint, which is white-on-pale-pink in light themes. Set both. */
      .context-menu-item.context-menu-danger:hover {
        background-color: var(--vscode-inputValidation-errorBackground);
        color: var(--vscode-foreground);
      }

      .context-menu-item.disabled {
        opacity: 0.4;
        cursor: default;
        pointer-events: none;
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
