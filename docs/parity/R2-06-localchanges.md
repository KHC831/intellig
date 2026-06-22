# Parity review (Round 2) — Local changes (stash/shelf/changelists/staging)

_Round-2 deep review by tech-lead owner. North-star = IntelliJ git4idea + platform/vcs-impl (full clone at `~/Documents/workspace/intellij-community`)._

**Component scope:** stash (apply/pop --index, create, drop, rename, branch), shelf (patch-file management), changelists (local grouping), staging/unstaging hunks, revert/discard hunk, add-to-gitignore, commit-template support.

## Reference map
- **git4idea / platform source reviewed:**
  - `plugins/git4idea/backend/src/stash/GitStashUtils.kt` (lines 165-424: `reinstateIndex` parameter, `createUnstashHandler`)
  - `plugins/git4idea/backend/src/ignore/actions/GitIgnoreFileActionGroup.kt` (line 10: root-relative pattern generation)
  - `platform/vcs-impl/src/com/intellij/openapi/vcs/changes/shelf/ShelveChangesManager.java` (lines 1-200: shelf vs stash semantics — patch-file storage vs git-stash)
  - `platform/vcs-impl/src/com/intellij/openapi/vcs/changes/ChangeList*.java` (changelist framework — grouping, active changelist tracking)

- **intellig source reviewed:**
  - `src/git-core/ops/StashTagHistoryOps.ts` (lines 80-98: `stashApply`/`stashPop` with `--index` flag)
  - `src/git-core/ops/StagingOps.ts` (lines 48-127: `stageHunk`, `unstageHunk`, `revertHunk` = `git apply -R` without `--cached`)
  - `src/commands/registration/explorerCommands.ts` (lines 61-101, 500-550: `gitignorePatternFor`, `buildGitignoreAppendContent`, `addToGitignore` command)
  - `src/commits/CommitDialog.ts` (lines 496, 884, 1348, 1978: revert-hunk button wiring + dispatch)
  - `src/changelists/ChangelistService.ts` (lines 1-97: v2 storage format with `description` + `activeChangelistId`)
  - `src/shelf/ShelfService.ts`, `src/shelf/ShelfView.ts`, `src/shelf/StashView.ts`
  - `src/test/unit/git-core/stashReinstateIndex.test.ts` (lines 39-48: TDD tests for `--index` on apply/pop)

