# IntelliG → git4idea UI/UX Parity Audit & Plan

**Date:** 2026-06-15
**Scope:** Pure Git plugin parity. GitHub/GitLab/PR/MR integration explicitly **excluded**.
**Method:** Component-by-component code audit of IntelliG (`src/`) against the IntelliJ
`git4idea` plugin + `platform/vcs-impl` reference, cloned at
`/Users/chnmka/Documents/Projects/intellij-community` (sparse: `plugins/git4idea`,
`plugins/github`, `plugins/gitlab`, `platform/vcs-api`, `platform/vcs-impl`).

> Reference caveat: the IntelliJ platform graph-UI module `platform/vcs-log/` and the
> diff-merge viewer (`TextMergeViewer`/`MergeModelBase`) are **not present** in the sparse
> checkout. Claims about those surfaces are inferred from the git4idea action/provider side
> and the components' well-known public contracts.

---

## Baseline & scale

- IntelliG v0.1.6 (last change 2026-06-13). `displayName: "IntelliG"`, publisher `KaHoChan`.
- ~67,400 LOC production TypeScript (485 files), ~149,700 LOC tests (334 files, ~2.2:1).
- 222 commands declared in `package.json` (~106 wired to handlers), 25 keybindings,
  IntelliJ keymap preset.
- git4idea reference: ~139k LOC (1,068 files). `platform/vcs-impl` ~142k LOC. The plugin is
  glue atop the platform VCS framework (1,486 `openapi.vcs` imports, 834 `vcs.log`).

**Key finding:** the hard architecture is already built. The conceptually difficult IntelliJ
features that VS Code lacks natively — changelists, shelf-as-patch-store, interactive-rebase
editor, commit-graph log, 3-way merge — all exist in IntelliG. Remaining work is **fidelity,
not invention**. Two components (Reset; interactive-rebase todo plumbing) already *exceed*
git4idea.

---

## Maturity heatmap

| Component | Parity | Biggest gap |
|---|---|---|
| Reset | 🟢 ~95% (exceeds ref) | — |
| Merge dialog / rebase dialog / paused-rebase | 🟢 ~85% | `--onto`/`--root`, inline reword |
| Log & Commit Graph | 🟢 ~75% | ref-aware filters, manual cherry-compare |
| Rebase/Cherry-pick/Revert plumbing | 🟢 ~80% | inline reword/squash msg, `-m` revert |
| Shelf / Stash / Patches | 🟡 ~70% | per-file unshelve, binary, recycle bin |
| Branches & Tags | 🟡 ~65% | incoming/outgoing, tree HEAD/favorites, tag dialog, worktrees |
| Commit & Changelists | 🟡 ~60% | **changelists don't drive commit**, before-commit checks |
| Blame / History / Diff | 🟡 ~55% | gutter heatmap, file-history graph + affected paths |
| Shell / Menus / Sync | 🔴 ~45% | no VCS menu, stub Incoming/UpdateInfo tabs, **Update Project** |
| **3-way Merge view** | 🔴 ~35% | read-only text columns vs editable diff editor |

---

## Decision (locked)

**3-way merge view → adopt VS Code's native merge editor** (`git.openMergeEditor` / open
unmerged URI). Collapses workstream B from ~months to ~weeks; removes the only major
reimplementation risk. Soft dependency on VS Code's built-in Git extension is accepted; the
current webview can be revived as a fallback if stripped-environment shipping is later needed.

---

# Component audits

## A. Commit & Changelists — 🟡 ~60% (highest product value)

**Status (implemented):**
- Commit dialog: message + empty-guard (`CommitDialog.ts:128-134`), amend
  (`:750-763`, prior msg from `getLog` `:407-423`), sign-off (`:466-468` → `RemoteOps.ts:46-48`),
  author override (regex `:189`, seeded `:294-303`, `--author=` `RemoteOps.ts:56-58`), recent-msg
  LRU (`:574-603`), `--no-verify` toggle (`:558-563`), partial staging UI (`:511-525`,
  `stageHunk`/`unstageHunk`/`revertHunk` `:806-986`).
- Commit tool window (behind `intellig.useCommitToolWindow`, default **false**, `:43-44`): Local
  Changes + Shelf tabs (`:1263-1299`); changelists render inside Local Changes (`:1333-1368`).
