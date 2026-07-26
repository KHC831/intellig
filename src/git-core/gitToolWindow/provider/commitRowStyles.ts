/**
 * The log's commit-row family: the row block (rest, hover, focus, selected,
 * expanded, cherry-picked) and the cells inside it — graph slot, info,
 * header, title, branch chips, author, date. Split out of stylesBuilder.ts;
 * buildInlineStyles interpolates this at the block's original position, so
 * the emitted sheet and its cascade order are unchanged.
 */

export function commitRowStyles(): string {
  return `      /* Commit Row Styles */
      .commit-row {
        display: flex;
        align-items: center;
        height: 24px;
        padding: 0;
        cursor: pointer;
        border-bottom: none;
        transition: background-color 0.1s ease;
        /* List rows, not selectable text: shift-click range selection must
           not drag-highlight row text. Hash copying = Ctrl+C command. */
        user-select: none;
      }

      .commit-row:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .commit-row:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .commit-row.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .commit-row.expanded {
        background-color: var(--vscode-list-inactiveSelectionBackground);
      }

      /* Already-cherry-picked rows are dimmed with a ✓ badge. */
      .commit-row-cherry-picked {
        opacity: 0.6;
      }
      .commit-row-cherry-picked:hover {
        opacity: 0.85;
      }
      .commit-row-cherry-picked.selected {
        opacity: 1;
      }
      .commit-cherry-badge {
        display: inline-block;
        margin-left: 4px;
        font-size: 11px;
        color: var(--vscode-gitDecoration-addedResourceForeground, #629755);
        font-weight: bold;
        vertical-align: middle;
      }

      /* Graph Styles */
      .commit-graph {
        flex-shrink: 0;
        width: var(--graph-width, 80px);
        height: 24px;
        overflow: hidden;
        display: flex;
        align-items: center;
      }

      .commit-graph svg {
        display: block;
      }

      .commit-graph:empty,
      .commit-graph[data-width="0"] {
        display: none;
      }

      /* Commit Info Styles */
      .commit-info {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        display: flex;
        flex-direction: row;
        align-items: center;
        padding: 0 8px;
      }

      .commit-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 0;
      }

      .commit-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: var(--vscode-font-size);
        line-height: 24px;
        flex: 1;
        min-width: 0;
        text-align: left;
      }

      /* Branch chips live in a flex slot between the message and the fixed
         Author/Date columns. The slot MUST yield to those columns: with
         flex-shrink: 0 a commit carrying several refs (or one long ref) grew
         the slot unbounded, crushed .commit-title to zero AND pushed the
         author/date columns past the right edge, where .commit-info's
         overflow:hidden clipped them — the refs appeared to "cover" the title,
         author and date. So the slot shrinks (flex-shrink: 1, min-width: 0) and
         is capped at a fraction of the row (max-width), clipping its own
         overflow; the message keeps ~40% and the author/date columns are always
         visible — matching IntelliJ, where refs sit inside the Subject column
         and never bleed into the Author/Date columns. The :empty rule keeps the
         slot from occupying the 8px right margin when a commit has no branches. */
      .commit-branches {
        display: flex;
        flex-shrink: 1;
        min-width: 0;
        max-width: 60%;
        overflow: hidden;
        align-items: center;
        gap: 4px;
        margin-right: 8px;
      }

      .commit-branches:empty {
        display: none;
      }

      /* Author column: fixed-width, LEFT-aligned — consistent with every other
         column (title, date) and IntelliJ's log table. A 12px left padding
         gives the same gutter the date column uses, so columns line up at a
         stable x across rows. Long names ellipsise at the right
         (overflow/text-overflow/nowrap). */
      .commit-author {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        /* Width is driven by the panel-level --col-author-width custom
           property (default 120px) so the column tracks the user's drag and
           stays aligned with the header divider. */
        width: var(--col-author-width, 120px);
        flex-shrink: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        text-align: left;
        padding-left: 12px;
        padding-right: 0;
      }

      .commit-date {
        /* Width is driven by the panel-level --col-date-width custom property
           (default 145px); see .commit-author. */
        width: var(--col-date-width, 145px);
        flex-shrink: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        text-align: left;
        padding-left: 12px;
        white-space: nowrap;
      }

      /* On a selected row every cell takes the selection foreground — the
         IntelliJ log derives it from a shared cell state no column can opt
         out of (vcs-log GraphCommitCellRenderer.getSelectionForeground,
         VcsLogGraphTable BaseStyleProvider.getBaseStyle). The dim secondary
         tone belongs to resting rows only. */
      .commit-row.selected .commit-author,
      .commit-row.selected .commit-date {
        color: var(--vscode-list-activeSelectionForeground);
      }`;
}