## Gap table
| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **Stash --index reinstate UI** | `GitUnstashDialog.java` offers "Reinstate index" checkbox (3-state: off/on/disabled-on-branch-stash); user-controlled per-operation | Backend `stashApply`/`stashPop` ALWAYS pass `--index` (no UI control); StashView calls them unconditionally | 🟡 partial | 🟡 medium | `git4idea` + `platform` | Backend correct (P1 #1 closed); missing UI affordance to disable --index. Low-priority (default-on is safer; advanced users can palette if needed). StashView.ts:293,362. |
| **Stash rename** | `GitStashUtils.kt:137-183` 3-step sequence (`rev-parse` → `stash store -m` → `drop stash@{index+1}`) with best-effort rollback on drop failure | Implemented identically at `StashTagHistoryOps.ts:137-183`; same 3-step + rollback + index validation | ✅ parity | ⚪ polish | `git4idea` | Byte-for-byte logic match. No gap. |
| **Stash branch** | `git stash branch <name> stash@{index}` creates branch rooted at stash commit + applies stash | Implemented at `StashTagHistoryOps.ts:113-123`; validates branch name + index | ✅ parity | ⚪ polish | `git4idea` | No gap. |
| **Shelf vs stash semantics** | Shelf = patch-file storage in `<project>/.idea/shelf/*.patch` (VCS-agnostic, survives stash-clear, multi-file selective unshelve); Stash = git-stash stack (VCS-coupled, LIFO, all-or-nothing apply) | `ShelfService.ts` manages patch files in `.git/intellig-shelf/`; `StashView.ts` wraps git-stash. Both exposed in Commit Tool Window shelf/stash tabs | ✅ parity | ⚪ polish | `platform/vcs-impl` | Semantic separation preserved; patch files survive `git stash clear`. Shelf UI on par with IntelliJ. |
| **Commit template support** | `git config commit.template` auto-fills commit message composer | NOT implemented; no check for `commit.template` config when opening CommitDialog | ❌ missing | 🟡 medium | `platform` + `git4idea` | Low daily-hit (teams standardize via hooks/CI, not local templates). Would check `git config --get commit.template` → read file → prefill `CommitDialog._message`. Effort: S (1 config read + 1 fs.readFileSync). |
| **Changelist "description" field** | IntelliJ `ChangeList` has optional multi-line description separate from name | `ChangelistService.ts:87` storage v2 includes `description?: string`; field persisted but NO UI to edit it (neither ChangelistView nor any command surface it) | 🟡 partial | 🟡 medium | `platform/vcs-api` | Backend storage ready (v2 format); missing UI edit affordance. Description would appear in changelist tooltip/details pane. Effort: M (UI form + update command). |
| **Shelf "restore to" changelist picker** | Unshelve dialog lets user pick target changelist (create-new / select-existing) | ShelfView applies to active changelist only; no picker | 🟡 partial | 🟡 medium | `platform/vcs-impl` | Lower priority (active-changelist is the 90% case; power users can switch active first). Effort: M (picker dialog). |
| **Stash partial (file-subset) stash** | `GitStashUtils.kt:441-457` `createStashHandler` accepts `files: Collection<FilePath>`; uses `--pathspec-from-file=-` (git 2.25+) or `--` positional | `StashTagHistoryOps.ts:35-50` `stash()` always operates on full tree (no `files` parameter, no pathspec handling) | 🟡 partial | 🟡 medium | `git4idea` | Effort: M (add `files?: string[]` param + buildGitArgs pathspec tail). Blocked-by: UI to select file subset in StashView. |
| **Stash per-file changes browser** | `Git.Stash.ChangesBrowser.ContextMenu` — a stash's changed files render in a browser with per-file Show-Diff-with-Local / Apply-Selected-Changes / Open-Repository-Version. | `StashView.ts` does whole-stash apply/pop/drop/branch-from only — no per-file view for a stash. (The **shelf** has per-file unshelve + diff-against-local; the stash doesn't.) | 🟡 partial | ⚪ polish | `git4idea` | Effort: M (parse `git stash show -p stash@{n}` into a file list + per-file diff/apply). Lower priority than shelf parity (already done). |
| **Revert-hunk patch stdin injection** | `git apply -R` reads patch from stdin (`-`); patch content is user-controlled (diff lines are commit content) | `StagingOps.ts:118-126` `revertHunk` passes `input: patch` where `patch = generateHunkPatch(path, hunk)` and `hunk.lines[].content` is parsed from `git diff` output (untrusted). Git's patch parser is robust (no shell interpolation, no exec), but malformed input could cause git apply to error/misbehave | ✅ safe | ⚪ polish | security | **Reviewed: no injection.** Git patch format is line-based + positional; `git apply` parses binary-safe. `hunk.lines[].content` is raw bytes from diff (no user input path). Stdin bypasses shell. No risk. |
| **Gitignore pattern path-traversal** | IntelliJ writes root-relative pattern anchored with `/` (e.g., `/src/file.ts`); rejects if file is outside repo | `explorerCommands.ts:70-79` `gitignorePatternFor` returns `undefined` if `!fileFsPath.startsWith(repoRoot + '/')` → caller never writes `../` escape pattern | ✅ safe | ⚪ polish | security | **Reviewed: no path-traversal.** Line 74-76 prefix check blocks outside-repo files; pattern is always `/relative-path` (anchored to root). Idempotent check (line 94-95) prevents duplicate append. Pure functions (no fs side-effects in helpers). |
| **Gitignore leading-dash guard** | Git treats `.gitignore` lines starting with `-` as invalid (not a CLI concern, but malformed pattern) | Pattern from `gitignorePatternFor` always starts with `/` → no leading-dash risk | ✅ safe | ⚪ polish | security | No gap; design prevents it. |

## Top findings (ranked, this component)