- Changelists: overlay persisted to `.git/intellig-changelists.json` v2 (`ChangelistService.ts:25-31,932`),
  create/delete/rename/setActive/move (`:338-641`), `git status` reconcile (`:665-743`).
- Staging (`StagingOps.ts`): stage/unstage (`:25-39`), hunk via `git apply --cached [-R]` (`:48-104`),
  `stageLines` synthetic patch (`:69-83,207-288`), `revertHunk` (`:118-127`), `revertFile` (`:136-144`).

**Critical gap — changelists are decoupled from the commit pipeline.** `performCommit` stages by
selected *file path*, ignoring changelist membership (`CommitDialog.ts:145-172`);
`intellig.changelist.commitOnly` is a toast stub (`changelistCommands.ts:203-216`). git4idea maps
each changelist's `Change`s to the git index at commit time
(`GitCheckinEnvironment.kt:339-352,446-498`). The overlay exists but does not drive what gets
committed. `IChangelist` also lacks `isActive` (`CommitToolWindow.ts:1209-1217` fakes active=default).

**Other gaps:**
- No before-commit check framework. git4idea: `GitCheckinHandlerFactory.kt:55-516`
  (user.name-undefined, unresolved-merge, CRLF, large-file, detached-root, bad-filename) +
  platform Reformat/OptimizeImports/TODO/CodeAnalysis. IntelliG has only `--no-verify` + a disabled
  "coming soon" stub (`CommitDialog.ts:622-624`).
- Partial/line staging is one-shot patch synthesis (`StagingOps.ts:207-288`), no live
  `LineStatusTracker`, no per-changelist inclusion model; deletions explicitly approximate (`:233-254`).
- Flat Local Changes list — no directory/module/repository grouping (git4idea `ChangesGroupingPolicy`).
- No embedded diff-preview pane in tool window (`updateDiffPreview` posted `:687-705`, no surface).
- **Wiring bug:** webview posts `intellig.addToVcs` (`CommitToolWindow.ts:940`), registered command
  is `intellig.explorer.addToVcs` (`explorerCommands.ts:465`) — Add-to-VCS is a no-op.
- Commit-and-push delegates blindly to `intellig.push` (`:779`); no `GitPushAfterCommitDialog`.
- No multi-file Rollback dialog (`RollbackChangesDialog`/`RollbackWorker`).

**Work (ordered):** (1) thread `changelistId` into `performCommit`; implement real `commitOnly`; add
`isActive`. (2) `ICheckinHandler` framework + port cheap checks (user.name, unresolved-merge first).
(3) fix Add-to-VCS wiring + unversioned-files node. (4) grouping + diff-preview pane. (5) promote tool
window default-on once 1-4 land. (6) live line-status tracker + per-changelist partial commit (large).
(7) Commit-and-Push dialog. (8) Rollback dialog.
**Files:** `src/commits/CommitDialog.ts`, `CommitToolWindow.ts`, `src/changelists/ChangelistService.ts`
+ `interfaces/IChangelistService.ts`, `src/git-core/ops/StagingOps.ts`, `RemoteOps.ts`,
`src/commands/registration/changelistCommands.ts`.
**Dep:** Phase 0b. **Standalone** otherwise (overlay is git-source-of-truth, no host coupling).

## B. 3-way Merge view — 🔴 ~35% → 🟢 (native editor adoption)

**Status:** custom **read-only** webview (`MergeView.ts:92-101`); three side-by-side `<pre>` columns
(`_generatePanesHtml:1060-1156`) — no diff alignment, no syntax highlight, no editable result, no
synced scroll. Conflict marker parser handles diff2+diff3 (`_parseConflictMarkers:428-497`).
`git show :1:/:2:/:3:` fetched (`:375-377`) but **never rendered**. Accept current/incoming/both
(`:141-187`); "both" order hardcoded current-then-incoming (`:559/:618`); manual edit falls back to
current (`:561-565`). One-sided non-conflicting apply (`identifyNonConflictingConflicts:1196-1241`) is
good but not git4idea's "both sides" single action. Resolve dialog `ResolveConflictsDialog.ts` (file
list, Accept Yours/Theirs via `git checkout --ours/--theirs` `ConflictResolutionService.ts:457-524`,
Abort/Continue/Skip).

