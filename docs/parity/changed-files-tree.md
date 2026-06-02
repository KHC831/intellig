# Changed Files tree & history row layout — IntelliJ parity reference

Status: Living reference (git-view-layout-parity, 2026-06-01)

This document is the **visual-truth specification** for two IntelliG
Git-tool-window surfaces delivered by the `git-view-layout-parity`
feature:

1. **Changed Files directory hierarchy** — the commit-details
   "Changed Files (N)" list, rendered as an IntelliJ-style folder
   tree (§1).
2. **Commit history row layout** — the per-file FileHistoryTab
   commit rows, with the author and date columns sitting adjacent
   instead of separated by a wasted slack gap (§2).

Both are governed by ADR-010 visual-parity discipline. The reference
behaviour is IntelliJ IDEA's Git tool window. Per Layer 3, every
visual claim below that maps onto an algorithm / renderer / HTML
output cites the snapshot test that pins it, in the
`(see snap-… in <test>)` form. Updates to this doc precede
implementation changes — write the spec first, walk the code forward.

The third surface of the same feature — the no-repository empty
state — is a *repo state*, not a visual element, so it lives in
`docs/parity/repo-states.md §5.5` rather than here.

---

## §1 Changed Files directory hierarchy

### §1.1 IntelliJ reference behaviour

IntelliJ's commit-details "Changed Files" pane groups changed files
under their parent folders as a nested tree, rather than printing a
flat list of full paths. Three behaviours define the reference:

- **Folder nesting.** Each directory segment of a file's path is a
  directory row; files are nested beneath every directory segment of
  their path, with each deeper level visually indented further than
  its parent.
- **Shared-prefix collapse.** Files that share a leading directory
  path render under a single shared directory row, not one row per
  file.
- **Single-child chain compaction.** A directory whose only child is
  another directory is merged into one row whose label is the joined
  segments — e.g. `src` → `main` → `java` (each with a single
  directory child) compacts to a single `src/main/java` row. A
  directory whose single child is a *file* is NOT compacted.

### §1.2 Tree structure

The pure transform `buildFileTree(files)` in
`src/git-core/gitToolWindow/html/fileTree.ts` produces the forest;
`renderFileTree(nodes, depth, deps)` emits the markup. Worked example
for the fixed snapshot fixture:

Input (flat changed-file list):

```
src/main/java/App.java            (modified)
src/main/java/util/Helpers.java   (added)
src/main/java/Renamed.java        (renamed ← src/main/java/Old.java)
README.md                         (modified)
```

Rendered tree (after compaction + sort):

```
src/main/java                     ← src→main→java compacted to one dir row (depth 0)
  util                            ← nested dir row (depth 1)
    Helpers.java   A              ← file leaf (depth 2)
  App.java         M              ← file leaf (depth 1)
  Renamed.java     R  ← src/main/java/Old.java
README.md          M              ← root-level file leaf (depth 0)
```

Ordering rule: among the children of any node, **all directories sort
before all files**, and each of those two groups is sorted ascending
case-insensitively by display name. At the top level, the
`src/main/java` directory therefore precedes the root-level
`README.md` leaf; inside `src/main/java`, the `util` directory
precedes `App.java` and `Renamed.java` (`App` before `Renamed`,
case-insensitive).

### §1.3 Render rules

- **Indentation** is visual-only via an inline
  `padding-left: {depth * 16 + 4}px` on every row (16px per level,
  4px base) — directory and file rows are flat siblings inside the
  single `.changed-files-list` container, never DOM-nested. This
  keeps the existing `document`-level `dblclick` delegation
  (`.changed-file-item[data-path][data-commit-hash]`) and the
  `role="list"` / `role="listitem"` accessibility semantics working
  unchanged. Depth 0 → 4px, depth 1 → 20px, depth 2 → 36px.
- **Directory row**: `<div class="changed-dir-item" role="listitem"
  style="padding-left: …">` wrapping a `<span class="dir-name">` with
  the escaped (compacted) label. Directory rows carry no `data-path`
  / `data-commit-hash`, so the dblclick delegation never matches
  them.
- **File leaf**: the existing `.changed-file-item` row, preserving
  `data-path` (full original path), `data-status`, `role="listitem"`,
  `tabindex="0"`, the color-coded status indicator + status letter,
  and the file name. In the single-commit panel each leaf also
  carries `data-commit-hash`; in the multi-commit combined view the
  leaves omit it.
- **Renamed leaf**: the old path renders on the same row as
  `<span class="rename-arrow">←</span> <span class="old-path"
  title="…">…</span>`, with the full old path value retained.
- **Header**: the `Changed Files (N)` header keeps the **total** file
  count, unchanged by the directory grouping. A commit with zero
  changed files renders the `No changed files` message instead of a
  tree.
- **Both panels** — single-commit (`_getDetailsPanelHtml`) and
  multi-commit combined (`_getMultiCommitDetailsPanelHtml`) — share
  the one `fileTree.ts` implementation.

### §1.4 Test coverage

Layer 1 — directory-tree HTML emit (Requirements 2.10, 2.11, 2.12):

- `snap-tree-1` — single-commit panel freezes the nested tree WITH
  `data-commit-hash` on every leaf.
