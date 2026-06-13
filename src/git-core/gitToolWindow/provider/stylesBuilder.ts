import * as vscode from 'vscode';

/**
 * Builds the inline CSS injected into every Git tool window webview document.
 *
 * Returns the shared base stylesheet as a template string: the IntelliJ-parity
 * `--intellij-*` color variables, the `var(--vscode-..., #hex)` token
 * fallbacks for fg/bg colors, and the rules for commit rows, the graph panel,
 * the details panel, chips, and context menus. The string is fully static —
 * it interpolates no host state and is assembled independently of the provider
 * instance — so it is built here and injected verbatim into the rendered HTML.
 *
 * L8 invariant — the webview HTML this output is embedded into MUST contain
 * exactly ONE `acquireVsCodeApi(` call across the full document. Any inline
 * `onclick=`/`onchange=` attribute that re-acquires throws a DOMException and
 * silently drops every subsequent `postMessage`. New CSS / handler wiring goes
 * through the single IIFE-scoped `vscode = acquireVsCodeApi()` call. See
 * `docs/design/git-tool-window-spec.md` §8.L8.
 */
export function buildInlineStyles(): string {
  return `
      :root {
        --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif);
        --vscode-font-size: var(--vscode-editor-font-size, 13px);
        /* IntelliJ-style file status colors */
        --intellij-modified: #6897BB;
        --intellij-added: #629755;
        --intellij-deleted: #6C6C6C;
        --intellij-untracked: #CC7832;
        --intellij-ignored: #848504;
        --intellij-conflicted: #FF0000;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 0;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background-color: var(--vscode-sideBar-background);
      }

      /* Visually-hidden utility for assistive-tech-only text. Removes the
         element from sighted layout while keeping it in the DOM for screen
         readers, find-in-page, and a11y inspectors. The double-clip pattern
         (clip + clip-path) is the WAI-ARIA-recommended shape: older browsers
         fall back to "clip", modern browsers honour "clip-path". */
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }

      .git-tool-window {
        display: flex;
        flex-direction: column;
        height: 100vh;
      }

      /* No Repository Message */
      .no-repository {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        text-align: center;
        color: var(--vscode-descriptionForeground);
      }

      .init-repo-button {
        margin-top: 16px;
        padding: 8px 16px;
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        border-radius: 2px;
        cursor: pointer;
      }

      .init-repo-button:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .init-repo-button:focus {
        outline: 1px solid var(--vscode-focusBorder);
      }

      /* Local Changes Toolbar */
      .local-changes-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-sideBar-background);
      }

      .toolbar-button {
        padding: 4px 8px;
        background: transparent;
        color: var(--vscode-foreground);
        border: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 14px;
      }

      .toolbar-button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      /* Local Changes Content */
      .local-changes-content {
        flex: 1;
        overflow: auto;
        padding: 4px;
      }

      /* Changelist Styles */
      .changelist {
        margin-bottom: 4px;
        border-radius: 3px;
        transition: background-color 0.2s ease;
      }

      .changelist.drag-over {
        background-color: var(--vscode-list-dropBackground);
        outline: 2px dashed var(--vscode-focusBorder);
      }

      .changelist-header {
        display: flex;
        align-items: center;
        padding: 6px 8px;
        cursor: pointer;
        border-radius: 3px;
        user-select: none;
      }

      .changelist-header:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .changelist-header:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .expand-icon {
        width: 16px;
        font-size: 10px;
        color: var(--vscode-foreground);
        flex-shrink: 0;
      }

      .changelist-name {
        flex: 1;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-count {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        margin-left: 8px;
      }

      .default-badge {
        font-size: 10px;
        padding: 1px 4px;
        margin-left: 8px;
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        border-radius: 3px;
      }

      .changelist-files {
        margin-left: 8px;
        padding-left: 8px;
        border-left: 1px solid var(--vscode-panel-border);
      }

      /* File Item Styles - IntelliJ-style */
      .file-item {
        display: flex;
        align-items: center;
        padding: 3px 8px;
        cursor: pointer;
        border-radius: 3px;
        user-select: none;
        transition: background-color 0.1s ease;
      }

      .file-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .file-item:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .file-item.selected {
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .file-item.dragging {
        opacity: 0.5;
      }

      .file-status {
        width: 16px;
        height: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: bold;
        margin-right: 6px;
        flex-shrink: 0;
      }

      .file-path {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
      }

      .file-dir {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-left: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 150px;
      }

      .staged-indicator {
        color: var(--intellij-added);
        margin-left: 4px;
        font-size: 10px;
      }

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

      .context-menu-item.context-menu-danger:hover {
        background-color: var(--vscode-inputValidation-errorBackground);
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

      .context-menu-arrow {
        margin-left: auto;
        font-size: 10px;
        color: var(--vscode-descriptionForeground);
      }

      .context-menu-separator {
        height: 1px;
        background-color: var(--vscode-menu-separatorBackground);
        margin: 4px 0;
      }

      .context-menu-submenu {
        position: relative;
      }

      /* Console Styles */
      .console-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .clear-console-button {
        padding: 4px 8px;
        background: transparent;
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        cursor: pointer;
        font-size: 12px;
      }

      .clear-console-button:hover {
        background-color: var(--vscode-toolbar-hoverBackground);
      }

      .console-content {
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        padding: 8px;
      }

      .console-entry {
        padding: 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .console-entry.error {
        background-color: var(--vscode-inputValidation-errorBackground);
      }

      .console-timestamp {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-bottom: 4px;
      }

      .console-command {
        color: var(--vscode-terminal-ansiCyan);
        margin-bottom: 4px;
      }

      .console-output {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-all;
      }

      .console-exit-code {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-top: 4px;
      }

      /* Empty/Placeholder Messages */
      .empty-message, .placeholder-message {
        color: var(--vscode-descriptionForeground);
        text-align: center;
        padding: 16px;
      }

      /* Empty-state container for the graph panel (no-commits /
         filtered-empty). Centers the message + optional action button
         in the available space rather than pinning to the top. */
      .graph-empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 32px 16px;
        text-align: center;
      }
      .graph-empty-action {
        font-family: inherit;
        font-size: inherit;
        padding: 4px 14px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        border-radius: 2px;
      }
      .graph-empty-action:hover {
        background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      }

      /* Log View Styles: IntelliJ-style log layout */
      .log-container {
        display: flex;
        flex-direction: column;
        height: 100%;
      }

      .log-toolbar {
        display: flex;
        justify-content: flex-end;
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background-color: var(--vscode-sideBar-background);
        gap: 4px;
      }

      /* Log Filter Bar Styles*/
      .log-filter-bar {
        padding: 8px;
        background-color: var(--vscode-input-background);
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .log-filter-row {
        display: flex;
        gap: 12px;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }

      .log-filter-row:last-of-type {
        margin-bottom: 0;
      }

      .log-filter-group {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 120px;
      }

      .log-filter-group-date {
        flex: 0 0 auto;
        min-width: 130px;
      }

      .log-filter-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 2px;
        font-weight: 500;
      }

      .log-filter-input {
        padding: 4px 8px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 3px;
        background-color: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font-size: 12px;
        font-family: var(--vscode-font-family);
      }

      .log-filter-input:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
        border-color: var(--vscode-focusBorder);
      }

      .log-filter-input::placeholder {
        color: var(--vscode-input-placeholderForeground);
      }

      .log-filter-date {
        width: 130px;
      }

      .log-filter-actions {
        display: flex;
        gap: 8px;
        margin-top: 8px;
        justify-content: flex-end;
      }

      .log-filter-button {
        padding: 4px 12px;
        border: none;
        border-radius: 3px;
        font-size: 12px;
        cursor: pointer;
        transition: background-color 0.1s ease;
      }

      .log-filter-apply {
        background-color: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }

      .log-filter-apply:hover {
        background-color: var(--vscode-button-hoverBackground);
      }

      .log-filter-clear {
        background-color: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }

      .log-filter-clear:hover:not(:disabled) {
        background-color: var(--vscode-button-secondaryHoverBackground);
      }

      .log-filter-clear:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .log-filter-button:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .log-split-view {
        display: flex;
        flex: 1;
        overflow: hidden;
      }

      .log-commit-list {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        min-width: 300px;
      }

      .log-details-panel {
        width: 350px;
        border-left: 1px solid var(--vscode-panel-border);
        overflow-y: auto;
        background-color: var(--vscode-sideBar-background);
      }

      /* Commit Row Styles */
      .commit-row {
        display: flex;
        align-items: center;
        height: 24px;
        padding: 0;
        cursor: pointer;
        border-bottom: none;
        transition: background-color 0.1s ease;
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

      .graph-svg {
        display: block;
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
        font-size: 12px;
        line-height: 24px;
        flex: 1;
        min-width: 0;
        text-align: left;
      }

      /* Branch chips live in a sibling flex slot of .commit-title.
         The flex-shrink: 0 here is the IntelliJ-parity invariant: chips 
         are always reachable; the message ellipsises around them. The
         :empty rule keeps the slot from occupying the 8px right margin
         when a commit has no branches. */
      .commit-branches {
        display: flex;
        flex-shrink: 0;
        align-items: center;
        gap: 4px;
        margin-right: 8px;
      }

      .commit-branches:empty {
        display: none;
      }

      .commit-meta {
        display: flex;
        flex-direction: row;
        gap: 12px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.2;
      }

      /* Author column: fixed-width, RIGHT-aligned. The column is a
         fixed 120px so the date column starts at a stable x across
         rows (IntelliJ-parity column alignment). Earlier the content
         was left-aligned, which left a visible dead band between a
         short name and the date column — the name hugged the left
         edge of its 120px box while the date sat 120px away
         regardless of name length. Right-aligning collapses that
         band: the name now butts up against the date column's
         left padding, and the slack (if any) falls on the LEFT where
         it abuts the flexible title column. Long names still
         ellipsise (overflow/text-overflow/nowrap retained); the
         ellipsis now appears at the LEFT, preserving the most-recent
         characters of the name nearest the date.
         See KNOWN-ISSUES.md author/date dead-band entry. */
      .commit-author {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        width: 120px;
        flex-shrink: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        text-align: right;
        padding-left: 0;
        padding-right: 12px;
      }

      .commit-date {
        width: 145px;
        flex-shrink: 0;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        text-align: left;
        padding-left: 12px;
        white-space: nowrap;
      }

      /* Branch and Tag Labels */
      .commit-label {
        display: inline-block;
        padding: 1px 6px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: 500;
        margin-right: 4px;
        flex-shrink: 0;
      }

      .branch-label {
        background-color: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
      }

      .branch-label.head-label {
        background-color: var(--vscode-gitDecoration-addedResourceForeground, #629755);
        color: white;
      }

      /* The HEAD chip is distinct from branch chips so the user reads
         "this is HEAD" at a glance even when HEAD is on a commit that ALSO
         has branch-tip chips. It lives in the same .commit-branches flex
         slot as branch chips, prepended FIRST (leftmost) so it precedes any
         branch chips. Theme variable falls back to the IntelliJ shade
         #d4a017 when --vscode-statusBarItem-warningBackground is absent
         (older themes). */
      .branch-label-head {
        display: inline-block;
        background: var(--vscode-statusBarItem-warningBackground, #d4a017);
        color: var(--vscode-statusBarItem-warningForeground, #1a1a1a);
        font-size: 11px;
        font-weight: 600;
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: middle;
      }

      /* Cap chip width with CSS ellipsis. Without a cap, a 70-char branch
         name like
         feature/JIRA-12345-very-long-descriptive-feature-name-with-context
         consumes ~350px in the non-shrinking .commit-branches slot,
         squeezing .commit-title (flex:1, min-width:0) to a few characters
         at typical panel widths. IntelliJ caps at ~200px; we match that with
         text-overflow: ellipsis. The chip's underlying text stays the full
         branch name (the data-branch-name attribute and textContent remain
         complete for screen readers + find-in-page), only visual rendering
         is clipped. vertical-align: middle is defensive — inline-block with
         default baseline alignment can shift slightly relative to message
         text on some font-metrics. */
      .branch-label-local,
      .branch-label-remote,
      .tag-label {
        display: inline-block;
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        vertical-align: middle;
      }

      /* Chip backgrounds use VS Code's badge-background / badge-foreground
         semantic tokens (guaranteed available: engines.vscode floor is
         ^1.85.0). The earlier gitDecoration-stageModifiedResourceForeground /
         gitDecoration-renamedResourceForeground tokens are FG-tier
         file-status semantics — themes that override those for the SCM tree
         would unexpectedly recolor branch chips here. The badge-* family is
         semantically correct for chip-shaped UI; local vs remote distinction
         comes from the codicon prefix (cloud vs git-branch) rather than the
         background colour. Falls back to hex literals when the theme variable
         is absent. Pinned by snap-12e. */
      .branch-label-local,
      .branch-label-remote {
        background: var(--vscode-badge-background, #2d5a1e);
        color: var(--vscode-badge-foreground, #a5d6a7);
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
      }

      /* Collapsed-summary chip ("+N"): rendered when a commit has more
         branches pointing at it than fit inline. Uses a muted
         description-foreground so it reads as metadata, not as another
         branch. The native title=tooltip carries the full list of
         collapsed branch names; a future click-to-expand handler can
         flip data-collapsed-branches into individual chips inline. */
      .branch-label-collapsed {
        background: var(--vscode-badge-background, #3a3a3a);
        color: var(--vscode-descriptionForeground, #888);
        font-size: 11px;
        padding: 1px 5px;
        border-radius: 3px;
        margin-left: 4px;
        cursor: help;
      }

      /* The remote-chip fallback hex pair is retained as a CSS-var
         secondary-fallback so a future theme that defines neither badge-*
         nor the gitDecoration-* family still gets a visually-readable chip.
         Themes that DO define badge-* see identical local + remote
         backgrounds — local vs remote is carried by the icon glyph, not the
         colour. The remote-only hex (#1a3a5c) is retained inline below for
         snap-12e and human grep, even though no rule consumes it directly. */
      .branch-label-remote {
        /* Fallback hex for the remote chip when neither
           --vscode-badge-background nor the legacy
           --vscode-gitDecoration-renamedResourceForeground is defined.
           The shared .branch-label-local, .branch-label-remote rule above is
           the primary; this rule only adds the #1a3a5c retention for snap-12e
           + future hi-contrast drift detection. */
        background: var(
          --vscode-badge-background,
          var(--vscode-gitDecoration-renamedResourceForeground, #1a3a5c)
        );
        color: var(
          --vscode-badge-foreground,
          var(--vscode-gitDecoration-modifiedResourceForeground, #90caf9)
        );
      }

      /* Codicon prefix sizing on chips. The icon is the non-color WCAG 1.4.1
         affordance for local vs remote vs HEAD distinction; font-size 11px
         matches chip text height so the icon does not blow up the chip
         vertically; vertical-align middle aligns the icon glyph with the chip
         text baseline; margin-right 4px separates icon from text. Pinned by
         snap-12g. */
      .branch-label-local i.codicon,
      .branch-label-remote i.codicon,
      .branch-label-head i.codicon,
      .tag-label i.codicon {
        margin-right: 4px;
        font-size: 11px;
        vertical-align: middle;
      }

      /* Focused branch chip (IntelliJ-parity outline + bold). Uses the
         theme-aware focus border so the outline reads correctly under
         high-contrast themes, falling back to currentColor when the variable
         is unavailable. font-weight 700 + underline keep the focused-branch
         affordance visible WITHOUT relying on the focus outline colour alone
         (WCAG 1.4.1 — never use colour as the sole non-text differentiator). */
      .branch-label-focused {
        outline: 1px solid var(--vscode-focusBorder, currentColor);
        outline-offset: 1px;
        font-weight: 700;
        text-decoration: underline;
      }

      /* Chip-family theme symmetry. The .branch-label-* family uses
         var(--vscode-badge-foreground, ...) for the chip text colour;
         .tag-label was the only chip still using a raw white token, which
         loses theme adherence on light and hi-contrast themes where
         badge-foreground is overridden. Match the rest of the chip family.
         snap-13f foreground assertion pins this. */
      .tag-label {
        background-color: var(--vscode-gitDecoration-modifiedResourceForeground, #6897BB);
        color: var(--vscode-badge-foreground, white);
      }

      /* Commit Details Panel */
      .commit-details {
        padding: 12px;
      }

      .commit-details-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .commit-details-header h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }

      .close-details-button {
        background: transparent;
        border: none;
        color: var(--vscode-foreground);
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }

      .close-details-button:hover {
        color: var(--vscode-errorForeground);
      }

      .commit-details-content {
        font-size: 12px;
      }

      .detail-row {
        margin-bottom: 8px;
      }

      .detail-label {
        display: block;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        margin-bottom: 2px;
      }

      .detail-value {
        display: block;
        word-break: break-all;
      }

      .hash-value {
        font-family: var(--vscode-editor-font-family, monospace);
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
      }

      .hash-value:hover {
        text-decoration: underline;
      }

      .parent-hash {
        font-family: var(--vscode-editor-font-family, monospace);
        cursor: pointer;
        color: var(--vscode-textLink-foreground);
      }

      .parent-hash:hover {
        text-decoration: underline;
      }

      .commit-full-message {
        margin: 0;
        white-space: pre-wrap;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        background-color: var(--vscode-textBlockQuote-background);
        padding: 8px;
        border-radius: 3px;
        max-height: 150px;
        overflow-y: auto;
      }

      .message-row {
        margin-top: 12px;
      }

      /* Changed Files Section */
      .changed-files-section {
        margin-top: 16px;
        padding-top: 12px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      .changed-files-section h4 {
        margin: 0 0 8px 0;
        font-size: 12px;
        font-weight: 600;
      }

      .changed-files-list {
        max-height: 200px;
        overflow-y: auto;
      }

      .changed-file-item {
        display: flex;
        align-items: center;
        padding: 3px 4px;
        cursor: pointer;
        border-radius: 3px;
      }

      .changed-file-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .changed-dir-item {
        display: flex;
        align-items: center;
        padding: 3px 4px;
        font-weight: 600;
      }

      .changed-dir-item .dir-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .changed-file-status {
        width: 16px;
        font-size: 11px;
        font-weight: bold;
        margin-right: 6px;
        flex-shrink: 0;
      }

      .changed-file-path {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .loading-message {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        padding: 8px;
      }

      /* Graph Panel Loading Indicator*/
      .graph-loading-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 12px 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        gap: 8px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      .loading-spinner {
        display: inline-block;
        animation: spin 1s linear infinite;
        font-size: 16px;
      }

      .loading-text {
        font-style: italic;
      }

      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }

      /* Drag and Drop Visual Feedback */
      .drag-ghost {
        position: fixed;
        pointer-events: none;
        z-index: 1001;
        background-color: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 12px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }

      /* Branch Panel Styles*/
      .branch-panel {
        padding: 4px 0;
        font-size: 13px;
      }

      .branch-category {
        margin-bottom: 2px;
      }

      .branch-category-header {
        display: flex;
        align-items: center;
        padding: 4px 8px;
        cursor: pointer;
        user-select: none;
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
        letter-spacing: 0.5px;
      }

      .branch-category-header:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .branch-category-header:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .branch-category-children {
        padding-left: 8px;
      }

      .branch-category-name {
        margin-left: 4px;
      }

      .branch-remote-group {
        margin-left: 8px;
      }

      .branch-item {
        display: flex;
        align-items: center;
        padding: 3px 8px 3px 16px;
        cursor: pointer;
        border-radius: 3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .branch-item:hover {
        background-color: var(--vscode-list-hoverBackground);
      }

      .branch-item:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .branch-head-item {
        font-weight: 600;
      }

      .branch-icon {
        width: 16px;
        margin-right: 6px;
        flex-shrink: 0;
        font-size: 12px;
        text-align: center;
      }

      .branch-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .branch-detached-label {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
        margin-left: 6px;
        font-size: 11px;
      }

      /* Details Panel Styles */
      .details-panel {
        padding: 8px;
      }

      .details-metadata {
        font-size: 12px;
      }

      .file-status-indicator {
        width: 16px;
        font-size: 11px;
        font-weight: bold;
        margin-right: 6px;
        flex-shrink: 0;
        text-align: center;
      }

      .file-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .file-directory {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        margin-left: 6px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .rename-arrow {
        color: var(--vscode-descriptionForeground);
        margin: 0 4px;
      }

      .old-path {
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        text-decoration: line-through;
      }

      .no-parents {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }

      /* Graph Panel wrapper */
      .graph-panel {
        overflow-y: auto;
        height: 100%;
      }

      /* Scroll highlight effect */
      .commit-row.highlight-scroll {
        background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(255, 200, 0, 0.2));
        transition: background-color 0.3s ease;
      }
    `;
}

