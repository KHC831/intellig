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

## Landed since initial enumeration

The G1-G9 work (per NORTHSTAR) landed the full log-filter + graph feature set. Verified in current source:
- **Log filters** — `ILogOptions` (`IGitToolWindowProvider.ts:61–85`) carries `noMerges`, `firstParent`,
  `minParents`/`maxParents`, `logRange` (A..B / A...B), `searchRegex`, `matchCase`; all applied in
  `StashTagHistoryOps.getLog` (`--no-merges`, `--first-parent`, `--min/max-parents`, `--regexp-ignore-case`,
  `-E`) and threaded from the webview filter bar (`GitToolWindowProvider.ts:1759–1819`).
- **Path filter** — `--full-history --simplify-merges --  <path>` (StashTagHistoryOps).
- **Commit highlighting on branch focus** — `onFocusedBranchPath` computed (`:2158`) and applied per row
  (focused-branch bright + `aria-describedby`, `:3582`); column-header row + drag-resize handles rendered
  (`:3304`, `:3043`); arrow-key parent/child nav (`goToParent`/`goToChild`, `:2918`).
- **Copy Commit Message**, GPG column, fixup/squash links, incoming tab, push-up-to, multi-root, go-to-parent/child.

## Gap table — remaining residuals (polish)

| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **Branch filter (multi-select union)** | `BranchFilterModel` — filter log to several selected branches/tags (union) via a tree popup | Backend has single `ref` scope + `logRange` (A..B); no multi-branch-union picker UI. | 🟡 partial | 🟡 medium | `platform` | Range + single-ref cover most cases; the multi-select union picker is the residual. Add `ILogFilter.branches?: string[]` + popup. M effort. |
| **User filter — known-committers dropdown** | Pre-populated list of repo committers + "me" alias | Freetext `--author` input works; no dropdown of known users. | 🟡 partial | ⚪ polish | `platform` | Add `getKnownUsers` (`git shortlog -sne --all`) + dropdown. M effort. |
| **Date filter — calendar presets** | Calendar popup + presets ("Last week", etc.) | since/until inputs work; no presets/calendar. | 🟡 partial | ⚪ polish | `platform` | Functional; presets are UI polish. |
| **Log-filter persistence across sessions** | `MainVcsLogUiProperties` persists last filters | Filters cleared on webview reload. | ❌ missing | ⚪ polish | `platform` | Add `globalState` get/update in the apply-filter handler. S effort. |
| **In-page search (Ctrl+F) / export to text** | Find-in-table + Export action | Not implemented in the webview. | ❌ missing | ⚪ polish | `platform` | Nice-to-have. S/M effort. |
| **AddCommitToRemoteBranch** (log menu) | `Git.AddCommitToRemoteBranch` — cherry-push a single commit to a remote branch | Not implemented. | ❌ missing | ⚪ polish | `git4idea` | Niche log-context-menu item. |
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
| **Keyboard navigation (arrow keys)** | Up/Down navigate commits, Left/Right collapse/expand, Enter expands details | Left/Right arrow **parent/child** navigation wired (`goToParent`/`goToChild`, GitToolWindowProvider.ts:2918); commit rows are `tabindex`-focusable with a focus ring. Up/Down row-to-row navigation is the residual. | 🟡 partial | ⚪ polish | `platform` | Add Up/Down keydown handlers + scroll-into-view. S effort. |
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

## Top findings (remaining residuals — all polish)

The G1-G9 filter + graph features landed (no-merges, regex/case, parent, range, path filters; commit
highlighting; column headers; cherry-mark badges; arrow-key parent/child nav — see "Landed" above).
Genuine residuals:

1. **Branch filter (multi-select union)** — single-ref + range (A..B) cover most cases; the multi-select
   branch-union picker is the residual. 🟡 medium, M effort.
2. **User filter — known-committers dropdown** — freetext `--author` works; no pre-populated committer list
   (`git shortlog -sne --all`). ⚪ polish, M.
3. **File right-click context menu in details panel** — Copy Path / Show History / Open at Revision on file
   rows. Double-click-to-diff works today. 🟡 medium, M.
4. **In-page search (Ctrl+F)** + **log-filter persistence across sessions** + **export to text** + **date-preset
   pickers** — webview niceties. ⚪ polish.
5. **`Git.AddCommitToRemoteBranch`** — niche log-menu cherry-push action. ⚪ polish.

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

**None.** The full filter set (no-merges, regex/case, parent, range, path), commit highlighting, column headers, cherry-mark badges, and arrow-key parent/child nav all landed. Remaining items are UI polish, not blockers.

---

## Summary

**Component health: STRONG (≈98%).** All core log/graph features are at parity: 5-field filter bar wired to a backend that honors no-merges / first-parent / min-max-parents / range (A..B) / regex+case / path filters; commit-graph rendering (lanes, edges, far-parent routing); focused-branch highlighting; column headers + drag-resize; cherry-mark badges; multi-select; context menu; GPG column; fixup/squash links; incoming tab; push-up-to; multi-root; go-to-parent/child. Security hardened (argv guards via buildGitArgs, HTML escaping, sanitized errors).

**Remaining residuals (all polish):**
1. Branch filter as a multi-select union picker (single-ref + range cover most cases). 🟡 medium.
2. User filter known-committers dropdown; file-row context menu in details panel. 🟡/⚪.
3. In-page Ctrl+F search, log-filter persistence, export-to-text, date presets, `AddCommitToRemoteBranch`. ⚪ polish.

**🔴 Blockers/security: ZERO.** Argv injection guards, CSP, HTML escaping, credential sanitization all verified.
