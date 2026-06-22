# UX/Visual Parity Review (Round 2) — Log / Commit Graph UI

> **NORTHSTAR tie-back:** workstream **G** (Log & Commit Graph) · role: Round-2 UX audit. See `NORTHSTAR.md` section 7 (reference index).

_Round-2 **UX-focused** review by senior-reviewer (UX lens). North-star = IntelliJ Platform VCS Log visual layout, filter bar structure, column presentation, graph rendering aesthetics, and interaction affordances. This review is ORTHOGONAL to R2-01-log.md (tech-lead correctness/functionality review) — both are required for full parity assessment._

**Scope:** Visual structure, layout, column order & labels, filter bar field order/presentation, keyboard navigation, accessibility (ARIA, focus, tabindex), hover feedback, empty states, and "does it LOOK like IntelliJ?"

**Method:** Source-code reconstruction of rendered webview (HTML/CSS builders) vs. IntelliJ VCS Log UI (VcsLogGraphTable, MainFrame, VcsLogClassicFilterUi).

---

## Reference map

### IntelliJ source reviewed (visual structure)
- `platform/vcs-log/impl/src/com/intellij/vcs/log/ui/VcsLogUiImpl.java` — top-level UI orchestrator
- `platform/vcs-log/impl/src/com/intellij/vcs/log/ui/frame/MainFrame.java` — Swing layout: toolbar + table + details + filter UI positioning
- `platform/vcs-log/impl/src/com/intellij/vcs/log/ui/table/VcsLogGraphTable.java` — table structure, row rendering, column management
- `platform/vcs-log/impl/src/com/intellij/vcs/log/ui/table/column/VcsLogDefaultColumn.kt` — column definitions: Root, Commit (graph+message+refs), Author, Date, Hash
- `platform/vcs-log/impl/src/com/intellij/vcs/log/ui/filter/VcsLogClassicFilterUi.kt` — filter bar action ordering: Branch / User / Date / Structure (path) / Text field / Parent (--first-parent/no-merges dropdown)

### intellig source reviewed (visual structure)
- `src/git-core/gitToolWindow/GitToolWindowProvider.ts:2902–2945` — `_getLogFilterBarHtml()` filter bar structure + toggle button
- `src/git-core/gitToolWindow/provider/graphClusterBuilder.ts:44–158` — `buildCommitRows()` HTML structure: `.commit-row` → `.commit-graph` (SVG) + `.commit-info` (title/branches/author/date)
- `src/git-core/gitToolWindow/provider/stylesBuilder.ts:430–740` — filter bar CSS (`:463–565`), commit row layout (`:588–670`), author/date column alignment (`:727–755`)
- `src/git-core/gitToolWindow/provider/htmlBuilders.ts` — details panel, file tree, context menu HTML generation
- `src/git-core/gitToolWindow/GitToolWindowProvider.ts:2963–3084` — `_getBranchLabelsHtml()` chip rendering (local/remote classes, HEAD badge, focused-branch outline)

---

## UX gap table

