# Shelve Changes — IntelliJ Parity

> **NORTHSTAR tie-back:** Local Changes / Shelf (backs NORTHSTAR section 4b — Commit & Shelf). Companion to `R2-06-localchanges.md`.

**Scope:** the "Shelve Changes" surface — a dedicated dialog with a checkbox
list of changed files, a name/comment field, and a Shelve button.

## Reference mapping (IntelliJ → IntelliG)

| IntelliJ | IntelliG | IntelliJ path | IntelliG path |
|---|---|---|---|
| ShelveChangesAction | `intellig.shelve` command | platform/vcs-impl/.../shelf/ShelveChangesAction.kt | src/commands/registration/stashShelfCommands.ts |
| ShelveChangesCommitExecutor (over the commit change-selection dialog) | ShelveDialog | platform/vcs-impl/.../shelf/ShelveChangesCommitExecutor.java | src/shelf/ShelveDialog.ts |
| ShelveChangesManager.shelveChanges | ShelfService.shelve | platform/vcs-impl/.../shelf/ShelveChangesManager.java | src/shelf/ShelfService.ts |

## How IntelliJ does it (read from source)

`ShelveChangesAction` extends `AbstractCommitChangesAction` and returns a
`ShelveChangesCommitExecutor`. The executor's `getActionText()` is
**"Shelve Changes…"**, and its `CommitSession.execute(changes, commitMessage)`
calls `ShelveChangesManager.shelveChanges(changes, commitMessage, …)` then
activates the Shelf view. So shelve is the **commit change-selection dialog**
(a checkbox change tree + a message field used as the shelf comment) run with a
"Shelve Changes" button instead of "Commit" — a **separate dialog**, NOT the
docked Commit tool window.

## IntelliG implementation

A dedicated webview panel (`ShelveDialog`), NOT an overload of the Commit tool
window. Single source of truth: one `intellig.shelve` command opens the dialog
behind every entry point.

| Element | IntelliJ | IntelliG (ShelveDialog) | Status |
|---|---|---|---|
| Surface | Separate modal dialog | Separate webview panel | ✅ Match |
| File selection | Checkbox change tree | Checkbox list (one row per changed file) | ✅ Match (flat list, not a tree) |
| Single-file invoke | Pre-selects that change | Pre-checks only that file; others visible/unchecked | ✅ Match |
| Name / comment | Commit-message field reused as shelf comment | "Name:" field (the shelf name) | ⚠ Single-line, not a multi-line message |
| Action button | "Shelve Changes…" | "Shelve Changes" | ✅ Match |
| Empty guard | — | Shelve disabled until name set AND ≥1 file checked | ✅ Safer |
| Master checkbox | Tree root checkbox | "Changes" master checkbox + "N of M selected" | ✅ Match |
| Post-shelve | Activates Shelf view | shelve() fires onDidChangeShelf (shelf UI refreshes) + git tool window nudge | ✅ Equivalent |

## Entry points (single source of truth)

All three open the same `ShelveDialog` via the `intellig.shelve` command:

1. **Command palette** `Shelve Changes…` → all changed files pre-checked.
2. **File right-click** (Explorer / editor IntelliG submenu) → that file pre-checked.
3. **Commit tool window** file row → "Shelve Changes…" → that file pre-checked
   (a file row carries both `path` and `changelistId`; the path wins so a single
   file is shelved, not the whole changelist).

A changelist-row "Shelve Changes" still shelves the whole changelist directly
(`intellig.changelist.shelve`), matching IntelliJ's changelist-scoped shelve.

## Known gaps / follow-ups

- Name field is single-line (IntelliJ reuses the multi-line commit message). The
  backend keys a shelf by a single `name`, so a single-line field is the honest
  mapping; a multi-line comment is a possible later enhancement.
- No per-hunk (partial) selection in the dialog yet — `ShelfService.shelve`
  supports `hunks`, but the dialog offers file-level checkboxes only (matches the
  stated requirement; per-hunk is a follow-up).
- The Shelf-list "Shelve New Changes…" action still uses the older two-step
  QuickPick (`ShelfView.showShelveDialog`); consolidating it onto `intellig.shelve`
  is a low-risk follow-up.