/**
 * / HIG — emit the `@font-face` declaration that loads
 * the bundled VS Code codicon TTF, plus the `.codicon` utility rule
 * that every codicon glyph (`<i class="codicon codicon-…">`) needs to
 * render as the actual icon instead of a "tofu" empty-box.
 *
 * The TTF ships at `media/codicon.ttf` (copied from
 * `node_modules/@vscode/codicons/dist/codicon.ttf` at install time).
 * `webview.asWebviewUri()` rewrites the local fs URI into the
 * `https://…/<extensionId>/media/codicon.ttf` form that the
 * webview's CSP accepts. The HTML emitter widens CSP to include
 * `font-src ${webview.cspSource}` so this same-origin URI loads.
 *
 * The base `.codicon` utility rule (font-family declaration +
 * display + text-rendering + smoothing) is copied from the
 * upstream `codicon.css` so the icon renders crisp at the chip's
 * 11px size. Per-glyph `::before { content: "\\…" }` rules are
 * inlined for ONLY the codicons we currently emit — extend the
 * mapping below whenever a new codicon class is added to a
 * webview that uses this loader. Codepoints are sourced from
 * `node_modules/@vscode/codicons/dist/codicon.css` (verbatim).
 * Pinned by `codiconFont-1..3` in commitGraphSnapshots.test.ts.
 */