| Surface / element | IntelliJ look/behavior | intellig look/behavior | Status | Severity | File refs | Notes |
|---|---|---|---|---|---|---|
| **Overall layout** | JTable (graph+msg+author+date columns) in top panel; filter toolbar ABOVE table; details panel below (splitter) | Webview: filter toggle button in toolbar; filter bar expands below toolbar (collapsible); commit list (graph+msg+author+date as flex row, not table columns); details panel to RIGHT (vertical splitter) | 🟡 partial | 🟡 medium | MainFrame.java vs GTWProvider.ts | IntelliJ: horizontal layout (table columns), filters live in a fixed toolbar, details panel BELOW. Ours: CSS flex row (not table), filters toggle-expand, details panel to RIGHT. Trade-off: webview CSS flex is simpler than JTable; right-side details matches VS Code SCM; top-expand filter bar reduces vertical space cost. **F5-confirm:** filter bar expansion smooth, details panel right-resize OK. Difference is acceptable platform adaptation, not a blocker. |
| **Column structure** | JTable with resizable columns: [Graph+Commit] [Author] [Date] [Hash] (Hash optional/hidden by default) | CSS flex row with fixed graph width, flexible title, fixed-width author (120px default), fixed-width date (~100px), no separate Hash column (hash in tooltip only) | 🟡 partial | 🟡 medium | VcsLogGraphTable.java vs graphClusterBuilder.ts:140–155 | IntelliJ: true table columns (user can reorder, hide Hash). Ours: flex row (no column reorder, Hash not inline). Author + date ARE fixed-width to simulate column alignment (stylesBuilder.ts:727–755 right-aligns author, left-aligns date). Trade-off: webview CSS flex is simpler; Hash omission reduces clutter (full hash in tooltip, short hash in context menu "Copy Hash"). **Parity gap:** no inline Hash column, no user-driven column reorder. Not blocking (Hash is accessible, column order is stable). |
| **Filter bar position** | Filters live in a toolbar at top of log panel (always visible, compact action buttons with dropdowns) | Filter bar is a toggle button in toolbar; clicking "Filter" expands a 2-row bar below toolbar (collapsible, HTML inputs not dropdowns) | 🟡 partial | 🟡 medium | VcsLogClassicFilterUi.kt:147–199 vs GTWProvider.ts:2902–2945 | IntelliJ: always-visible toolbar action buttons (Branch / User / Date / Path / Text / Parent) → each opens a popup. Ours: toggle-expand bar with inline text inputs + date pickers + Clear/Apply buttons. Trade-off: expand-bar saves vertical space when unused; inline inputs are discoverable without popup clicks. **Parity gap:** no Branch/User/Parent dropdowns (those filters missing — covered in R2-01-log.md as functional gaps). **F5-confirm:** toggle animation smooth, rehydrates filter values on expand. |
| **Filter field order** | Branch → User → Date → Path → Text → Parent (IntelliJ action ordering: filters.kt:147–199) | Toggle button → (expand) → Row 1: [Message/Hash] [Author] [Path], Row 2: [Since] [Until] + [Clear][Apply] buttons | 🟡 partial | ⚪ polish | VcsLogClassicFilterUi.kt:176–198 vs GTWProvider.ts:2916–2944 | IntelliJ: filter ORDER reflects usage frequency (Branch first, most-used). Ours: Text first (common), Author second, Path third, Date in row 2. Missing: Branch filter (❌ not implemented), User dropdown (freetext only), Parent filter (❌ not implemented). Field **labels** match IntelliJ: "Message / Hash" = Text, "Author" = User, "Path" = Structure, "Since/Until" = Date. **Parity gap:** field order diverges slightly; missing filters are functional gaps (R2-01-log.md). Ordering is NOT a UX blocker (all present fields reachable, labels clear). |
| **Filter field labels** | "Branch" / "User" / "Date" / "Path" / "Text" (localized via VcsLogBundle) | "Message / Hash" / "Author" / "Path" / "Since" / "Until" | ✅ parity | 🟢 | VcsLogBundle message keys vs GTWProvider.ts:2918–2937 | Our labels are MORE specific ("Message / Hash" vs. "Text") and match IntelliJ's actual UX (IntelliJ text filter also searches hash prefix). "Author" vs. "User" is semantic equivalence (author IS the user). "Since/Until" is clearer than generic "Date". Labels are **good**. |
| **Filter input affordances** | Text: SearchFieldWithExtension (toolbar buttons for regex/case toggles). Branch/User/Date/Path: action buttons → popups with rich UI (tree pickers, calendar, multi-select) | Text inputs (no regex/case toggles yet). Date: HTML5 `<input type="date">` (native picker, no presets). No Branch/User/Path dropdowns (missing filters). | 🟡 partial | 🟡 medium | SearchFieldWithExtension vs GTWProvider.ts:2919–2938 | IntelliJ: text field has inline toolbar for regex/case toggles (VcsLogTextFilterField). Ours: plain text input (R2-01-log.md flags regex/case as missing functional feature). Date: HTML5 date picker is functional but less rich than IntelliJ's calendar popup with presets ("Last week", etc.). **F5-confirm:** date picker native (browser-dependent). **Parity gap:** text field missing regex/case UI, date picker missing presets. Not blockers (functional coverage exists, just less polished). |
| **Filter "Clear" affordance** | Single "X" button in toolbar (always visible when any filter active) | "Clear" button inside filter bar (only visible when bar expanded). Also: clearing inputs manually works. | 🟡 partial | ⚪ polish | VcsLogClassicFilterUi action toolbar vs GTWProvider.ts:2941 | IntelliJ: persistent "X" button in top toolbar (one-click clear from any state). Ours: Clear button only reachable when bar open. Trade-off: our Clear is adjacent to inputs (discoverability), but requires two clicks (toggle open → Clear). **F5-confirm:** Clear button resets inputs, collapses bar on apply. Not a blocker (functional path exists). |
| **Commit row layout** | JTable row: [Graph SVG in first cell] [Message + refs in Commit cell] [Author cell] [Date cell] [Hash cell optional] | Flex row: [Graph SVG] → [Commit-info flex container: Title (msg) + Branches (chips) + Author (120px right-align) + Date (fixed-width left-align)] | 🟡 partial | 🟡 medium | VcsLogGraphTable row rendering vs graphClusterBuilder.ts:140–155 | IntelliJ: table cells (distinct click targets, column headers). Ours: single flex row (graph + one fat "commit-info" container). Visual result is similar: graph left, message flexible, author/date right-aligned. **Key difference:** ours lacks visible column HEADERS (no "Author" / "Date" labels at top). **F5-confirm:** row layout clean, author right-alignment correct (stylesBuilder.ts:738). **Parity gap:** no column headers. Not blocking (content is self-describing, author/date recognizable by position). |
| **Column headers (resizable dividers)** | JTable column headers with drag-to-resize between Author/Date columns | Column-header row is rendered (`GitToolWindowProvider.ts:3304` builds it) with `.log-column-resize-handle` drag handles wired to the resize script (`:3043`, `:3077`) + keyboard ArrowLeft/Right on the divider (`:2918`). | ✅ parity | 🟢 | VcsLogGraphTable column model | Visible headers + drag-resize + keyboard resize present. |
| **Graph rendering (lanes, colors)** | Colored lanes (deterministic hash), bezier merge edges, dotted far-parent edges, circle commit nodes | Same: colored lanes, bezier edges, dotted far-parent (endRow-based routing per Wave 2), circle nodes. Colors match IntelliJ palette (default color generator). | ✅ parity | 🟢 | GraphCellPainter vs graphRenderer.ts | Visual output is parity. Lane colors stable (hash-based), edge routing correct (far-parent fix landed Wave 2). **F5-confirm recommended** but prior dogfooding (Wave 2) showed correct rendering. |
| **Branch/tag chips (refs)** | Chips inline after message in Commit column. Colored background (local = blue, remote = orange-ish, tag = yellow-green). HEAD chip always visible (special color). | Chips in `.commit-branches` container (separate flex item, not inline with message). Colors via CSS classes: `.branch-label-local` (blue), `.branch-label-remote` (orange), `.tag-label` (green), `.branch-label-head` (distinct). HEAD chip prioritized (inline-keep logic). | ✅ parity | 🟢 | GraphCommitCellRenderer vs GTWProvider.ts:2963–3084 + stylesBuilder.ts branch-label CSS | Chip colors match IntelliJ semantics. Positioning: ours are in a separate flex slot (not inline with text) but visually adjacent. **Trade-off:** separate container allows `flex-shrink: 0` (chips never hidden even if message long), matching IntelliJ's "chips always visible" invariant. **F5-confirm:** chips render correctly, HEAD badge correct, focused-branch outline works (`.branch-label-focused` CSS exists). |
| **Commit highlighting (branch focus)** | Rows on focused branch path: brighter; others dimmed | `onFocusedBranchPath` is computed (`GitToolWindowProvider.ts:2158`) and applied per row — focused rows get emphasis + `aria-describedby="focused-branch-help"` (`:3582`); `hasFocusedBranch` gates the dim/bright distinction (`:3163`). | ✅ parity | 🟢 | VcsLogGraphTable highlighters | "Focus on Graph" produces visible dim/bright highlighting. |
| **Cherry-picked badge** | Dimmed row + "✓" badge (or checkmark icon) when commit already cherry-picked upstream | Backend `cherryPickedHashes` set exists. CSS `.commit-row-cherry-picked` (opacity 0.6) + `.commit-cherry-badge` (✓ span) exist. Badge IS rendered (graphClusterBuilder.ts:124–130). | ✅ parity | 🟢 | VcsLogGraphTable rendering vs graphClusterBuilder.ts:124–130 | Cherry-picked badge WORKS (badge HTML emitted, CSS applied). **F5-confirm recommended** (requires cherry-mark data). Parity. |
| **Hover feedback** | Row hover: light gray background (subtle) | Row hover: `var(--vscode-list-hoverBackground)` (stylesBuilder.ts:599). VS Code semantic color. | ✅ parity | 🟢 | VcsLogGraphTable hover vs stylesBuilder.ts:598–600 | Hover feedback present, color appropriate (VS Code theme-adaptive). |
| **Selection feedback** | Selected row: blue background (or theme selection color), white text | Selected row: `var(--vscode-list-activeSelectionBackground)` + `var(--vscode-list-activeSelectionForeground)` (stylesBuilder.ts:607–610) | ✅ parity | 🟢 | VcsLogGraphTable selection vs stylesBuilder.ts:607–610 | Selection colors correct, theme-adaptive. |
| **Multi-select visual** | Selected rows: all have selection background. Anchor row: no distinct visual (anchor is internal state). | Same: selected rows have `.selected` class → blue background. Anchor is internal (`anchorHash` field). | ✅ parity | 🟢 | VcsLogGraphTable selection model vs IExtendedLogState:239 | Multi-select visuals match IntelliJ (all selected rows highlighted, no anchor decoration). |
| **Focus ring (keyboard nav)** | Table has focus ring on focused row. Arrow keys navigate. Enter expands details. | Rows are `tabindex="0"` + `:focus` outline; Left/Right arrows navigate parent/child (`goToParent`/`goToChild`, `:2918`). Up/Down row-to-row stepping is the residual. | 🟡 partial | ⚪ polish | VcsLogGraphTable keyboard nav | Keyboard-focusable + parent/child nav present; add Up/Down stepping for full parity. S effort. |
| **Empty state (no commits)** | "No commits" message centered in table area | `_getEmptyGraphPanelHtml()` renders "No commits" message + "Fetch" action button (if remote exists) | ✅ parity | 🟢 | VcsLogGraphTable empty text vs GTWProvider.ts `_getEmptyGraphPanelHtml` | Empty state clear, actionable. |
| **Empty state (filtered, no results)** | "No commits matching filters" + "Clear filters" link | Same: "No commits matching the applied filters" + "Clear filter" button (GTWProvider.ts filteredEmptyHtml branch) | ✅ parity | 🟢 | VcsLogGraphTable filtered-empty vs GTWProvider.ts filtered empty path | Filtered-empty state clear, actionable. |
| **Loading state** | "Loading commits..." / progress spinner in table | `buildLoadingHtml()` shows "Loading..." message (no spinner yet, but text clear) | 🟡 partial | ⚪ polish | VcsLogGraphTable loading indicator vs htmlBuilders.ts:buildLoadingHtml | IntelliJ: animated spinner. Ours: text only. **F5-confirm:** loading text shows during fetch. Not a blocker (user knows load is happening). Spinner = polish. |
| **Details panel layout** | Bottom panel (horizontal splitter above it). Tabs: "Changes" (file tree), "Metadata". Default: Changes tab. | Right panel (vertical splitter to left). Single view: commit hash + author + date + message body + file tree (no tabs). Multi-select: shows commit range summary. | 🟡 partial | 🟡 medium | MainFrame details panel vs htmlBuilders.ts:buildDetailsPanelHtml | IntelliJ: tabbed details (Changes / Metadata / sometimes History). Ours: single unified view (metadata + files in one pane, no tabs). **Trade-off:** our unified view is simpler, matches VS Code single-pane style. IntelliJ tabs allow more metadata fields without scroll. **F5-confirm:** right-panel details render correctly. Not a blocker (all info present, just layout differs). |
| **File tree in details panel** | Tree with folders (collapsible), files indented, file status colors (M blue, A green, D gray) | Same: `renderFileTree()` in htmlBuilders.ts. Folders collapsible (chevron toggle), files colored via `getFileStatusColor()` (IntelliJ color constants). | ✅ parity | 🟢 | ChangesBrowserBase (IntelliJ) vs htmlBuilders.ts:renderFileTree | File tree structure + colors parity. |
| **File tree a11y (roles, aria)** | JTree (Swing): native accessibility (role=tree, aria-expanded on folders) | Added in bugfix #14 (landed 6c47f83): outer role=tree, dir rows treeitem+aria-expanded, leaf rows treeitem. Chevron toggle syncs aria-expanded. | ✅ parity | 🟢 | JTree a11y vs htmlBuilders.ts file-tree + scriptBuilder chevron toggle | Accessibility roles correct per bugfix #14 tech-lead review (AGENT_WORKSPACE). |
| **File tree keyboard nav** | Arrow keys expand/collapse folders, navigate files | NOT implemented. Folders toggle on click only. | 🟡 partial | 🟡 medium | JTree keyboard vs scriptBuilder.ts file tree handlers | IntelliJ: arrow keys navigate tree + expand/collapse. Ours: click-only. **Accessibility gap:** keyboard-only users can't navigate file tree. **Fix:** add keydown handler on tree items (Right expands, Left collapses, Up/Down navigate). Effort: M. Not blocking (files are reachable via Tab, but not efficient). |
| **File double-click** | Opens diff editor | Same: `doubleClickCommitFile` message → opens VS Code diff editor (GTWProvider.ts:1384) | ✅ parity | 🟢 | VcsLogGraphTable file action vs GTWProvider message handler | Double-click works. |
| **File context menu** | Right-click file → "Copy Path", "Show History", "Open at Revision", "Annotate" | NOT implemented. No right-click handler on file rows. | 🟠 high | 🟠 high | ChangesBrowserBase file menu vs htmlBuilders.ts file tree (no contextmenu handler) | IntelliJ: rich file context menu. Ours: **no file-level context menu**. User can't copy path, can't open file history from details panel. **Workaround:** open file history via command palette or explorer context menu (outside log panel). **Fix:** add `contextmenu` event handler on file rows in scriptBuilder.ts → QuickPick menu or webview context menu. Effort: M (handler + menu actions). Flagged in R2-01-log.md as functional gap; reiterating as **UX discoverability gap**. |
| **Context menu ordering** | IntelliJ menu: Copy Hash / Copy Message at top, Create Patch / Compare near top, destructive (Reset / Revert / Drop) at bottom, ordered by frequency. | Menu actions functional but ordering not fully aligned (R2-01-log.md notes "partial" parity). Menu HTML built in htmlBuilders.ts, ordering is code-order. | 🟡 partial | ⚪ polish | IntelliJ menu XML vs htmlBuilders.ts:buildCommitContextMenuHtml | Menu action SET is parity (all IntelliJ actions present). Ordering diverges slightly. Not a UX blocker (all actions reachable, discoverability via search). Reordering = polish. |
| **Commit message tooltip** | Hover commit row → tooltip shows full commit message (multi-line) | HTML `title` attribute on `.commit-title` div contains full escaped message (graphClusterBuilder.ts:150) | ✅ parity | 🟢 | VcsLogGraphTable tooltip vs graphClusterBuilder.ts:150 | Tooltip works (browser-native). |
| **Date format** | IntelliJ "pretty" date: "Jan 15, 2025 3:45 PM" (locale-aware, no seconds in row, full timestamp in tooltip) | Same: `formatCommitDate()` returns `{ display, tooltip }` (utils/dateFormat.ts). Display = locale date+time no-seconds, tooltip = full ISO. (graphClusterBuilder.ts:116–118) | ✅ parity | 🟢 | VcsLogGraphTable date rendering vs formatCommitDate | Date format matches IntelliJ style. |
| **Author display** | IntelliJ shows author name only (email in tooltip or details panel) | Same: row shows `commit.author.name`, tooltip on author span shows email (graphClusterBuilder.ts:152) | ✅ parity | 🟢 | VcsLogGraphTable author rendering vs graphClusterBuilder.ts:109–152 | Author display parity. |
| **Repo selector (multi-root)** | Dropdown at top of log panel (when multi-root workspace) | `_getRepositorySelectorHtml()` renders dropdown; `_handleRepositorySelection` switches active repo (GTWProvider.ts:1419) | ✅ parity | 🟢 | MainFrame repo selector vs GTWProvider repo selector | Multi-repo UI present. |
| **Panel resize persistence** | Splitter positions saved in IDE settings, restored on restart | `savePanelWidths()` / `loadPanelWidths()` in panelLayout.ts (GTWProvider.ts:2400 references it) | ✅ parity | 🟢 | MainFrame splitter state vs panelLayout.ts | Panel widths persist. |
| **Column width persistence** | Column widths saved, restored on restart | `saveColumnWidths()` / `loadColumnWidths()` in columnLayout.ts (GTWProvider.ts:2400 references it) | ✅ parity | 🟢 | VcsLogGraphTable column widths vs columnLayout.ts | Column widths persist (once headers wired). |
| **ARIA landmarks** | JTable component tree has native a11y (role=table, role=row, role=gridcell) | Commit rows have `role="option"` + `aria-selected` (graphClusterBuilder.ts:143–145). Filter bar has `role="group"` + `aria-label="Log filters"` (GTWProvider.ts:2915). Graph panel is listbox-like (rows are options). | 🟡 partial | 🟡 medium | JTable a11y vs graphClusterBuilder + GTWProvider filter bar | ARIA roles present but **semantic mismatch**: commit list is more "grid" than "listbox" (multi-column layout). IntelliJ table uses role=table. Ours uses role=option (listbox child). **Better:** `role="grid"` on container, `role="row"` on commit-row, `role="gridcell"` on graph/title/author/date. Effort: S (change roles, no behavior change). Not blocking (screen readers tolerate imperfect roles, content still reachable). |
| **Focus trap (webview keyboard escape)** | N/A (Swing native) | Webview focus trap: arrow keys inside log must not bubble to VS Code sidebar. | ❌ missing | 🟡 medium | N/A vs scriptBuilder.ts keyboard handlers | When keyboard nav wired, must `event.stopPropagation()` on arrow keys to prevent VS Code sidebar navigation. Effort: trivial once keyboard nav implemented. Not blocking (keyboard nav not wired yet). |