- `snap-tree-2` — multi-commit combined panel freezes the SAME tree
  WITHOUT `data-commit-hash`.
- `snap-tree-3` — single-commit leaves carry `data-commit-hash`
  (four leaves → four attributes); combined leaves carry none.
- `snap-tree-4` — every emitted row (2 directory + 4 file rows)
  carries `role="listitem"`.
- `snap-tree-5` — pins the compacted `src/main/java` directory label
  at `padding-left: 4px` and the nested `util` directory row at
  `padding-left: 20px` (Requirement 2.14 compaction).

  (all in `src/test/unit/services/detailsPanel.test.ts`, suite
  `git-view-layout-parity / snap-changed-files-tree`)

Layer 1 — pure transform / renderer properties (Requirement 2,
`src/test/property/fileTree*.property.test.ts`):

- Property 1 (reconstruction) — flattening the tree yields exactly
  the input path set, each path once.
- Property 2 (compaction) — no directory node has a single directory
  child.
- Property 3 (ordering) — directories-before-files, each group
  case-insensitively sorted.
- Property 4 (render structure) — every row has `role="listitem"`;
  child indentation strictly exceeds the parent's; siblings share
  indentation.
- Property 5 (leaf fidelity) — `data-path`, `data-commit-hash`,
  status letter/color, base name, and the renamed `oldPath` are all
  preserved.

### §1.5 Cross-references

- ADR-010 Layer 1 (snapshot discipline) / Layer 3 (this reference
  doc) — the discipline that produced this document.
- `src/git-core/gitToolWindow/html/fileTree.ts` — `buildFileTree`
  (pure transform) + `renderFileTree` (pure renderer).
- `src/git-core/gitToolWindow/GitToolWindowProvider.ts` —
  `_getDetailsPanelHtml` / `_getMultiCommitDetailsPanelHtml`, the two
  call sites that share the tree.
- `docs/parity/accessibility.md §4` — the changed-files status
  indicator a11y contract that the file leaves preserve.

---

## §2 Commit history row layout

### §2.1 IntelliJ reference behaviour

In IntelliJ's file-history view, each commit row uses the limited
horizontal width efficiently: the author and date sit close together,
separated only by a single uniform gap, with the commit subject
absorbing all remaining slack. There is no wide empty gap between the
author and date columns.

### §2.2 Column layout

The FileHistoryTab row (`renderCommitRow` in
`src/git-core/gitToolWindow/html/historyHtml.ts`) is a CSS grid with
four columns in strict left-to-right order:

```
┌────────┬──────────────────────────┬────────────┬──────────┐
│ hash   │ subject (slack-absorbing)│ author      │ date     │
│ 7ch    │ minmax(0, 1fr)           │ ≤14ch       │ ≤10ch    │
└────────┴──────────────────────────┴────────────┴──────────┘
   └─ single uniform 8px gap between every column ─┘
```

- `grid-template-columns: 7ch minmax(0, 1fr) minmax(0, 14ch) minmax(0, 10ch)`
  with `gap: 8px`.
- The **subject** is the only flexible (slack-absorbing) track —
  `minmax(0, 1fr)`. The `min` of `0` lets the subject shrink below
  its content width and truncate first when the row is narrow, which
  a bare `1fr` (implicit `min: auto`) cannot.
- **Author** (`minmax(0, 14ch)`) and **date** (`minmax(0, 10ch)`) cap
  at their maximum widths and are NOT flexible, so no slack track sits
  between author and date or between subject and author. Author and
  date therefore sit immediately after the subject, separated only by
  the uniform `gap`.
- Author and date cells render single-line with ellipsis:
  `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`.

The markup order (`.history-commit-hash` → `.history-commit-subject`
→ `.history-commit-author` → `.history-commit-date`) is unchanged
by the fix — only the grid track definition and the author/date
ellipsis rule changed.

### §2.3 Test coverage

Layer 1 — history-row layout HTML/CSS emit (Requirements 1.3, 1.8,
`src/test/unit/html/historyTabStyles.snapshots.test.ts`, suite
`git-view-layout-parity / Req 1 — History row layout
Visual_Parity_Snapshot`):

- `snap-history-css` — pins the exact `.history-commit-row` grid rule
  (`grid-template-columns: 7ch minmax(0, 1fr) minmax(0, 14ch)
  minmax(0, 10ch); gap: 8px`) and asserts the pre-fix bare-track form
  `7ch 1fr 14ch 10ch` does NOT regress; a second assertion pins the
  author/date single-line + ellipsis rule.
- `snap-history-row` — freezes `renderCommitRow(...)` output for a
  representative commit, pinning the left-to-right
  hash → subject → author → date cell order, and asserts a multi-line
  message keeps only its first line in the subject cell.

### §2.4 Cross-references

- ADR-010 Layer 1 / Layer 3 — the visual-parity discipline.
- `src/git-core/gitToolWindow/html/historyHtml.ts` —
  `historyTabStyles()` (the grid + ellipsis rule) and
  `renderCommitRow()` (the unchanged cell order).
- `docs/parity/git-log-graph.md §2.0` — the sibling log-graph row
  layout (`.commit-author` / `.commit-date` fixed-width slots), the
  same "fixed trailing columns, flexible message" pattern applied to
  the main graph rows.

---

_Last updated: 2026-06-01._