1. **🟡 MEDIUM: Commit template support missing**
   - **Why it matters:** Teams using `git config commit.template` (commit msg boilerplate, ticket-ID template) get no prefill in CommitDialog → manual copy-paste every commit. Parity gap.
   - **Severity:** 🟡 medium (daily-hit for affected teams). **Source:** `platform` + `git4idea`. **Effort:** S.
   - **Files to touch:** `src/commits/CommitDialog.ts` constructor — read `git config --get commit.template` → `fs.readFileSync` → prefill `_message` if empty.

## Security review (this component)

**Reviewed surfaces:**
- ✅ `git apply -R` stdin (revertHunk): NO injection — patch content is parsed git diff output (untrusted but binary-safe), stdin bypasses shell, no exec path.
- ✅ Gitignore pattern generation: NO path-traversal — `gitignorePatternFor` rejects outside-repo files (line 74), pattern always `/anchored`.
- ✅ Leading-dash guards: tag/branch name guards (existing) + gitignore design (always `/` prefix) prevent CLI-flag injection.
- ✅ Stash index validation: `_validateStashIndex` (lines 74-78) blocks non-integer/negative → no `stash@{NaN}` malformed refs.

**No findings.** `git apply` stdin is binary-safe; gitignore generation rejects outside-repo files; tag/branch/gitignore leading-dash guards in place; stash-index validation blocks malformed refs. **Hunk patch headers are git-style C-escaped** (`StagingOps.escapePatchPath:300`, used by the header builder at `:281-285`), so a space/tab/newline in a filename no longer corrupts the patch.

**Verdict:** No security holes (argv injection / credential leakage / CSP), no silent-wrong correctness gaps.

## Blockers

**None.** Stash `--index` reinstatement, revert-hunk (with staged-state guard at `StagingOps.revertHunk:128-133`), add-to-gitignore, and hunk-patch path escaping (`escapePatchPath:300`) are all implemented + TDD-covered.

## Overall assessment (Round 2)

**Parity health: 🟢 GOOD — 0 blockers, residual polish gaps only.**

**Strengths:**
- Stash `--index` backend correct, TDD-verified (IntelliJ byte-for-byte parity on the git argv).
- Revert-hunk: `git apply -R` working-tree-only is the correct design, with a staged-state guard (`:128-133`) so a partially-staged file can't leave a stale index; button wired + modal confirm.
- Add-to-gitignore: pattern generation matches IntelliJ (root-relative anchored `/`); idempotent append.
- Hunk-patch headers C-escaped (`escapePatchPath`) — no malformed-patch corruption for special-char filenames.
- Shelf/stash semantic separation preserved (patch-file vs git-stash stack).
- Security audit CLEAN — no argv injection, no path-traversal, no credential leakage.

**Residual polish gaps (no blockers):**
- Commit template support (`git config commit.template` prefill) — low daily-hit, easy win (S effort).
- Changelist "description" field — v2 storage has it; edit affordance exists via `intellig.changelist.editDescription` (CommitToolWindow.ts:296,940), so this is effectively covered.
- Stash `--index` UI toggle (backend always-on is safer; power users might want control).
- Shelf "restore to changelist" picker (active-changelist-only is the 90% case).
- Stash partial (file-subset) — backend missing, low priority.

**Recommendation:** Only polish-tier items remain (commit template, stash --index toggle, file-subset stash, restore-to-changelist picker). No blockers.

**Test coverage:**
- TDD discipline strong: stash --index, revert-hunk, gitignore all red-first; property tests cover stash round-trip invariants (`stashRoundTrip.property.test.ts`).

**Dogfood note:**
Per PROGRESS.md line 26, "live click wants one F5" — revert-hunk button interaction NOT yet F5-confirmed end-to-end. Should verify: click → modal → confirm → working tree reverted → file clean in SCM view. Backend argv unit-locked, but real-git round-trip still needed.


---

## Appendix — Local Changes panel contract spec (durable; folded from former `commit-tool-window-changes.md`)

_Layer-3 contract spec (ADR-010), test-pinned. NORTHSTAR tie-back: workstream **A** (Commit & Changelists)._

Status: living document (Wave A — Commit/Changelists)