---

## Top UX findings (ranked)

### 🔴 Critical (blocks usability for target users)
**None.** All critical-severity gaps are FUNCTIONAL (covered in R2-01-log.md correctness review). UX gaps here are HIGH or below.

### 🟠 High

_(Column headers, branch-focus highlighting, and parent/child keyboard nav have all landed — see the layout table. The residuals below are the remaining UX gaps.)_

1. **File context menu missing (discoverability gap)** — IntelliJ: right-click a file in the details panel → "Copy Path", "Show History for File", "Open File at Revision", "Annotate". Ours: no right-click handler on file rows (double-click opens diff). **Fix:** `contextmenu` handler on file rows → host QuickPick with file actions. Effort: M. **Files:** scriptBuilder.ts, htmlBuilders.ts (`data-file-path`), GitToolWindowProvider message handler.

### 🟡 Medium (suboptimal, users can work around)

5. **Filter field order diverges from IntelliJ** — IntelliJ filter toolbar: Branch → User → Date → Path → Text → Parent (usage-frequency order). Ours: toggle button → (expand) → Text → Author → Path, then Date in row 2. Missing: Branch/User/Parent dropdowns (functional gaps, R2-01-log.md). **Impact:** muscle memory disruption (IntelliJ users expect Branch first). **Mitigation:** our Text-first is also reasonable (text search is common). **Fix (low priority):** reorder filter bar rows to Text → Branch (once implemented) → User (once dropdown) → Path, Date in row 2. Effort: S (HTML reorder). **Not blocking:** all present fields reachable, labels clear.