export function buildCodiconFontFaceCss(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  // Defensive: many existing unit-test mock webviews stub
  // `cspSource` only and omit `asWebviewUri`. The production VS Code
  // implementation always provides it; for the test surface, fall
  // back to the local-file URI so tests that don't care about the
  // codicon-font wiring don't break. The codiconFont-1..3 RED
  // contract still passes (it asserts the @font-face shape +
  // codepoint rules + CSP, none of which need a real `asWebviewUri`).
  const codiconLocalUri = vscode.Uri.joinPath(extensionUri, 'media', 'codicon.ttf');
  const codiconFontUri =
    typeof webview.asWebviewUri === 'function'
      ? webview.asWebviewUri(codiconLocalUri)
      : codiconLocalUri;
  return `
      @font-face {
        font-family: "codicon";
        font-display: block;
        src: url("${codiconFontUri.toString()}") format("truetype");
      }

      .codicon {
        font: normal normal normal 16px/1 codicon;
        display: inline-block;
        text-decoration: none;
        text-rendering: auto;
        text-align: center;
        text-transform: none;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        user-select: none;
        vertical-align: middle;
      }

      /* Codicon glyph mapping — upstream codepoints from
         @vscode/codicons@0.0.45 (dist/codicon.css). Add a new
         \`.codicon-<name>\` rule here whenever a new codicon class is
         emitted in the provider's HTML. Both \`::before\` (modern
         double-colon) and \`:before\` (single-colon, what upstream
         uses) are accepted by the engine; we keep the upstream
         single-colon shape for byte-equivalence with codicon.css. */
      .codicon-check:before { content: "\\eab2"; }
      .codicon-git-branch:before { content: "\\ec6f"; }
      .codicon-cloud:before { content: "\\ebaa"; }
      /* codicon-tag glyph for tag chips. Codepoint pulled from
         @vscode/codicons@0.0.45 dist/codicon.css (.codicon-tag:before
         → \\ea66). Pinned by codiconFont-4. */
      .codicon-tag:before { content: "\\ea66"; }
    `;
}

