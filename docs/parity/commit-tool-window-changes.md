# Parity reference — Commit tool window: Local Changes (grouping, unversioned, diff preview)

Status: living document (Wave A — Commit/Changelists)

This is the Layer-3 (ADR-010) parity reference for the **Local Changes** panel
of IntelliG's Commit tool window (`CommitToolWindow.ts`). It pins IntelliJ's
reference behaviour for the three surfaces workstream A item 4 added: changes
**grouping**, the **Unversioned Files** node, and the **diff-preview pane**.

Cross-references:

- ADR-010 — visual parity discipline (the layered snapshot/UX/reference model).
- `docs/parity/changed-files-tree.md` — sibling reference for the grouping tree.
- `docs/parity/full-parity-audit-2026-06-15.md` §A — the audit gap this closes.
- git4idea reference: `ChangesGroupingPolicy` (directory/module/repository),
  the `LocalChangesListView` Unversioned Files node, and the embedded diff
  preview in the commit tool window.

---

## 1. Changes grouping

IntelliJ's `ChangesGroupingPolicy` supports **directory**, **module**, and
**repository** grouping, switchable from a toolbar control. IntelliG implements:

| Mode        | Behaviour                                                            | Status |
| ----------- | ------------------------------------------------------------------- | ------ |
| `directory` | Files nested under collapsible directory nodes. IntelliJ default.   | ✅ Wave A |
| `flat`      | Each file as one row showing the full repo-relative path.           | ✅ Wave A |
| `module`    | No VS Code module model — no faithful analogue.                     | ⛔ out of scope |
| `repository`| Multi-root grouping; belongs to the multi-root tool window (C).     | ⛔ deferred |

### 1.1 Render rules

- The Local Changes header carries a segmented control
  (`.ctw-grouping` → `.ctw-grouping-btn[data-grouping]`) with `Directory`
  and `Flat`. The active button has `.ctw-grouping-active` +
  `aria-pressed="true"`.
- **Directory mode**: files group into `.ctw-dir-group` blocks. Each non-root
  directory emits a `.ctw-dir-row[data-dir="<dir>"]` header showing the
  directory path; file rows under it show the **basename** only. The
  repo-root bucket (`dir === ''`) emits no directory header — its files render
  directly. (see snapshot-A4-1 + the directory-mode render assertions in
  `commitToolWindowGrouping.test.ts`)
- **Flat mode**: no `.ctw-dir-row` headers; each `.ctw-file-row` shows the full
  repo-relative path in `.ctw-file-path`.
- In BOTH modes the `data-path` attribute on `.ctw-file-row` /
  `.ctw-file-check` carries the **full repo-relative path**, so host dispatch
  (selectFile / toggleFile / context menu) is grouping-independent.
- Buckets sort by directory path, then files by basename
  (`groupFilesByDirectory`). Loss-free + bucket-correctness are pinned by
  `changesGrouping.property.test.ts`.

### 1.2 State

- The mode is persisted to workspaceState under
  `intellig.commitToolWindow.changesGrouping` and defaults to `directory`
  (IntelliJ's default). `setChangesGrouping` re-renders; the webview posts
  `changesGroupingChange` on a segmented-control click.

---

## 2. Unversioned Files node

IntelliJ renders **untracked** files under a dedicated top-level
"Unversioned Files" node rather than inside a changelist, with an
"Add to VCS" action.

### 2.1 Render rules

- `partitionUnversionedFiles` splits files with `status === 'untracked'` out of
  every changelist into a single bucket; the changelists render with those
  files removed so no file appears twice.
- The node renders as a `.ctw-changelist-block.ctw-unversioned-block` with a
  `.ctw-changelist-row.ctw-unversioned-row` header titled "Unversioned Files"
  and a file count. Its file rows carry
  `data-changelist="_unversioned"` (`UNVERSIONED_PSEUDO_CHANGELIST_ID`) so the
  host's right-click handler offers the **Add to VCS** entry
  (`fileContextMenuLabels` adds it for `untracked` files).
- The node is omitted entirely when there are no untracked files.
- Pinned by the Unversioned-node assertions in
  `commitToolWindowGrouping.test.ts` + the partition invariants in
  `changesGrouping.property.test.ts`.

### 2.2 Add to VCS wiring (Wave A item 3)

The webview previously posted `intellig.addToVcs` (no such command) — a no-op.
It now posts the registered `intellig.explorer.addToVcs` with a `vscode.Uri`
resolved against the repo root (the command's `resolveExplorerFileUri` expects
a Uri, not the bare relative string). Pinned by the
`addToVcs dispatches intellig.explorer.addToVcs` test in
`commitToolWindow.test.ts`.

---

## 3. Diff-preview pane

IntelliJ embeds a diff preview in the commit tool window; selecting a changed
file shows its diff inline. IntelliG previously posted `updateDiffPreview` from
the host with **no surface** to receive it (audit gap).

### 3.1 Render rules

- The Local Changes panel renders a `.ctw-diff-preview[data-diff-preview]`
  surface below the tree, initially showing "Select a file to preview changes".
- On `selectFile`, the host fetches the diff and posts
  `{ type: 'updateDiffPreview', path, diff }` (or `{…, error}`). The webview's
  `renderDiffPreview` builds the preview with **DOM node construction**
  (`createElement` + `textContent`), never `innerHTML` with interpolated
  content — a hostile path / diff line cannot inject markup.
- The pane shows: a head row with the file path, then per-hunk a
  `.ctw-diff-hunk-header` followed by `.ctw-diff-line` rows
  (`.ctw-diff-add` / `.ctw-diff-del` / context) with `+` / `-` / ` ` prefixes.
  Binary diffs render "Binary file"; empty diffs render "No changes"; errors
  render "Failed to load diff: …".
- Pinned by the diff-pane render assertion in `commitToolWindowGrouping.test.ts`.

---

## 4. Repo-state coverage (ADR-010 Layer 4)

| State                 | Grouping / unversioned / diff pane                          |
| --------------------- | ----------------------------------------------------------- |
| default (attached)    | ✅ covered (snapshot + property)                            |
| detached HEAD         | grouping/unversioned are HEAD-state-orthogonal (operate on  |
|                       | working-tree status, not refs); no special-casing needed.   |
| in-progress merge     | conflicted files render with status `U`; the before-commit  |
|                       | unresolved-merge check (see §A2) blocks committing them.    |
| empty repo            | empty changelist list → "No uncommitted changes." empty state |

Grouping + unversioned are pure functions over the file list and carry no
ref-shape dependency, so the detached-HEAD parser class of bug (Wave F) does
not apply here.