6. **File tree keyboard nav missing** — IntelliJ: arrow keys navigate file tree, Right expands folder, Left collapses. Ours: folders toggle on click only. **Impact:** keyboard-only users can't efficiently navigate file tree (must Tab through every file). **Fix:** add keydown handler on tree items: Right expands, Left collapses, Up/Down navigate. Effort: M (~30 lines JS). **Files:** scriptBuilder.ts file tree section. **Not blocking:** files reachable via Tab (slow but works).

7. **Column structure (flex row vs. table)** — IntelliJ: JTable (true table columns, user can reorder, hide Hash column). Ours: CSS flex row (no reorder, Hash not inline). **Impact:** can't reorder columns, Hash not visible (in tooltip only). **Mitigation:** flex row is simpler (webview constraint), Hash is accessible (tooltip + context menu "Copy Hash"). **Fix (if desired):** rebuild as HTML `<table>` with column-reorder drag-and-drop. Effort: L (major rework). **Defer:** flex row is acceptable webview adaptation; not a blocker.

8. **Details panel position (right vs. bottom)** — IntelliJ: details panel BELOW log table (horizontal splitter). Ours: details panel to RIGHT (vertical splitter). **Impact:** differs from IntelliJ layout, but matches VS Code SCM pattern (changes to right). **Mitigation:** right-side is VS Code convention. **No fix needed:** acceptable platform adaptation.

