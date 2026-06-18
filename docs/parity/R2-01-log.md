# Parity review (Round 2) — Log / Commit Graph

> **NORTHSTAR tie-back:** workstream **G** (Log & Commit Graph) · role: Round-2 deep audit. See `NORTHSTAR.md` section 7 (reference index).

_Round-2 deep review by tech-lead. North-star = IntelliJ git4idea + IntelliJ Platform VCS-log. Component owner: log/commit-graph tool window, graph rendering & edge routing, log filtering (filter bar, path/author/date/text filters), commit highlighting, log context menu._

## Reference map
- **git4idea / platform source reviewed:**
  - `platform/vcs-log/impl/src/com/intellij/vcs/log/ui/filter/VcsLogClassicFilterUi.kt` — filter UI (branch/user/date/structure/text/parent models)
  - `platform/vcs-log/impl/src/com/intellij/vcs/log/visible/filters/` — filter implementations
  - `plugins/git4idea/backend/src/log/GitLogProvider.kt` — git log command construction + filter parameter mapping
  - `plugins/git4idea/backend/src/log/command/GitLogCommandFilterer.kt` — filter argv assembly
  - `platform/vcs-log/impl/src/com/intellij/vcs/log/ui/VcsLogUiImpl.kt` — main log UI orchestration
  - `platform/vcs-log/graph/` — graph algorithms (lane assignment, edge routing, collapsing)

- **intellig source reviewed:**
  - `src/git-core/gitToolWindow/GitToolWindowProvider.ts:1–3300` — webview controller + message dispatch
  - `src/git-core/ops/StashTagHistoryOps.ts:290–349` — `getLog()` implementation
  - `src/git-core/gitToolWindow/provider/graphClusterBuilder.ts` — graph HTML rendering
  - `src/git-core/gitToolWindow/provider/htmlBuilders.ts` — details panel, file tree, context menu HTML
  - `src/git-core/gitToolWindow/provider/scriptBuilder.ts` — client-side behavior script
  - `src/git-core/commitGraph.ts` — commit graph data structure + topological sort
  - `src/utils/graphRenderer.ts` — lane assignment algorithm
  - `src/commits/CommitContextMenuCommands.ts:1–900` — log action handlers
  - `src/git-core/gitToolWindow/multiSelect.ts` — multi-selection menu state computation
  - `src/git-core/gitToolWindow/html/historyHtml.ts` — file history tab rendering

## R1 follow-up (verify each prior finding against current code)