/**
 * Get CSS styles for the 2-panel flexbox layout.
 *
 * Includes:
 * - Flexbox row layout for horizontal panel arrangement
 * - Panel overflow and sizing rules
 * - Draggable divider styling
 * - Vertical stacking when container width < 500px
 * - All existing panel styles (graph, details)
 *
 * @returns CSS string for the 2-panel layout
 */
export function buildThreePanelStyles(): string {
  return `
      ${buildInlineStyles()}

      /* Panel Layout*/
      .three-panel-layout {
        display: flex;
        flex-direction: row;
        height: 100vh;
        width: 100%;
        overflow: hidden;
      }

      .three-panel-layout > .panel {
        overflow: auto;
        min-width: 0;
        height: 100%;
      }

      #branch-panel {
        border-right: none;
      }

      #graph-panel {
        border-right: none;
      }

      #details-panel {
        /* No right border needed */
      }

      /* Panel Divider - Draggable separator between panels */
      .panel-divider {
        width: 4px;
        min-width: 4px;
        cursor: col-resize;
        background-color: var(--vscode-panel-border);
        transition: background-color 0.15s ease;
        flex-shrink: 0;
        position: relative;
        z-index: 10;
      }

      .panel-divider::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: -3px;
        right: -3px;
      }

      .panel-divider:hover,
      .panel-divider.dragging {
        background-color: var(--vscode-focusBorder);
      }

      .panel-divider:focus {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      /* Vertical stacking for narrow containers*/
      @container (max-width: 499px) {
        .three-panel-layout {
          flex-direction: column;
        }

        .three-panel-layout > .panel {
          width: 100% !important;
          height: 50%;
          min-height: 100px;
        }

        .panel-divider {
          width: 100%;
          min-width: 100%;
          height: 4px;
          min-height: 4px;
          cursor: row-resize;
        }
      }

      /* JS-based vertical stacking fallback for < 500px */
      .three-panel-layout.vertical-layout {
        flex-direction: column;
      }

      .three-panel-layout.vertical-layout > .panel {
        width: 100% !important;
        height: 50%;
        min-height: 100px;
      }

      .three-panel-layout.vertical-layout .panel-divider {
        width: 100%;
        min-width: 100%;
        height: 4px;
        min-height: 4px;
        cursor: row-resize;
      }

      /* Prevent text selection during divider drag */
      body.resizing {
        user-select: none;
        cursor: col-resize;
      }

      body.resizing-vertical {
        user-select: none;
        cursor: row-resize;
      }
    `;
}