9. **ARIA role semantic mismatch (listbox vs. grid)** — Commit list uses `role="option"` (listbox child). IntelliJ JTable uses role=table/row/gridcell. **Impact:** screen readers may misinterpret structure (listbox = single-column, grid = multi-column). **Fix:** change to `role="grid"` on container, `role="row"` on commit-row, `role="gridcell"` on graph/title/author/date cells. Effort: S (~10 lines role changes). **Files:** graphClusterBuilder.ts. **Not blocking:** content still reachable, just less semantically precise.

### ⚪ Polish (nice-to-have, low impact)

10. **Filter input affordances (no regex/case toggles, date presets)** — IntelliJ text filter: inline toolbar buttons for regex/case toggles. Date filter: calendar popup with presets ("Last week"). Ours: plain text inputs, HTML5 date picker (no presets). **Impact:** less rich UX, but functional. **Fix:** add regex/case checkboxes in filter bar (functional feature, R2-01-log.md). Add date presets (buttons for "Last 7 days" / "Last month" → set Since field). Effort: M (UI + backend flags). **Defer:** functional gaps, not visual-only.

11. **Loading state (no spinner)** — IntelliJ: animated spinner during load. Ours: "Loading..." text only. **Impact:** user knows load is happening, but no animation feedback. **Fix:** add CSS spinner (rotate animation on SVG or div). Effort: S (~10 lines CSS). **Files:** stylesBuilder.ts, htmlBuilders.ts:buildLoadingHtml. **Defer:** text is adequate, spinner = polish.