This is the Layer-3 (ADR-010) parity reference for the **Local Changes** panel
of IntelliG's Commit tool window (`CommitToolWindow.ts`). It pins IntelliJ's
reference behaviour for the three surfaces workstream A item 4 added: changes
**grouping**, the **Unversioned Files** node, and the **diff-preview pane**.

Cross-references:

- ADR-010 — visual parity discipline (the layered snapshot/UX/reference model).
- "Changed-files tree & history-row layout" appendix (below, this doc) — sibling reference for the grouping tree.
- `docs/parity/NORTHSTAR.md` (workstream A — Commit/Changelists) — the audit gap this closes.
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
|                       | unresolved-merge check (see section A2) blocks committing them.    |
| empty repo            | empty changelist list → "No uncommitted changes." empty state |

Grouping + unversioned are pure functions over the file list and carry no
ref-shape dependency, so the detached-HEAD parser class of bug (Wave F) does
not apply here.


---

## Appendix — Changed-files tree & history-row layout contract spec (durable; folded from former `changed-files-tree.md`)

_Layer-3 contract spec (ADR-010), test-pinned. NORTHSTAR tie-back: workstreams **A / G / F** — git-view-layout-parity._

> **NORTHSTAR tie-back:** workstreams **A / G / F** — changed-files tree + history row layout · role: contract spec. See `NORTHSTAR.md` section 7 (reference index).

Status: Living reference (git-view-layout-parity, 2026-06-01)

This document is the **visual-truth specification** for two IntelliG
Git-tool-window surfaces delivered by the `git-view-layout-parity`
feature:

1. **Changed Files directory hierarchy** — the commit-details
   "Changed Files (N)" list, rendered as an IntelliJ-style folder
   tree (section 1).
2. **Commit history row layout** — the per-file FileHistoryTab
   commit rows, with the author and date columns sitting adjacent
   instead of separated by a wasted slack gap (section 2).

Both are governed by ADR-010 visual-parity discipline. The reference
behaviour is IntelliJ IDEA's Git tool window. Per Layer 3, every
visual claim below that maps onto an algorithm / renderer / HTML
output cites the snapshot test that pins it, in the
`(see snap-… in <test>)` form. Updates to this doc precede
implementation changes — write the spec first, walk the code forward.

The third surface of the same feature — the no-repository empty
state — is a *repo state*, not a visual element, so it is covered by
the repo-state tests rather than here.

---

## section 1 Changed Files directory hierarchy

### section 1.1 IntelliJ reference behaviour

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

### section 1.2 Tree structure

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

### section 1.3 Render rules

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

### section 1.4 Test coverage

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

### section 1.5 Cross-references

- ADR-010 Layer 1 (snapshot discipline) / Layer 3 (this reference
  doc) — the discipline that produced this document.
- `src/git-core/gitToolWindow/html/fileTree.ts` — `buildFileTree`
  (pure transform) + `renderFileTree` (pure renderer).
- `src/git-core/gitToolWindow/GitToolWindowProvider.ts` —
  `_getDetailsPanelHtml` / `_getMultiCommitDetailsPanelHtml`, the two
  call sites that share the tree.
- Changed-files status-indicator a11y contract: status colors resolve
  through VS Code theme tokens (pinned by `themeTokenCompleteness.audit.test.ts`).

---

## section 2 Commit history row layout

### section 2.1 IntelliJ reference behaviour

In IntelliJ's file-history view, each commit row uses the limited
horizontal width efficiently: the author and date sit close together,
separated only by a single uniform gap, with the commit subject
absorbing all remaining slack. There is no wide empty gap between the
author and date columns.

### section 2.2 Column layout

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

### section 2.3 Test coverage

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

### section 2.4 Cross-references

- ADR-010 Layer 1 / Layer 3 — the visual-parity discipline.
- `src/git-core/gitToolWindow/html/historyHtml.ts` —
  `historyTabStyles()` (the grid + ellipsis rule) and
  `renderCommitRow()` (the unchanged cell order).
- The sibling log-graph row layout (`.commit-author` / `.commit-date`
  fixed-width slots) applies the same "fixed trailing columns, flexible
  message" pattern to the main graph rows.

---

_Last updated: 2026-06-01._