**Reference:** IntelliJ merge = full editable 3-pane diff editor (`TextMergeViewer` via
`DiffManager.showMerge`, `MultipleFileMergeDialog.kt:537`): editable center buffer, per-hunk gutter
accept, word-diff, synced scroll, binary-merge, magic-resolve.

**Work (locked: native editor):** route conflicts to VS Code built-in `mergeEditor` /
`git.openMergeEditor` in `ConflictResolutionService.ts:131-198` + `MergeView.show`; keep
`markResolved`→`git add` on completion; gut webview rendering; `intellig.merge.*` commands
(`package.json:304-345`) become thin wrappers. Optionally retain webview as fallback.
**Files:** `src/conflicts/MergeView.ts`, `ConflictResolutionService.ts`, `package.json`.
**Standalone.** Introduces soft dep on built-in Git extension (accepted).

## C. Shell / Menus / Sync — 🔴 ~45% (broad surface)

**Status:** 152 commands declared (~106 wired), all `category: IntelliG` (palette-visible, no `when`
gating). Branch-tree context menus keyed on `viewItem` with IntelliJ-ordered groups
(`package.json:666-942`). Explorer/editor/lineNumber submenus (`:944-1079`) — gutter blame Options menu
is the strongest 1:1 mapping. Push dialog near-complete (force-with-lease default, bare `--force`
disabled on `intellig.protectedBranches`, error classification, per-row retry). Status bar
(`StatusBarService.ts`): branch + ahead/behind `↑N ↓M` (`:382-392`), detached (`:367`), empty-repo
(`:374`), in-progress verb prefix (`:455-471`). Separate `InProgressStatusBar.ts` (priority 99).
Pull (`PullDialog.ts`): `--rebase/--ff-only/--no-ff` mutex (`:43`) + `--squash/--no-commit/--no-verify`
(`:46`). AutoFetch honors interval+`fetchTags`. Notifications categorized with recovery actions.

**Gaps:**
- **No VCS menubar/menu.** git4idea injects `Git.MainMenu`/`Git.Menu`/`Git.ContextMenu` into
  `VcsGroups`/`VcsGlobalGroup` (backend xml L151-307). VS Code has no menubar VCS injection — must
  remap to palette/title/submenus. No home for: Merge, Rebase, Reset (top-level), Configure Remotes,
  Clone, Unshallow, Working Trees, Uncommit, Reword, Fixup/Squash-into, Init.
- `view/title` is empty `[]` (`:943`) — no Fetch/Pull/Push/Update/Refresh/branch buttons on tool-window
  header. git4idea `Git.Stage.Toolbar` (xml L436-446) has no counterpart.
- **Incoming & UpdateInfo tabs are no-op stubs** (`IncomingTab.ts:11-17`, `UpdateInfoTab.ts:10`);
  tabbed layout default-off (`useTabbedGitToolWindow` false, `config.ts:11`).
- **Update Project hardcoded:** `intellig.updateProject` (`commitRepoCoreCommands.ts:288-335`) does
  preflight guard + unconditional `fetch({all,prune})` + `pull({rebase:true})`. No Merge/Rebase dialog,
  no BRANCH_DEFAULT, no multi-root, no Update Info summary. git4idea: `GitUpdateOptionsDialog` +
  `GitUpdateProcess` across roots + Update Info tree.
- Status-bar click only focuses Incoming tab (`:153`), not an actionable branch popup
  (`setClickAction('branch-popup')` exists `:506` but unused).
- Console: `showConsole()` is a no-op (`ConsoleService.ts:194-196`); no console in default 2-panel layout.
- Keymap: `ctrl+alt+z` double-bound (unstage `:1397-1402` vs revert `:1452-1457`); `ctrl+t`→pull instead
  of Update Project; no `ctrl+alt+k` commit-and-push; `alt+\`` preset conflates VCS-Operations-Popup with
  branch popup. `KeymapService.ts` hardcoded lists (L9-152) drift from `package.json` (source of truth).
- Pull missing `--autostash`. Push missing per-commit "Push up to here" (`Git.PushUpToCommit` xml L46).
- No `vscode.scm` provider integration (custom webview tool window instead).