12. **Context menu ordering** — IntelliJ: Copy actions at top, destructive at bottom. Ours: functional but ordering not fully aligned. **Impact:** slight muscle memory disruption. **Fix:** reorder menu items in htmlBuilders.ts:buildCommitContextMenuHtml to match IntelliJ XML. Effort: S (code reorder). **Defer:** all actions reachable, search helps discoverability.

---

## Accessibility subsection

### WCAG compliance audit

| Criterion | Status | Notes |
|---|---|---|
| **1.3.1 Info and Relationships (A)** | 🟡 Partial | Commit rows have `role="option"` (should be `role="row"` for multi-column grid). File tree has correct role=tree/treeitem (✅). Filter bar has role=group + aria-label (✅). **Fix:** change commit list to role=grid/row/gridcell. |
| **2.1.1 Keyboard (A)** | 🔴 Fail | Commit list: `tabindex` present but no arrow key nav (blocker). File tree: no keyboard expand/collapse. **Fix:** add keydown handlers (HIGH priority). |
| **2.4.3 Focus Order (A)** | ✅ Pass | Tab order logical: filter bar → commit list → details panel. |
| **2.4.7 Focus Visible (AA)** | ✅ Pass | `:focus` outline on rows (stylesBuilder.ts:602–605), inputs, buttons. |
| **4.1.2 Name, Role, Value (A)** | 🟡 Partial | Filter inputs have labels (✅). Commit rows have aria-selected (✅). File tree has aria-expanded (✅). But: commit list role mismatch (option vs. row). **Fix:** change roles. |