_(No Round-1 report existed for this area — the NORTHSTAR document provided baseline gap enumeration. P1 gaps #5 (path filter) and several P3/UI items have landed since the initial enumeration per PROGRESS.md.)_

| R1 gap | R1 status | Current status (re-verified) | Commit that closed it (if any) | Notes |
|---|---|---|---|---|
| **P1 #5:** Log path-filter omits `--full-history --simplify-merges` | ❌ missing | ✅ closed | 9755ea6 (2026-06-14) | `StashTagHistoryOps.ts:336–340` now appends `--full-history`, `--simplify-merges`, `--`, `<path>` when `options?.path` present. TDD: 2 new tests in `getLogPathFilter.test.ts`. |
| **P1 #5 UI:** Filter bar is dead code (never emitted into DOM) | ❌ missing | ✅ closed | f946576 (2026-06-14) | `graphClusterBuilder.ts` now renders the 5-field filter bar (msg/hash, author, path, since, until) with data-action delegation, Enter-to-apply, HTML-escaped. TDD: 6 new unit tests. PROGRESS notes "live filtering still wants one F5 confirm" — backend wiring complete, F5 dogfood pending. |
| **P3:** Copy Commit Message action missing | ❌ missing | ✅ closed | 07e0cd8 (2026-06-14) | New `copyCommitMessage` LogContextAction + menu item + clipboard handler (multi-select joins with blank line). TDD: +1 test. IntelliJ `Vcs.Log.CopySubjectText` parity. |
| Commit highlighting on branch focus (visual indication) | 🟡 partial | 🟡 partial | (not yet) | `IExtendedLogState.focusedBranchName` + `_focusedPathHashes` field exists (:257, :294). `setFocusedBranch()` computes BFS path from branch tip to merge-base (:1583–1682). `onFocusedBranchPath` bool tagged on each `ICommitNode` in `generateCommitGraph`. BUT: highlighting CSS/class (`commit-row-dim`, `commit-row-bright`) not applied in `buildCommitRows`. Visual feedback incomplete. |
| Branch filter (filter log to single branch) | ❌ missing | ❌ missing | — | `ILogFilter` has no `branch` field. IntelliJ `BranchFilterModel` + `BRANCH_FILTER` in `VcsLogFilterCollection` not mirrored. UI filter bar has no branch dropdown. Backend `getLog()` supports `options?.ref` (single revision scope) but UI never passes it for filtering. |
| Date-range filter precision (calendar picker) | 🟡 partial | 🟡 partial | — | Backend `getLog()` supports `--since`/`--until` (:303–307). UI renders text inputs for since/until (:499–515 in stylesBuilder.ts). BUT: IntelliJ `DateFilterPopupComponent` has calendar pickers + presets ("Last week", "Last month") — we have bare text fields. Functional but not parity UI. |
| User/author filter (dropdown of known users) | 🟡 partial | 🟡 partial | — | Backend `getLog()` supports `--author` (:300). UI has single text input. IntelliJ `UserFilterPopupComponent` pre-populates a list of committers + supports "me" alias — ours is freetext only. Functional but minimal. |
| Text filter regex toggle | ❌ missing | ❌ missing | — | UI has single text input. Backend `getLog()` only has `--grep` (plain substring). IntelliJ `TextFilterModel` + `VcsLogTextFilterField` support case-sensitive / regex / match-whole-commit checkboxes. We have no regex mode. |
| "No merges" filter (--no-merges) | ❌ missing | ❌ missing | — | Not in `ILogOptions`, not in UI. IntelliJ `NoMergesFilterAction` toggleable button. Common workflow filter. |
| Parent filter (--min-parents, --max-parents) | ❌ missing | ❌ missing | — | Not in `ILogOptions`. IntelliJ `ParentFilterModel` lets user filter "Merge commits only" / "No merges" / "First parent". |
| Range filter (commit A..B, A...B) | ❌ missing | ❌ missing | — | Not in `ILogOptions`. IntelliJ `VcsLogRangeFilter` + `RANGE_FILTER` for viewing differences between branches. |

## Gap table (Round 2 — fresh)

| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **Path filter correctness (P1 #5)** | `--full-history --simplify-merges` when path present | Now correct: `:336–340` in `StashTagHistoryOps.ts` | ✅ parity | 🟢 | `git4idea` | Closed 9755ea6. |
| **Filter bar UI (P1 #5 UI)** | 5-field bar (text, author, path, since, until) + Enter-to-apply | Rendered in `graphClusterBuilder.ts`, HTML-escaped, wired to `applyLogFilter` message | ✅ parity | 🟢 | `platform` | Closed f946576. Dogfood F5 pending per PROGRESS. |
| **Copy Commit Message (P3)** | `Vcs.Log.CopySubjectText` — single/multi, clipboard write | `copyCommitMessage` action + multi joins with blank line | ✅ parity | 🟢 | `platform` | Closed 07e0cd8. |
| **Branch filter** | `BranchFilterModel` — filter log to selected branches/tags, union/intersection | No `branch` field in `ILogFilter`. UI has no branch dropdown. Backend `options?.ref` single-branch scope exists but unused. | ❌ missing | 🟠 high | `platform` | IntelliJ: multi-select branch tree popup. Daily-use filter. `GitLogProvider:449` assembles `getBranchLikeFilterParameters()`. We: `getLog()` takes `options?.ref` (:327) but UI never sets it. Add `ILogFilter.branches?: string[]` + multi-select UI + backend union via multiple `getLog()` calls or custom argv. M effort (UI popup + union logic). |
| **No-merges filter** | `--no-merges` toggleable action in toolbar | Not in `ILogOptions`. No UI control. | ❌ missing | 🟠 high | `git4idea` | IntelliJ `NoMergesFilterAction` + `--no-merges` flag in argv. Common workflow (hide noise merges). S effort: add `ILogOptions.noMerges?: boolean`, `getLog()` appends `--no-merges`, UI checkbox. `GitLogProvider:490–492` shows first-parent similar guard. |
| **Text filter regex mode** | Regex toggle + case-sensitive toggle in text field extension | Single text input → `--grep=<literal>`. No regex / case flags. | 🟡 partial | 🟡 medium | `platform` | IntelliJ `TextFilterModel` `:462–466` assembles regex patterns + `--regexp-ignore-case`. We: `:309` only plain `--grep`. Add `ILogFilter.grepIsRegex?: boolean`, `grepIsCaseSensitive?: boolean`. UI: 2 checkboxes in filter bar (IntelliJ uses SearchFieldWithExtension toolbar buttons). M effort (UI + backend flags). |
| **User filter — known users dropdown** | Pre-populated list of repo committers + "me" alias | Freetext author input → `--author=<text>` | 🟡 partial | 🟡 medium | `platform` | IntelliJ `UserFilterPopupComponent` calls `GitUserRegistry.getUsers()`. We: `:300` accepts any string. Functional but no discoverability. Add `IGitService.getKnownUsers(repo)` (parse `git shortlog -sne --all`), UI multi-select dropdown. M effort. |
| **Date filter — calendar picker** | Calendar popup + presets ("Last week", "Last month", "Since yesterday") | Text inputs for since/until (ISO strings) | 🟡 partial | ⚪ polish | `platform` | Functional (backend `:303–307` correct). IntelliJ `DateFilterPopupComponent` has rich UI. Ours: bare `<input type="text">`. Add date pickers (VS Code has no native; options: HTML5 `<input type="date">` or custom). L effort for parity UI. |
| **Parent filter (merge/no-merge/first-parent)** | `--min-parents`, `--max-parents`, `--first-parent` via dropdown | Not in `ILogOptions`. No UI. | ❌ missing | 🟡 medium | `git4idea` | IntelliJ `ParentFilterModel` `:494–499`. Use case: "show only merges" (min=2), "no merges" (max=1 — overlaps with no-merges filter), "first-parent" (linearize). Add `ILogOptions.minParents?/maxParents?/firstParent?:boolean`, UI dropdown. M effort. |
| **Range filter (A..B, A...B)** | Range syntax for "commits in B not in A" | Not in `ILogOptions`. No UI. | ❌ missing | 🟡 medium | `git4idea` | IntelliJ `VcsLogRangeFilter` + `RANGE_FILTER`. `GitLogProvider:280–301` handles union of range + branch filters. Use case: compare feature branch to main. Add `ILogFilter.range?: string` (e.g. "main...feature"), UI text input + validation. M effort. |
| **Commit highlighting on branch focus** | Brightened commit rows on focused branch path, dimmed others | State fields + path computation exist; CSS classes not applied in render. | 🟡 partial | 🟡 medium | `platform` | `setFocusedBranch()` (:1583) computes BFS path → `_focusedPathHashes` Set. `generateCommitGraph()` tags `onFocusedBranchPath` on nodes. BUT: `buildCommitRows()` in `graphClusterBuilder.ts` doesn't add `commit-row-dim` / `commit-row-bright` classes based on `node.onFocusedBranchPath`. Add 2-line class toggle in row builder. S effort. |
| **Cherry-mark badges (✓ already cherry-picked)** | Dim row + checkmark badge when commit is `=` in `--cherry-mark` | `IExtendedLogState.cherryPickedHashes` + `cherryPickBaseRef` fields exist (:220, :226). Not rendered. | 🟡 partial | 🟡 medium | `platform` | Backend: `DiffOps.getCherryMarks()` exists, `GitToolWindowProvider` sets `cherryPickedHashes` on state. BUT: `buildCommitRows()` doesn't render the badge or dim class. IntelliJ shows "✓" icon + lighter row. Add badge span + CSS. S effort. |
| **"Load More" incremental scroll** | Fires request when user scrolls near bottom, debounced | Implemented. `loadMoreCommits` message + `_handleLoadMoreCommits()` (:1405) | ✅ parity | 🟢 | `platform` | Correct. `INCREMENTAL_COMMIT_LOAD_COUNT = 100`. |
| **Structural file/folder filter** | Multi-path filter (IntelliJ allows selecting multiple files/dirs) | Single-path text input. Backend `options?.path` only accepts one string. | 🟡 partial | 🟡 medium | `platform` | IntelliJ `FileFilterModel` + `StructureFilterPopupComponent` — tree picker for multi-path. We: `:334` single `--` pathspec. Git supports multiple paths after `--`. Add `ILogOptions.paths?: string[]`, join with repeated `--` markers. M effort (UI tree picker is heavy). |
| **Commit details panel — parent picker for merges** | Dropdown to choose which parent to diff against (P1 #6) | `resolveDiffParent()` in `CommitContextMenuCommands.ts` (:1050) | ✅ parity | 🟢 | `git4idea` | Closed 178a8c8. Multi-parent commits show modal picker. Correct. |
| **Graph edge routing — far-parent collapse** | Dotted edge for skipped rows, routed around intervening lanes | Fixed. `endRow` field + 3-layer routing (Task #68, Wave 2) | ✅ parity | 🟢 | `platform` | Per AGENT_WORKSPACE: closed in Wave 2, merged PR #17. Review caught CRITICAL clip bug + HIGH dash bug. |
| **Graph lane assignment stability** | Deterministic lane ordering (siblings sorted by name/date) | `computeActiveLanes()` in `graphRenderer.ts` | ✅ parity | 🟢 | `platform` | Correct. Topological + stable secondary sort. |
| **Multi-commit selection anchor tracking** | Shift-click ranges computed from stable anchor, Ctrl-click moves anchor | `IExtendedLogState.anchorHash` (:239), `rangeSelectCommit` / `addRangeSelectCommit` handlers (:1331–1356) | ✅ parity | 🟢 | `platform` | Correct. IntelliJ-parity anchor semantics per ADR-009. |
| **Context menu action ordering** | IntelliJ menu structure (Copy/Create Patch at top, destructive at bottom) | Partially matches. Some actions out of order. | 🟡 partial | ⚪ polish | `platform` | P3 task per NORTHSTAR. Functional but not visually aligned. S effort (reorder menu items in HTML builder). |
| **"Checkout Revision" (detached HEAD)** | `checkoutRevision` action → detached HEAD at selected commit | Implemented. `_handleCheckoutRevision()` in `CommitContextMenuCommands.ts` | ✅ parity | 🟢 | `git4idea` | Correct. |
| **"Show Repo at Revision"** | Opens a virtual read-only file tree at selected commit | Implemented. `showRepoAtRevision` action routes to VS Code API | ✅ parity | 🟢 | `platform` | Correct. |
| **"Compare with Local"** | Diff selected commit's files against working tree | Implemented. `compareWithLocal` action | ✅ parity | 🟢 | `git4idea` | Correct. |
| **"Reset to Here"** | Opens reset dialog (soft/mixed/hard) with Smart Reset (P1 #8) | Implemented + Smart Reset (stash-first) landed. `resetToHere` action + `showResetDialog()` | ✅ parity | 🟢 | `git4idea` | Closed 220dd7e (P1 #8 Smart Reset). IntelliJ `GitResetOperation` parity. |
| **"Revert Commit"** | Creates revert commit (or opens conflict dialog) | Implemented. `_handleRevert()` in `CommitContextMenuCommands.ts` | ✅ parity | 🟢 | `git4idea` | Correct. |
| **"Undo Commit"** (soft reset + restore message) | Soft-reset HEAD^ + prefill composer with undone message (P1 #9) | Implemented. `_handleUndoCommit()` calls `prefillComposerMessage()` | ✅ parity | 🟢 | `git4idea` | Closed 764a6f9 (P1 #9). IntelliJ `GitUncommitAction` parity. |
| **"Drop Commit"** (interactive rebase drop) | Rebase plan with selected commit removed | Implemented. `_handleDropCommit()` + multi-select `_handleDropCommitMulti()` | ✅ parity | 🟢 | `git4idea` | Correct. |
| **"Edit Commit Message"** (reword) | Interactive rebase reword | Implemented. `_handleEditCommitMessage()` | ✅ parity | 🟢 | `git4idea` | Correct. |
| **"Squash Commits"** (multi-select squash) | Interactive rebase squash plan + message dialog | Implemented. `_handleSquashCommits()` + `SquashMessageDialog` | ✅ parity | 🟢 | `git4idea` | Correct. Single-select "Squash with Previous" also wired. |
| **"Fixup with Previous"** | Interactive rebase fixup (discard message) | Implemented. `fixupWithPrevious` action synthesizes 2-commit range + reuses squash handler | ✅ parity | 🟢 | `git4idea` | Correct. |
| **"Merge into Current"** | Merges selected commit into HEAD | Implemented. `_handleMergeIntoCurrent()` | ✅ parity | 🟢 | `git4idea` | Correct. |
| **"Cherry-Pick"** with `-x` option (P2) | Adds "cherry picked from" trailer | Implemented. `ICherryPickOptions.addCherryPickedFrom` | ✅ parity | 🟢 | `git4idea` | Closed 5e06d66 (P2 cherry-pick -x). Backend + UI checkbox. |
| **"Create Patch"** for single/multi commits | Exports diff as .patch file | Implemented. `_handleCreatePatch()` + multi `_handleCreatePatchMulti()` | ✅ parity | 🟢 | `git4idea` | Correct. |
| **"Compare with Branch"** | Opens QuickPick of branches → shows branch comparison view | Implemented. `compareWithBranch` action → `BranchComparisonView` | ✅ parity | 🟢 | `git4idea` | Correct. Routes to dedicated comparison panel. |
| **"Interactive Rebase"** | Opens todo editor or rebase dialog | Implemented. `_handleInteractiveRebase()` → `RebaseDialog` | ✅ parity | 🟢 | `git4idea` | Correct. P1 #4 (preserve update-ref/exec/label/merge in todo) closed 0bca889. Node-based sequence editor parity. |
| **Rebase todo preserve advanced commands (P1 #4)** | Keeps `update-ref`, `label`, `reset`, `merge`, `exec` lines | Fixed. Transform-in-place editor via `ELECTRON_RUN_AS_NODE` | ✅ parity | 🟢 | `git4idea` | Closed 0bca889. IntelliJ `GitInteractiveRebaseFile` parity. TDD: 14 new tests (10 transform + 4 editor glue). Real git 2.50 fixture. Dogfooded end-to-end. |
| **Filter persistence across sessions** | globalState persists last-used filters | Not implemented. Filters cleared on webview reload. | ❌ missing | 🟡 medium | `platform` | IntelliJ `MainVcsLogUiProperties` persists branch/user/date/structure/text filter state. Add `context.globalState.get/update('logFilter')` in `_handleApplyLogFilter()`. S effort. |
| **Filter "clear" button** | Single-click clear all filters | Partially implemented. `clearLogFilter` message (:1392) clears via `_handleApplyLogFilter(null)`. UI "Clear filter" button only shown on filtered-empty state. | 🟡 partial | ⚪ polish | `platform` | Functional path exists. IntelliJ has persistent "X" button in filter bar. Add always-visible clear button when any filter active. S effort. |
| **Graph row height consistency** | Fixed-height rows for keyboard navigation + accessibility | Implemented. CSS `min-height` + `height` on `.commit-row` | ✅ parity | 🟢 | `platform` | Correct. |
| **Keyboard navigation (arrow keys)** | Up/Down arrows navigate commits, Enter expands details | Not implemented. Requires focus management in webview. | ❌ missing | 🟡 medium | `platform` | IntelliJ table uses platform keyboard nav. Our webview: click-only. Add `tabindex`, arrow key handlers, focus ring CSS. M effort (webview focus trap + scroll-into-view). |
| **"Focus on Graph" from Branches tree** | Inline action on branch tree item → brightens branch path | Implemented. `setFocusedBranch()` public API + `navigateToBranch()` (:1548) | ✅ parity | 🟢 | `platform` | Correct. Wired to BRANCHES tree view. CSS highlighting incomplete (see "Commit highlighting" row above). |
| **Search in log (Ctrl+F)** | Text search highlights matching rows, cycles with F3/Shift+F3 | Not implemented. Webview has no in-page search. | ❌ missing | 🟡 medium | `platform` | IntelliJ uses platform find-in-table. Our webview: use VS Code webview `find` API or custom impl. M effort. |
| **Export log to text file** | Save visible log as text/CSV | Not implemented. No menu action. | ❌ missing | ⚪ polish | `platform` | IntelliJ "Export" action. Nice-to-have. S effort (serialize commitNodes to text, save dialog). |
| **Column width persistence** | Saves column widths across sessions | Implemented. `saveColumnWidths()` / `loadColumnWidths()` in `columnLayout.ts` | ✅ parity | 🟢 | `platform` | Correct. |
| **Panel width persistence** | Saves graph/details panel split ratio | Implemented. `savePanelWidths()` / `loadPanelWidths()` in `panelLayout.ts` | ✅ parity | 🟢 | `platform` | Correct. |
| **Multi-repo selector** | Dropdown to switch active repo when multi-root workspace | Implemented. `_handleRepositorySelection()` (:1419), selector rendered in graph panel | ✅ parity | 🟢 | `platform` | Correct. |
| **File tree expansion state persistence** | Details panel file tree collapse/expand state preserved on re-select | Not implemented. Tree always fully expanded on commit change. | ❌ missing | ⚪ polish | `platform` | IntelliJ persists per-session. Ours: stateless HTML render. Add `IExtendedLogState.expandedDirs: Set<string>`, store on toggle, apply in `renderFileTree()`. S effort. |
| **File double-click in details panel** | Opens diff editor for file at selected commit | Implemented. `doubleClickCommitFile` message (:1384) → `_handleCommitFileDoubleClick()` | ✅ parity | 🟢 | `platform` | Correct. |
| **File right-click context menu in details panel** | Copy path, show history, open at revision | Not implemented. No right-click handler on file rows. | ❌ missing | 🟡 medium | `platform` | IntelliJ file tree has dedicated context menu. We: double-click only. Add `data-action` on file rows + `contextmenu` event → QuickPick or webview context menu. M effort. |
| **Commit body rendering (multiline)** | Full commit body shown in details panel with preserved formatting | Implemented. `commitDetails.body` rendered as `<pre>` in `buildDetailsPanelHtml()` | ✅ parity | 🟢 | `platform` | Correct. Body preserved, HTML-escaped. |
| **Hyperlink detection in commit messages** | Auto-linkifies URLs + issue references (e.g. #123 → GitHub issue) | Partial. `isIssueLinkingEnabled()` + `getSelectedRepoRemote()` exist in provider. Issue link regex applied in `_linkifyText()` helper. GitHub/GitLab patterns supported. | 🟡 partial | ⚪ polish | `platform` | Functional for HTTP(S) URLs + #NNN issue syntax. IntelliJ integrates with issue trackers (JIRA, YouTrack) via plugins. Our scope: GitHub/GitLab only. Polish: add BitBucket, Azure DevOps patterns. S effort. |
| **Branch label click → checkout** | Click branch chip in graph row → checkout that branch | Implemented. `branchClick` message (:1399) → `_handleBranchClick()` → `navigateToBranch()` scrolls to branch tip. Checkout: not direct from chip. | 🟡 partial | ⚪ polish | `platform` | Chip click scrolls, doesn't checkout. IntelliJ context menu on chip offers "Checkout". Add right-click menu or Ctrl+click shortcut. S effort. |
| **Tag label click → navigate/tag info** | Click tag chip → scroll to tag commit | Implemented. Tag chips rendered as `data-tag` spans, no dedicated click handler. Scroll happens naturally (tag on commit already visible). | 🟡 partial | ⚪ polish | `platform` | Tag chips are static labels. IntelliJ context menu on tag offers "Show Tag Info" / "Delete Tag". Add click handler or right-click menu. S effort. |
| **HEAD label persistence** | HEAD chip always inline even when `+N more` collapses other branches | Implemented. `headBranchName` + focused-branch tiebreak logic in `_getBranchLabelsHtml()` | ✅ parity | 🟢 | `platform` | Correct per `:273–281` JSDoc. |
| **Graph color consistency** | Branch/lane colors stable across reloads (deterministic hash) | Implemented. `GraphRenderer.computeActiveLanes()` uses stable hash of commit ancestry | ✅ parity | 🟢 | `platform` | Correct. |
| **CSP compliance** | No inline scripts/styles (nonce-protected) | Implemented. `buildInlineScript()` + `buildInlineStyles()` use nonce. All HTML builders escape user content. | ✅ parity | 🟢 | security | Correct. Verified in Wave 2.3b review. |
| **Argv injection guards in log query** | `--end-of-options`, no shell, user input not spliced into flags | Implemented. `getLog()` uses `buildGitArgs()` for `--` separator (:340). Author/grep/path are string-interpolated but no shell. `options?.ref` is positional after flags (:332). | ✅ parity | 🟢 | security | Correct. Refnames can't start with `-`. `--author=<user>` / `--grep=<text>` are git's own escaping (no shell). |
| **Credential/path leakage in errors** | Sanitized git stderr before showing in UI | Implemented. `sanitizeGitError()` used in all `CommitContextMenuCommands` error paths. | ✅ parity | 🟢 | security | Correct. Strips auth tokens, file paths from stderr. |

## Top findings (ranked, this component)

1. **Branch filter missing (daily-use feature)** — IntelliJ `BranchFilterModel` lets users filter the log to one or more branches/tags (union mode). We have single-ref scope (`options?.ref`) in backend but zero UI. Users can't answer "show me only commits on feature-X" without external git commands. Severity: 🟠 high (daily workflow gap). Source: `platform`. Effort: M (UI multi-select branch tree popup + backend union via multiple `getLog()` calls or custom `git log branch1 branch2 ...` argv). Files to touch: `ILogFilter` (add `branches?: string[]`), `StashTagHistoryOps.getLog()` (join branches), `graphClusterBuilder.ts` (add branch filter dropdown), `GitToolWindowProvider._handleApplyLogFilter()` (thread branches).

2. **No-merges filter missing (noise reduction)** — IntelliJ `NoMergesFilterAction` + `--no-merges` flag in toolbar. Common use case: hide merge commits to focus on feature work. We have none. Severity: 🟠 high (daily-hit for large repos). Source: `git4idea`. Effort: S (add `ILogOptions.noMerges?: boolean`, append `--no-merges` in `getLog()`, UI checkbox in filter bar). Files to touch: `ILogOptions`, `StashTagHistoryOps.getLog()` (:314), filter bar HTML in `graphClusterBuilder.ts`, message handler in `GitToolWindowProvider`.

3. **Keyboard navigation missing (accessibility + power users)** — IntelliJ log table supports arrow keys (Up/Down navigate commits, Enter expands details, Ctrl+A selects all). Our webview: click-only. Blocks keyboard-only workflows. Severity: 🟡 medium (accessibility gap + power-user friction). Source: `platform`. Effort: M (add `tabindex` on commit rows, arrow key handlers in `scriptBuilder.ts`, scroll-into-view on focus change, focus ring CSS). Files to touch: `buildCommitRows()` (add tabindex), `scriptBuilder.ts` (keydown handler), `stylesBuilder.ts` (focus ring CSS).

4. **Commit highlighting on branch focus incomplete** — Backend computes BFS path from focused branch to merge-base (`setFocusedBranch()` (:1583), `_focusedPathHashes` Set, `onFocusedBranchPath` bool on nodes). BUT: `buildCommitRows()` in `graphClusterBuilder.ts` doesn't apply `commit-row-dim` / `commit-row-bright` classes. Visual feedback promised by the "Focus on Graph" action is missing. Severity: 🟡 medium (feature half-wired). Source: `platform`. Effort: S (2-line class toggle in row builder: `if (node.onFocusedBranchPath) classes.push('commit-row-bright'); else if (focusedBranchName) classes.push('commit-row-dim');`). Files to touch: `graphClusterBuilder.ts:buildCommitRows()`, `stylesBuilder.ts` (add dim/bright CSS).

5. **Text filter regex mode missing** — IntelliJ `TextFilterModel` has regex toggle + case-sensitive toggle. We: single text input → `--grep=<literal>`. No way to search commits by regex pattern. Severity: 🟡 medium (power-user feature). Source: `platform`. Effort: M (add `ILogFilter.grepIsRegex?: boolean`, `grepIsCaseSensitive?: boolean`; backend: conditional `--regexp-ignore-case` flag; UI: 2 checkboxes in filter bar). Files to touch: `ILogFilter`, `StashTagHistoryOps.getLog()` (:309), filter bar HTML, message handler.

6. **User filter — no known-users dropdown** — IntelliJ `UserFilterPopupComponent` pre-populates list of repo committers from `GitUserRegistry.getUsers()`. We: freetext author input. Functional but no discoverability (user must know exact name/email). Severity: 🟡 medium (UX friction). Source: `platform`. Effort: M (add `IGitService.getKnownUsers(repo)` parsing `git shortlog -sne --all`, UI multi-select dropdown with "me" alias). Files to touch: `IGitService`, new `getKnownUsers()` impl in `StashTagHistoryOps.ts`, filter bar HTML (dropdown), message handler.

7. **Cherry-mark badges not rendered** — Backend: `DiffOps.getCherryMarks()` exists, `IExtendedLogState.cherryPickedHashes` + `cherryPickBaseRef` fields populated (:220, :226). BUT: `buildCommitRows()` doesn't render "✓" badge or dim row for commits in the set. IntelliJ shows checkmark icon + lighter row color to indicate "already cherry-picked to upstream". Severity: 🟡 medium (visual feedback missing). Source: `platform`. Effort: S (add badge span + CSS, check `cherryPickedHashes.has(node.commit.hash)` in row builder). Files to touch: `graphClusterBuilder.ts:buildCommitRows()`, `stylesBuilder.ts` (badge CSS).

8. **File right-click context menu in details panel missing** — IntelliJ file tree has "Copy Path", "Show History for File", "Open File at Revision", "Annotate". We: double-click opens diff, no right-click. Severity: 🟡 medium (missing file-level actions). Source: `platform`. Effort: M (add `data-action` on file rows, `contextmenu` event handler, route to file history / blame / copy path commands). Files to touch: `htmlBuilders.ts:renderFileTree()`, `scriptBuilder.ts` (contextmenu handler), `GitToolWindowProvider` message dispatch for file actions.

9. **Search in log (Ctrl+F) missing** — IntelliJ uses platform find-in-table (Ctrl+F highlights matching rows, F3/Shift+F3 cycles). Our webview: no in-page search. Severity: 🟡 medium (navigation friction for large logs). Source: `platform`. Effort: M (use VS Code webview `find` API or custom impl with highlight + scroll). Files to touch: `scriptBuilder.ts` (find handler), `stylesBuilder.ts` (highlight CSS).

10. **Parent filter (merge/no-merge/first-parent) missing** — IntelliJ `ParentFilterModel` + `--min-parents`, `--max-parents`, `--first-parent` flags. Use cases: "show only merges" (min=2), "linearize history" (first-parent). We have none. Severity: 🟡 medium (workflow flexibility). Source: `git4idea`. Effort: M (add `ILogOptions.minParents?/maxParents?/firstParent?: boolean`, UI dropdown with presets, backend argv flags). Files to touch: `ILogOptions`, `StashTagHistoryOps.getLog()`, filter bar HTML (dropdown), message handler.

## Security review (this component)

**Verdict: CLEAN** — zero new findings of any severity in this component.

### Argv injection (log query)
- **`getLog()` (:290–349 in `StashTagHistoryOps.ts`):** Uses `buildGitArgs()` for `--end-of-options` separator when path present (:340). User-controlled fields (`options?.author`, `options?.grep`, `options?.path`, `options?.ref`) are string-interpolated or positional after flags. No shell invocation (exec passes argv array). `--author=<user>` / `--grep=<text>` are git's own argv parsing (no shell metachar expansion). `options?.ref` is positional after flags (:332) — safe because refnames can't start with `-` per git-check-ref-format. **SAFE.**

### Webview message validation
- **`_handleWebviewMessage()` (:1310–1451 in `GitToolWindowProvider.ts`):** Type-narrows string fields (`typeof message.type === 'string'`, `typeof message.branchName === 'string'`). Hash fields validated by `allHashesValid(HASH_RE)` in `CommitContextMenuCommands` before git commands. Branch name validated against known branches before `setFocusedBranch()` (:1437–1441) to prevent option-injection (e.g. `--upload-pack=evil`). **SAFE.**

### CSP compliance
- **Inline scripts/styles:** All use nonce. `buildInlineScript()` + `buildInlineStyles()` in respective builders. Verified in Wave 2.3b tech-lead review (AGENT_WORKSPACE). **SAFE.**

### HTML escaping
- **User content:** All commit messages, file paths, branch names, author names HTML-escaped via `escapeHtml()` before rendering in `htmlBuilders.ts` + `graphClusterBuilder.ts`. Verified in P1 #5 filter-bar UI commit f946576 (TDD: 6 new tests including escaping). **SAFE.**

### Credential/path leakage
- **Error surfacing:** All `CommitContextMenuCommands` error paths use `sanitizeGitError()` before showing toasts. Strips auth tokens (`https://user:pass@...` → `https://...`), normalizes file paths. **SAFE.**

### Filter input sanitization
- **Filter bar inputs:** Text/author/path fields are freetext → `--grep=<value>` / `--author=<value>` / `-- <path>`. Git's own argv parsing (no shell). Since/until are ISO date strings → `--since=<iso>` / `--until=<iso>`. No injection risk (git validates date format). **SAFE.**

## Blockers

**None.** All P1 silent-wrong git ops for this component (path-filter, merge-parent diff, branch cherry-pick scope, rebase todo preservation) are closed per PROGRESS.md. Filter bar UI is wired and functional (F5 dogfood pending per PROGRESS, but not a blocker — tests green, backend correct).

The identified gaps (branch filter, no-merges, keyboard nav, highlighting CSS, regex mode, user dropdown, cherry-mark badges, file context menu, search, parent filter) are **missing features** or **partial UI polish**, not blockers. The log component is functional and safe for daily use; the gaps are prioritized as P2 (high-value missing) or P3 (partial→full).

---

## Summary

**Component health: GOOD.** The log/commit-graph component has closed all P1 correctness gaps (path-filter, merge-parent diff, branch cherry-pick scope, rebase todo preservation, Copy Commit Message). Filter bar UI is functional (5-field bar, HTML-escaped, wired to backend). Multi-select, range-select, context menu actions, graph rendering (lanes, edges, far-parent routing), panel/column persistence, CSP compliance, and security hardening (argv guards, HTML escaping, sanitized errors) are all **parity or better than R1 baseline**.

**Top 3 findings:**
1. **🟠 Branch filter missing** — daily-use feature (IntelliJ `BranchFilterModel`). Backend has single-ref scope, zero UI. M effort.
2. **🟠 No-merges filter missing** — `--no-merges` toggle for noise reduction in large repos. S effort.
3. **🟡 Keyboard navigation missing** — arrow keys, Enter, Ctrl+A. Accessibility gap + power-user friction. M effort.

**R1 gaps closed:** 3 of 3 explicit P1 items (path-filter ✅ 9755ea6, filter-bar UI ✅ f946576, Copy Commit Message ✅ 07e0cd8).

**R1 gaps still open:** 10 partial/missing items (branch filter, no-merges, text regex, user dropdown, date calendar, parent filter, range filter, commit highlighting CSS, cherry-mark badges, context menu ordering).

**🔴 Blockers/security: ZERO.** All argv injection guards, CSP compliance, HTML escaping, and credential sanitization verified correct. No silent-wrong ops remain in this component.

**Next recommended:** P2 branch filter (🟠 high, M effort) + no-merges filter (🟠 high, S effort) — both are daily-workflow gaps with clear IntelliJ precedent and manageable implementation scope.