**Work (ordered):** (1) fix keymap conflicts/semantics [package.json only]. (2) actionable status-bar
branch widget. (3) populate `view/title`. (4) implement Incoming tab. (5) **Update Project dialog +
Update Info tab** [biggest]. (6) `--autostash`. (7) log-menu parity (reword/fixup/squash/uncommit/
push-up-to-here). (8) restore Console surface. (9) structured push/update notifications with deep-links.
(10) enable tabbed layout default-on once 4-5 land.
**Files:** `package.json`, `src/ui-shell/{KeymapService,StatusBarService,ConsoleService,NotificationService}.ts`,
`src/sync/{PullDialog,updateProject}.ts`, `src/git-core/gitToolWindow/tabs/{IncomingTab,UpdateInfoTab}.ts`,
`src/commands/registration/commitRepoCoreCommands.ts`.
**Dep:** Phase 0a (Incoming, status badge), 0c (keymap).

## D. Branches & Tags — 🟡 ~65%

**Status:** sectioned branch popup (Favorites→Recent→Local→Remote→Tags, `BranchPopup.ts:211-396`),
current `●`, ahead/behind, upstream, per-row favorites, action submenus (local `:496-567`, remote
`:431-490`, tag `:573-616`). Branch tree (`BranchTreeProvider.ts`): Local/Remote/Tags, real path nesting
(`:640-745`), detached-HEAD row (`:122-131`). Context-menu handlers (`BranchContextMenuCommands.ts`):
checkout w/ dirty-tree fallback (`:360-456`), new-branch (`:461-526`), merge/rebase routing
(`:531-722`), rename/delete two-tier (`:759-872`), checkout-and-rebase (`:1071-1217`), track-branch
(`:1641-1736`). New Branch dialog (`NewBranchDialog.ts`) with validation. New Tag flow (two input boxes,
`commitHelpers.ts:163`). Ops (`BranchOps.ts`, `StashTagHistoryOps.ts`) injection-hardened.

**Gaps:**
- No incoming/outgoing arrows (git4idea `GitBranchIncomingOutgoingManager` — absent in IntelliG, grep
  zero hits).
- Popup: no header actions (Fetch/New Branch/New Tag), no settings toggles (Group-by-dir/Show-recent/
  Show-tags/Sync-across-repos — `GitBranchesPopupHeaderActions.kt`), flat QuickPick vs `FilteringTree`,
  no "Common" multi-repo section. Local submenu omits Update / Show Diff / worktree / pull entries.
- Tree: no HEAD root node (git4idea `BranchesTreeModel.kt:215`), no favorites/star, no incoming/outgoing
  arrows, no multi-repo per-repo grouping (`:127-131`), no search/multi-select, no expand-state persist.
- **No annotated-tag dialog** — two plain input boxes (`commitHelpers.ts:167-185`) vs `GitTagDialog.java`
  (root combo, reference+Validate, Force, multiline message).
- `deleteRemoteTag` + `getMergedBranches` ops exist but **have no UI caller**.
- **No worktree create/open** anywhere (git4idea `Git.CreateNewWorkingTree`, `workingTrees/`).
- New Branch dialog: no conflict-aware validation (remote/dir/local clash — `GitBranchValidator.kt:36-65`),
  no multi-repo combobox, no name autocompletion, no HEAD-name guard.

**Work (ordered):** (1) i/o foundation + arrows. (2) popup header + toggles + align local submenu.
(3) tree HEAD+favorites+multi-repo. (4) New Tag dialog. (5) wire remote-tag-delete + per-remote push +
delete undo. (6) conflict-aware branch-name validation + multi-repo. (7) worktree support. (8) tag
submenu correctness (Merge-into-Current).
**Files:** `src/branches/*`, `src/git-core/ops/{BranchOps,StashTagHistoryOps}.ts`,
`src/commands/registration/commitHelpers.ts`, `package.json`.
**Dep:** Phase 0a. **Standalone** (clean reimpl, not a binding).

## E. Shelf / Stash / Patches — 🟡 ~70%

**Status:** shelf correctly modeled as **git-independent patch store** (`.git/intellig-shelf.json`,
`ShelfService.ts:33-39,926`), matching IntelliJ's `ShelveChangesManager` architecture (NOT git stash).
Shelve/unshelve incl. silent variants, rename, delete, restore-applied, preview, create/import patch
(`ShelfView.ts`). Stash = thin wrapper over native `git stash` (`StashTagHistoryOps.ts`): create/apply/
pop/branch-from/rename(emulated store+drop `:137-183`)/drop/view. Apply Patch dialog (`ApplyPatchDialog.ts`):
file/clipboard, strip `-p`, base-dir, `git am`, preview, conflict handoff. `PatchService.ts`:
`--index --3way`, `--check`, reverse, am fallback.