**Blocking issues:**
1. **2.1.1 Keyboard (Level A):** Commit list keyboard nav missing = WCAG A failure. **Must fix.**
2. **1.3.1 / 4.1.2 (Level A):** role=option → role=row mismatch = semantic error. **Should fix.**

**Non-blocking:**
- File tree keyboard nav (not required for A, but improves UX).
- Focus trap on arrow keys (prevents VS Code sidebar nav, not a WCAG issue but good practice).

---

## F5-confirm items (can only be verified by running extension)

1. **Filter bar toggle animation:** Expand/collapse smooth? Rehydrates filter values on expand?
2. **Column header rendering:** Are headers visible at top of commit list? (Currently: NO headers in HTML → must fix first, then F5.)
3. **Commit highlighting on branch focus:** Invoke "Focus on Graph" on a branch → do rows brighten/dim? (Currently: NO classes applied → must fix first, then F5.)
4. **Keyboard navigation:** Tab to commit row → arrow keys navigate? (Currently: NO handlers → must fix first, then F5.)
5. **File context menu:** Right-click file in details panel → menu shows? (Currently: NO handler → must fix first, then F5.)
6. **Date picker:** HTML5 date input shows native picker? (Browser-dependent, verify on macOS Safari + Chrome.)
7. **Cherry-picked badge:** Commit with cherry-mark data → ✓ badge shows? (Requires cherry-mark test data.)
8. **Graph rendering:** Lanes, edges, colors correct? (Prior Wave 2 dogfooding showed correct, but re-verify.)