**Gaps:**
- No per-file/partial unshelve — `ShelfService.unshelve` always iterates all `shelfItem.files`
  (`:409-492`). git4idea `unshelveChangeList(...List<ShelvedChange>...)` (`ShelveChangesManager.java:716-760`).
- No per-file shelve from changelist (`IShelveSelection.changelists` unimplemented, `:743`).
- No "Show Diff with Local Changes" — static patch text only (`ShelfView.ts:538-563`); git4idea
  `DiffShelvedChangesWithLocalActionProvider.java` (3-way vs working tree).
- **No binary file support** — text-diff only (`git diff` `:348`); binaries won't round-trip.
- No deleted-shelf recycle bin (`getRecycledShelvedChangeLists`/`restoreList`,
  `ShelveChangesManager.java:1180-1200`).
- Imported multi-file patch collapses to one synthetic `'imported-patch'` entry (`:612`).
- Apply Patch dialog whole-patch only (no per-file tree, no auto strip-detect).
- Stash apply always `--index` (`:84`), no reinstate-index toggle.

**Work (ordered):** (1) per-file unshelve. (2) parse imported patches per-file. (3) diff-against-local.
(4) binary support. (5) recycle bin. (6) target-changelist routing. (7) per-file Apply Patch tree +
auto strip. (8) stash apply-index toggle.
**Files:** `src/shelf/{ShelfService,ShelfView,StashView}.ts` + `interfaces/IShelfService.ts`,
`src/patches/{ApplyPatchDialog,PatchService}.ts`, `src/git-core/ops/StashTagHistoryOps.ts`.
**Standalone** (light ChangelistService dep for #6).

## F. Blame / History / Diff — 🟡 ~55%

**Status:** blame service (`BlameService.ts`) `git blame --porcelain` with `-w`/`-M`/`-C -C`
(`:261-280`), 30s cache, previous-revision resolve (`:352-388`). Inline provider (EOL decoration,
hover, 4-bucket fade `:511-530`), gutter provider (200px column, 7 age brackets foreground-alpha
`:32-40`, visible-range render). Options source (3 booleans + hidden-revision). File history tab
(`HistoryTab.ts` + `historyHtml.ts`): list, follow-renames, branch dropdown, compare-with-local,
diff-revisions (`:388-428`). Diff delegated to `vscode.diff` + `intellig-git:` content provider.

**Gaps:**
- **Gutter heatmap is fake** — foreground alpha fade, not IntelliJ's interpolated *background* gradient
  (`AnnotationsSettings.java:18-72`: 5 ColorKeys, ORDER + AUTHOR modes, `ShowAnnotationColorsAction`).
- `blameAnnotationStyle` enum (`inline|gutter|both`) has **no `off`** and **nothing consumes it**
  (`package.json:1192-1201`); providers only toggle manually (`registerViews.ts:753`).
- No toggleable aspect columns (Author/Date/Revision — `ShowHideAspectAction`), no author-name-format
  (`ShortNameType.kt`).
- No "show affected paths" from blame/history (`GitFileAnnotation.showAffectedPaths:257-283`,
  `ShowAllAffectedGenericAction`).
- No inline-diff-on-hover (`InlineDiffFromAnnotation.java`).
- File history: no graph, no details/message pane, no get-version (restore revision), line-history not
  actually line-scoped (`blameEditorCommands.ts:185-206` fetches whole file).
- Diff viewer: no whitespace/highlight-policy UI (delegates to `vscode.diff`).

**Work (ordered):** (1) background heatmap + ORDER/AUTHOR color modes. (2) wire `blameAnnotationStyle`
+ add `off`. (3) aspect columns + author-name format. (4) affected-paths command + history panel.
(5) history details pane + graph (reuse `commitGraph.ts`). (6) line-scoped history (`git log -L`) +
get-version. (7) diff ignore/highlight options. (8) inline-diff-on-hover (optional, high-effort).
**Files:** `src/blame/{GutterBlameProvider,InlineBlameProvider,BlameOptionsSource,BlameService}.ts`,
`src/git-core/gitToolWindow/tabs/HistoryTab.ts` + `html/historyHtml.ts`, `src/git-core/ops/StashTagHistoryOps.ts`,
`src/commands/registration/blameEditorCommands.ts`, `package.json`.
**Standalone** (graph reuse is in-repo).

## G. Log & Commit Graph — 🟢 ~75%

**Status:** per-row inline **SVG** graph (`utils/graphRenderer.ts:720`, IntelliJ-matching geometry
`:47-57`, cubic-bezier edges, dashed off-window stubs); lane algorithm (`commitGraph.ts:346`, HEAD spine
pinned `:561-596`, lane reuse `:199-244`); optimized variant for >5000 commits (`optimizedCommitGraph.ts`).
Node glyphs, ref badges (local green / remote violet / HEAD yellow / tag, collapsed +N —
`stylesBuilder.ts:888-1073`), details panel (`htmlBuilders.ts:280-364`), filter bar (4 free-text/date
inputs `GitToolWindowProvider.ts:2918-2937`), jump-to-hash (`jumpToHash.ts:46`), cherry-pick highlight
(upstream auto-computed `GitService.ts:1439-1444`, `registerViews.ts:340-378`), ~20-action context menu
(`htmlBuilders.ts:201-241`), full multi-select. Multi-repo = single-select switcher (not merged).

**Gaps:**
- Branch/author filters are free-text, not ref-aware dropdowns (`GitRefManager.groupForBranchFilter`).
- No regex/case toggles (`--extended-regexp`/`--fixed-strings`/`--regexp-ignore-case`), no parent/
  first-parent/range/simplify-merges filters (`GitLogProvider.kt:462-579`).
- Cherry-pick highlight is upstream-only/always-on; no manual "compare with branch X" (`DeepComparator.kt`,
  `HighlightCherryPickedCommitsAction.java`).
- No GPG signature column (`GitCommitSignatureStatusProvider.kt`).
- No fixup!/squash!/amend! message links (`GitLinkToCommitResolver.kt:50-66`).
- No merged multi-root log; no incoming/outgoing / push-up-to-commit; no detached-HEAD ref grouping;
  no go-to-parent/child navigation; no favorites ordering.

**Work (ordered):** (1) ref-aware branch+author filter dropdowns. (2) match-mode toggles. (3) range/
parent/first-parent/simplify-merges filters. (4) manual cherry-compare mode + branch picker. (5) GPG
column. (6) fixup!/squash! links. (7) detached-HEAD badge. (8) wire Incoming tab + push-up-to-commit.
(9) merged multi-root log (large). (10) go-to-parent/child nav.
**Files:** `src/git-core/gitToolWindow/{GitToolWindowProvider,provider/*,tabs/IncomingTab}.ts`,
`src/git-core/GitService.ts`, `src/registration/registerViews.ts`, `package.json`.
**Dep:** Phase 0a (incoming/outgoing).

## H. Rebase / Cherry-pick / Revert (plumbing, non-merge-view) — 🟢 ~80%

**Status:** interactive rebase editor (`RebaseEditor.ts`): HTML5 DnD reorder (`:826-897`), per-commit
action select (`:463-487`), applied to git's **real** todo via `GIT_SEQUENCE_EDITOR` shim
(`rebaseTodoEditor.ts` + `rebaseTodo.ts:transformRebaseTodo`, preserves label/reset/merge/exec/
update-ref) — faithful to `GitInteractiveRebaseFile`. Rebase dialog (`RebaseDialog.ts`): onto + interactive
+ `--rebase-merges`/`--update-refs`/`--keep-empty`/`--autosquash` (`:88-118`), in-progress guard,
orphan auto-abort. Paused-rebase recovery (`RebaseProgressView.ts`): continue/abort/skip, reword handoff.
Merge dialog (`MergeDialog.ts`): `--ff-only`/`--no-ff`/`--squash`/`--no-commit`/`--no-verify`/
`--allow-unrelated-histories` + `-m`, mutex resolver (`:70-99`) — near-complete vs `GitMergeOption`.
Reset (`ResetDialog.ts`): Soft/Mixed/Hard/Keep (matches `GitResetMode`), Smart Reset stash→reset→unstash
(`:43-61`), protected-branch guard (`:439-445`) — **exceeds git4idea**. Cherry-pick/revert
(`CherryPickRevertOps.ts`): cherry-pick `--no-commit`/`-x`/file-subset (`:28-102`), abort/continue,
revert `--no-edit` only.

**Gaps:**
- No inline reword/squash message editing in the editor (deferred to paused-rebase one-at-a-time;
  `rebaseTodo.ts:136-142` keeps OLD subject).
- `--onto <newbase>` and `--root` not surfaced (`GitRebaseOption.ONTO/.ROOT`; deliberate `:84-87`).
- Revert is `--no-edit` only — no `-m` mainline for merge commits, no edit-message, no multi-commit.
- Cherry-pick no `-m`/`--edit` for merge commits.

**Work (ordered):** (1) inline reword/squash message box. (2) surface `--onto`/`--root`.
(3) revert/cherry-pick `-m` + edit-message dialog. (4) "accept non-conflicting from both sides" (shared
w/ B's resolve dialog).
**Files:** `src/rebase/{RebaseEditor,RebaseDialog}.ts`, `src/git-core/{rebaseTodo,RebaseService}.ts` +
`interfaces/IRebaseService.ts`, `src/git-core/ops/CherryPickRevertOps.ts`, `package.json`.
**Standalone.** Note fragility: interactive rebase depends on spawning the Electron binary as node
(`ELECTRON_RUN_AS_NODE=1`) — worth a fallback.

---

# Execution plan

## Phase 0 — Shared foundations (SERIAL, ~1 week, BLOCKING)

Build before fan-out or each stream stubs its own.

- **0a. Incoming/Outgoing manager** — `git rev-list --count @{u}...HEAD` per branch. Absent today.
  Blocks D (arrows), C (status badge, Incoming tab), G (incoming/outgoing).
  → new `src/git-core/ops/IncomingOutgoingOps.ts` + `IGitService` method.
- **0b. `isActive` on `IChangelist`** — tree fakes active=default (`CommitToolWindow.ts:1209-1217`).
  Blocks A. → `src/changelists/interfaces/IChangelistService.ts` + `ChangelistService.ts`.
- **0c. KeymapService de-drift** — delete/regenerate `src/ui-shell/KeymapService.ts` hardcoded lists
  from `package.json` (source of truth). Blocks C cleanly.
- **0d.** RESOLVED — native merge editor.

## Wave 1 — 8 parallel agents (disjoint directories)

```
Phase 0 (serial) ──┬─ A Commit/Changelists   (dep 0b)   src/commits, src/changelists
                   ├─ B Merge view           (—)        src/conflicts (merge)
                   ├─ C Shell/Menus/Sync      (dep 0a,0c) src/ui-shell, src/sync
                   ├─ D Branches & Tags       (dep 0a)   src/branches
                   ├─ E Shelf/Stash/Patches   (—)        src/shelf, src/patches
                   ├─ F Blame/History/Diff    (—)        src/blame, history tab
                   ├─ G Log & Commit Graph    (dep 0a)   src/git-core/gitToolWindow
                   └─ H Rebase/Cherry/Revert  (—)        src/rebase, CherryPickRevertOps
```

**Coordination rule:** `package.json` `contributes` is the only shared file — **additive-only** edits
per agent, no reordering, to avoid merge conflicts.

## Effort estimate

**~1.5–2.5 engineer-years** remaining to faithful pure-Git parity (down from ~3 once merge view is
native). Critical path: **C** (Update Project + tool-window tabs) and **A** (changelist-driven commit +
check framework). Everything else is parallelizable polish on already-working surfaces.

---

## Source references

- IntelliG: `/Users/chnmka/Documents/Projects/intellig-main` (v0.1.6).
- git4idea + platform: `/Users/chnmka/Documents/Projects/intellij-community`
  (sparse: `plugins/git4idea`, `plugins/github`, `plugins/gitlab`, `platform/vcs-api`,
  `platform/vcs-impl`; master @ `e38c248090a2`).
- Entry point that triggered the audit: `plugins/git4idea/frontend/src/com/intellij/vcs/git/
  frontend/GitFrontendStartupActivity.kt` (14-line bootstrap; real plugin is in `backend/`).