---

## Executive summary

**Overall UX health: GOOD foundation, 4 HIGH gaps block full parity.**

**Top 4 UX gaps (all HIGH severity):**

1. **🟠 Column headers missing** — No visual labels ("Author" / "Date") at top of commit list, no drag-to-resize affordance despite resize script existing. User can't discover column structure or resize. **Fix:** emit header row HTML, wire to existing script. Effort: S.

2. **🟠 Keyboard navigation missing (accessibility blocker)** — Rows have `tabindex` + focus ring but no arrow key handlers. Keyboard-only users can't navigate commit list. **WCAG Level A failure.** **Fix:** add keydown handlers (Up/Down/Enter/Ctrl+A). Effort: M.

3. **🟠 Commit highlighting on branch focus (visual feedback missing)** — Backend computes highlight state, CSS exists, but classes NOT applied to rows. "Focus on Graph" appears broken (no visual response). **Fix:** add 2-line class toggle in row builder. Effort: S.

4. **🟠 File context menu missing** — Right-click file in details panel → nothing. Can't copy path, can't open file history from expected location. **Fix:** add contextmenu handler → QuickPick menu. Effort: M.

**Strengths:**
- Filter bar structure clean, labels clear, toggle-expand saves space.
- Commit row layout (graph + message + author + date) visually matches IntelliJ despite being CSS flex not table.
- File tree a11y roles correct (post-bugfix #14).
- Graph rendering (lanes, edges, colors) parity.
- Cherry-picked badge, hover/selection feedback, tooltips all correct.
- Panel/column width persistence working.

**Recommendation:** Fix HIGH gaps (headers + keyboard nav + highlighting + file menu) before declaring UX parity. MEDIUM/POLISH gaps are acceptable deferrals (functional coverage exists, just less polished).
