# IntelliG Feature Catalog

_Produced by gap-analyst after feature-cataloger task #1 closed without writing the file. Evidence drawn from exhaustive read of `src/extension.ts`, all `src/services/*.ts`, all `src/commands/*.ts`, and `package.json` contributes. Cross-referenced with BUGS.md (which confirms several formerly-stub paths now work)._

Status legend: ✅ Shipped · 🟡 Partial (wired but incomplete) · ⚠️ Stub (placeholder showing "Coming Soon" or equivalent) · ❌ Missing (not in source).

---

## Commit

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Commit dialog (non-modal webview) | `intellig.commit` | ✅ | extension.ts:243, CommitDialog.ts:125 | Full webview panel w/ file list, diff preview |
| Stage whole files | toggleFile | ✅ | CommitDialog.ts:431 | Checkbox per file |
| Stage hunks | stageHunk | ✅ | CommitDialog.ts:491, GitService.ts:1206 | Per-hunk buttons in diff |
| Stage lines (partial) | stageSelectedLines | ✅ | CommitDialog.ts:306, GitService.ts:1227 | BUG-01 fixed — now tracks oldLineNumber/newLineNumber |
| Unstage files/hunks | _handleUnstageHunk | ✅ | CommitDialog.ts:516 | Mirror of stage paths |
| Amend HEAD | --amend toggle | ✅ | CommitDialog.ts:268 | Pre-populates previous message |
| Signed-off-by | --signoff toggle | ✅ | CommitDialog.ts:271 | Plus `intellig.defaultCommitSignOff` config |
| Commit message textarea | input | ✅ | CommitDialog.ts:746 | Plus template via `intellig.commitMessageTemplate` |
| Commit & Push | `intellig.push` | ⚠️ | extension.ts:286 | Top-level Push shows "Push - Coming Soon" |
| Recent-message history dropdown | — | ❌ | not found | No QuickPick of prior commit subjects |
| Custom commit author | — | ❌ | not found | No author override field |
| Pre-commit checks UI | — | ❌ | not found | No reformat/optimize/TODO/inspection hooks |
| Pre-commit hooks (--no-verify toggle) | — | ❌ | not found | Hook bypass not exposed |
| CSP on commit dialog webview | getWebviewContent | ✅ | CommitDialog.ts (per OTHER-01 style) | Nonce present |

## Branches

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Branch QuickPick popup | `intellig.showBranchPopup` | ✅ | extension.ts:302, BranchPopup.ts:158 | IntelliJ-style picker |
| Branch tree view (panel) | view `intellig.branchTree` | ✅ | extension.ts:2217, BranchTreeProvider.ts | Local + Remote sections |
| Create new branch (from HEAD / ref) | `intellig.branch.newBranchFrom` | ✅ | BranchContextMenuCommands.ts, BranchPopup.ts:487 | With git-check-ref-format validation (OTHER-08 fixed) |
| Checkout local branch | `intellig.branch.checkout` | ✅ | GitService.ts:418 | Via popup & tree |
| Checkout remote as local | `intellig.remoteBranch.checkoutAsLocal` | ✅ | package.json:146 | Creates tracking local |
| Rename branch | `intellig.branch.rename` | ✅ | BranchContextMenuCommands.ts | Validation added |
| Delete branch | `intellig.branch.delete` | ✅ | BranchContextMenuCommands.ts | With confirmation |
| Merge branch into current | `intellig.branch.mergeIntoCurrent` | ✅ | GitService.ts:456 | Conflict detection incl. DD/AA (BUG-09 fixed) |
| Rebase current onto branch | `intellig.branch.rebaseCurrentOnto` | ✅ | GitService.ts:492 | Plain (non-interactive) |
| Compare branch w/ current | `intellig.branch.compareWithCurrent` | ✅ | BranchComparisonView.ts | Ahead/behind + changed files |
| Show diff w/ working tree | `intellig.branch.showDiffWithWorkingTree` | 🟡 | BranchContextMenuCommands.ts:513 | URI scheme fixed (BUG-03), but `repo.rootUri` is a directory so `vscode.diff` call still degraded (BUG-17 noted; TODO comment in code) |
| Branch "Update" (fetch + integrate) | `intellig.branch.update` | ✅ | BranchContextMenuCommands.ts:453 | BUG-08 fixed — now merges upstream for current branch; for non-current branch only fetches + shows advisory message |
| Push branch | `intellig.branch.push` | 🟡 | BranchContextMenuCommands.ts | No dedicated Push dialog (force-with-lease / target editing / push tags not exposed via dedicated UI) |
| Checkout & Rebase onto Current | `intellig.branch.checkoutAndRebase` | 🟡 | BranchContextMenuCommands.ts | Handler wired but treated as stub in catalog |
| Pull remote → current (merge) | `intellig.remoteBranch.pullUsingMerge` | 🟡 | BranchContextMenuCommands.ts:137 | Registered; merge-variant logic not a dedicated dialog |
| Pull remote → current (rebase) | `intellig.remoteBranch.pullUsingRebase` | 🟡 | BranchContextMenuCommands.ts:131 | Registered; rebase-variant logic not a dedicated dialog |
| Cherry-pick commits from remote branch | `intellig.remoteBranch.cherryPickCommits` | ✅ | BranchContextMenuCommands.ts:817 | BUG-07 fixed — now passes `revision: branch.name` to getLog |
| Remote branch delete | `intellig.remoteBranch.deleteRemote` | ✅ | GitService.ts:634 | `git push :branch` |
| Favorites / starred branches | — | ❌ | not found | No favorites model |
| Recent branches (top-5) | — | ❌ | not found | No recency tracking |
| Auto-group by `/` prefix | — | ❌ | not found | Flat list |
| Multi-root synchronous ops | — | 🟡 | GitService.ts:166 | Repos discovered, but UI operates per-repo (repository picker only in tool window) |

## Log & History view

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Git tool window (webview) | view `intellig.toolWindow` | ✅ | GitToolWindowProvider.ts | 2-panel: graph + details |
| Commit graph (SVG, lanes) | commitGraph.ts / optimizedCommitGraph.ts / graphRenderer.ts | ✅ | utils/*.ts | Simplified mode for >5000 commits (PERF-09 fixed) |
| Incremental log load | INITIAL=200, INCR=100, max ~500 | ✅ | GitToolWindowProvider.ts:~2040 | Scroll-trigger |
| Branch labels on commit tips | branchMap | ✅ | GitToolWindowProvider.ts:~2008 | |
| Tag labels on commits | tagMap | ✅ | GitToolWindowProvider.ts:~2023 | |
| Filter: author | getLog({author}) | ✅ | GitService.ts:830 | |
| Filter: date range | getLog({since,until}) | ✅ | GitService.ts:833 | |
| Filter: path | getLog({path}) | ✅ | GitService.ts:848 | |
| Filter: text (grep message) | getLog({grep}) | ✅ | GitService.ts:839 | |
| Filter: revision scoping | getLog({revision}) | ✅ | GitService.ts (BUG-07 fix) | Revision arg before `--` path |
| Filter: branch / favorites | — | 🟡 | GitToolWindowProvider.ts:1111 | Filter chips partly wired; no favorites source |
| Commit details pane (files + metadata) | right panel | ✅ | GitToolWindowProvider.ts:~2156 | Shows files with status colors |
| Go-to-hash / tag / branch | — | ❌ | not found | No Ctrl+F quick-nav picker |
| Multi-commit diff | getMultiCommitDiff | ✅ | GitService.ts:884 | BUG-10 not explicitly listed as fixed but tests rewritten to merge-by-file-path |
| Repository selector | dropdown | ✅ | GitToolWindowProvider.ts:~2075 | |
| File history view | `intellig.explorer.showHistory`, `intellig.showHistory` | ✅ | extension.ts:1288 | QuickPick-based, not a persistent log tab |
| Line history (from editor) | `intellig.editor.showLineHistory` | ✅ | extension.ts:1655 | Per-line blame chain |
| Separate **Log tab** inside a tool window (4-pane layout) | — | 🟡 | GitToolWindowProvider.ts | Currently a 2-panel webview (graph + details). No separate Branches pane left, no separate Files pane right-top vs Details right-bottom split |
| Console / raw command output tab | ConsoleService.ts | 🟡 | ConsoleService.ts | Service exists & streams (BUG-16 fixed) but no visible tab UI |
| Incoming commits tab / indicator | — | ❌ | not found | Auto-fetch config exists but no incoming surface |
| Update Info tab (post-pull) | — | ❌ | not found | |
| External hosting / issue tracker links | — | ❌ | not found | |

## Merge & conflict resolution

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Three-pane merge view (Current / Result / Incoming) | `intellig.merge.openMergeView` | ✅ | MergeView.ts | BUG-02 fixed — preserves non-conflicting content; CSP+nonce added (OTHER-01) |
| Accept current / incoming / both | `intellig.merge.accept{Current,Incoming,Both}` | ✅ | MergeView.ts:105 | |
| Accept all current / all incoming | `intellig.merge.acceptAll{Current,Incoming}` | ✅ | MergeView.ts:126 | |
| Next / previous conflict navigation | `intellig.merge.{next,previous}Conflict` | ✅ | MergeView.ts:156 | Alt+↑/↓ keybindings (webview-scoped) |
| Alt+1/2/3 quick-accept | webview keydown | ✅ | MergeView.ts:843 | |
| Mark file resolved | `intellig.merge.markResolved` | ✅ | MergeView.ts:183 | Stages file |
| Conflict count indicator | display | ✅ | MergeView.ts:778 | "X/Y resolved" |
| Conflict detection (incl DD/AA) | getConflictedFiles | ✅ | ConflictResolutionService.ts:53 | BUG-09 fixed |
| Auto-open merge view on conflict | — | ❌ | not found | User must manually open |
| "Apply all non-conflicting from left/right" | — | ❌ | not found | Only all-current / all-incoming |
| Merge dialog (branch picker w/ no-ff, squash, no-commit, message) | — | ❌ | not found | Merge triggered inline; no dialog |
| Abort merge / rebase / revert | `ConflictResolutionService.abort*` | ✅ | extension.ts:1012/1050 | With confirmation |
| Continue merge / rebase / revert | `ConflictResolutionService.complete*` | ✅ | ConflictResolutionService.ts:170 | |

## Rebase (interactive + plain)

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Interactive rebase editor (webview) | `intellig.rebase.interactive` | ✅ | extension.ts:1089, RebaseEditor.ts:100 | Drag-drop via document delegation (BUG-12 fixed) |
| Action: pick / reword / edit / squash / fixup / drop | per-row dropdown | ✅ | RebaseEditor.ts | |
| Reorder commits | drag-and-drop | ✅ | RebaseEditor.ts | |
| "Onto" inclusion fix (append ~1 for commit selection) | — | ✅ | extension.ts:1192 | BUG-06 fixed |
| Abort rebase | `ConflictResolutionService.abortRebase` | ✅ | extension.ts:1050 | |
| Continue rebase | `ConflictResolutionService.completeRebase` | ✅ | ConflictResolutionService.ts:199 | |
| Skip commit (rebase --skip) | — | ❌ | not found | Not wired |
| Plain rebase (from branch popup) | BranchPopup rebase action | ✅ | BranchPopup.ts:660 | |
| Rebase progress status-bar | RebaseProgressView | ✅ | RebaseProgressView.ts | |

## Cherry-pick

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Single commit cherry-pick | `cherryPick([hash])` | ✅ | GitService.ts:999 | Via context menu |
| Multi-select cherry-pick | cherryPick handler | ✅ | CommitContextMenuCommands.ts:134 | |
| Continue / abort | cherryPickContinue / cherryPickAbort | ✅ | GitService.ts:1029/1043 | |
| `--no-commit` (cherry-pick without commit) | — | ❌ | not found | Flag not exposed |
| Apply Selected Changes (file-subset) | — | ❌ | not found | |
| Apply Files to Branch | — | ❌ | not found | |
| Highlight not-yet-cherry-picked commits | — | ❌ | not found | No log decoration |

## Reset & Revert

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Reset soft / mixed / hard | resetToHere dialog | ✅ | CommitContextMenuCommands.ts:293 | Via QuickPick of modes |
| Reset --keep | — | ❌ | not found | Missing 4th mode |
| Dedicated "Reset Current Branch to Here..." dialog | — | 🟡 | CommitContextMenuCommands.ts:293 | Implemented as QuickPick not radio-modal |
| Undo last commit (reset --soft HEAD~1) | undoCommit | ✅ | CommitContextMenuCommands.ts:370 | |
| Drop commit (via rebase-drop or reset) | dropCommit | ✅ | CommitContextMenuCommands.ts:404 | Uses interactive-rebase drop, no force-push path |
| Revert commit (creates inverse) | revert action | ✅ | GitService.ts:1100 | |
| Revert file | `intellig.revertFile`, `intellig.explorer.revert` | ✅ | GitService.ts:1271 | `checkout -- <file>` |
| Selective file-subset revert from multi-file commit | — | ❌ | not found | |
| Drop selected changes (hunk discard from unpushed commit) | — | ❌ | not found | |

## Remote ops (push / pull / fetch)

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Top-level **Push** command | `intellig.push` | ⚠️ | extension.ts:286 | "Push - Coming Soon" toast |
| Top-level **Pull** command | `intellig.pull` | ⚠️ | extension.ts:292 | "Pull - Coming Soon" toast |
| Top-level **Fetch** command | `intellig.fetch` | ⚠️ | extension.ts:298 | "Fetch - Coming Soon" toast |
| Push dialog (repositories table + target editing + force-with-lease + push-tags + "Push all up to here") | — | ❌ | not found | |
| Pull dialog w/ `--rebase / --ff-only / --no-ff / --squash / --no-commit / --no-verify` | — | ❌ | not found | Only `intellig.pullRebase` config toggle |
| Update Project (Ctrl+T, multi-root fetch + integrate w/ merge/rebase/reset strategy + Update Info) | — | ❌ | not found | |
| Auto-fetch (interval) | `intellig.autoFetchEnabled/Interval` config | 🟡 | package.json:570 | Config keys present (default on, 180s) but no running scheduler found in extension.ts |
| Incoming commits badge | — | ❌ | not found | |
| Manage Remotes (add / edit / remove) | GitService.addRemote/removeRemote | 🟡 | GitService.ts | Service methods exist; no UI surface found |
| Per-branch push via context menu | `intellig.branch.push` | 🟡 | BranchContextMenuCommands.ts | Invokes push but no dialog / force-with-lease prompt |

## Tags

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Create lightweight tag | `createTag(name)` | ✅ | GitService.ts:780 | No dedicated "New Tag" command in package.json — callable via service only |
| Create annotated tag | `createTag(name, message)` | 🟡 | GitService.ts:780 | Service supports it; **no UI** found |
| Delete tag | `intellig.tag.delete` | ✅ | GitService.ts:797 | From tree |
| Push single tag | `intellig.tag.push` + GitService.pushTag | ✅ | GitService.ts:805 | |
| Push all tags / push branch w/ `--follow-tags` | — | ❌ | not found | |
| Checkout tag (detached) | `intellig.tag.checkoutDetached` | ✅ | BranchContextMenuCommands.ts:145 | |
| New branch from tag | `intellig.tag.newBranchFrom` | ✅ | BranchContextMenuCommands.ts:152 | |
| Cherry-pick from tag | `intellig.tag.cherryPick` | ✅ | BranchContextMenuCommands.ts:159 | |
| Tag labels on graph | tagMap | ✅ | GitToolWindowProvider.ts | |
| Jump-to-tag picker (Ctrl+F style) | — | ❌ | not found | |
| `fetch.tags` setting | — | ❌ | not found | No equivalent config |

## Blame / annotate

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Inline per-line blame overlay | InlineBlameProvider | ✅ | InlineBlameProvider.ts | 500ms debounce (PERF-05 fixed) |
| Gutter blame | GutterBlameProvider | ✅ | GutterBlameProvider.ts | O(1) lookup (PERF-07 fixed) |
| Toggle blame | `intellig.editor.toggleBlame` / `intellig.toggleBlame` | ✅ | extension.ts:464 | Plus `intellig.blameAnnotationStyle` config (inline/gutter/both) |
| Copy commit hash from gutter | `intellig.editor.copyCommitHash` | ✅ | extension.ts | |
| Show commit from gutter | `intellig.editor.showCommit` | ✅ | extension.ts | |
| Ignore whitespace changes | — | ❌ | not found | No `-w` option |
| Detect movements within/across files | — | ❌ | not found | No `-M` / `-C` options |
| Annotate previous revision | — | ❌ | not found | |
| Hide revision (filter administrative commits) | — | ❌ | not found | |
| Hover popup with commit details | BlameService hover contributions | ✅ | BlameService.ts | |

## Shelve

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Create shelf | `intellig.shelve` → ShelfService.shelve | ✅ | ShelfService.ts, ShelfView.ts | Stored in `.git/intellig-shelf.json` (async fs per PERF-08) |
| Unshelve | ShelfService.unshelve | ✅ | ShelfService.ts | |
| Silent shelve (Ctrl+Shift+H use-changelist-name) | — | ❌ | not found | |
| Silent unshelve (Ctrl+Alt+U) | — | ❌ | not found | |
| Preview diff before apply | getShelfDiff | ✅ | ShelfService.ts | |
| Rename shelf | — | ❌ | not found | |
| Delete shelf | deleteShelfItem | ✅ | ShelfService.ts | |
| "Remove successfully applied files from shelf" | — | ❌ | not found | |
| Drag shelf → Commit tab (Ctrl-to-copy) | — | ❌ | not found | |
| Already-Unshelved filter / restore | — | ❌ | not found | |
| Import patches into shelf | — | ❌ | not found | |
| Combined Stash+Shelf tab | — | ❌ | not found | |

## Stash

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Create stash | `intellig.stash`, GitService.stash | ✅ | extension.ts:324, GitService.ts:687 | Message, include-untracked, keep-index all plumbed |
| Apply stash | stashApply | ✅ | GitService.ts:715 | |
| Pop stash | stashPop | ✅ | GitService.ts:723 | |
| Drop stash | stashDrop | ✅ | GitService.ts:731 | |
| List stashes | stashList (format `%gd\x1e%aI\x1e%gs`) | ✅ | GitService.ts:704 | BUG-11 fixed — real timestamps |
| Preview stash | stashShow | ✅ | GitService.ts:746 | |
| Stash view | `intellig.showStashList`, StashView.ts | ✅ | extension.ts:363 | QuickPick |
| Create branch from stash (`git stash branch`) | — | ❌ | not found | |
| Stash right-click context menu (rename / preview / branch-from-stash) | — | 🟡 | StashView.ts | apply/pop/drop present; rename & branch-from missing |

## Changelists

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Create / rename / delete changelist | ChangelistService.create/rename/delete | ✅ | ChangelistService.ts | Async fs (PERF-08) |
| Set active / default | setDefaultChangelist | ✅ | ChangelistService.ts | |
| Move files between changelists | moveToChangelist | ✅ | ChangelistService.ts | |
| Commit a specific changelist | — | ❌ | not found | No UI to commit-one-changelist |
| Shelve a changelist (silent) | — | ❌ | not found | |
| Changelist tree / UI surface | — | ❌ | not found | Service-only; no tree provider or webview pane for changelists |
| Changelist context menu (new / rename / remove / edit-description / set-active) | — | ❌ | not found | |

## Patches

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Create patch from commit | `createPatch` action in commit menu | ✅ | CommitContextMenuCommands.ts:351 | Writes `.patch` file |
| Create patch from local changes | — | ❌ | not found | |
| Create patch from file-history revision | — | ❌ | not found | |
| Apply patch (file / clipboard) | — | ❌ | not found | No apply-patch command |
| Map base-dir / strip leading directories | — | ❌ | not found | |
| Assign patch to changelist on apply | — | ❌ | not found | |
| Clipboard target for patch | — | ❌ | not found | Only file output |

## File & line history

| Feature | Command / Entry | Status | File:line | Notes |
|---|---|---|---|---|
| Show history for file | `intellig.explorer.showHistory`, `intellig.showHistory` | ✅ | extension.ts:1288 | QuickPick, not tabbed panel |
| Show history for selection / line | `intellig.editor.showLineHistory` | ✅ | extension.ts:1655 | |
| Follow file rename across history | — | ❌ | not found | No `--follow` usage |
| Filter history by branch | — | ❌ | not found | |
| Diff any two revisions from history | — | ❌ | not found | |
| Compare revision with local | compareWithLocal action | ✅ | CommitContextMenuCommands.ts:264 | From log, not history view |
| Open revision content (read-only) | `intellig-git:` URI provider | ✅ | extension.ts:2311 | BUG-03 fixed |
| Create patch from revision | — | 🟡 | CommitContextMenuCommands.ts:351 | Available from log commit menu |
| Get/rollback file to revision | — | ❌ | not found | No "revert-to-revision" per-file action |
| Annotate previous revision (from blame) | — | ❌ | not found | |

## UI structure (tool windows / panels)

| Surface | Status | File:line | Notes |
|---|---|---|---|
| **Activity bar / panel container `intellig`** | ✅ | package.json:530 | One container, in panel area (not sidebar) |
| **Commit tool window (non-modal, Alt+0 equivalent)** | 🟡 | — | Commit surfaces as webview panel (floating) only. No persistent Commit tool window / Alt+0. Shelf and Local Changes tabs absent. |
| **Git tool window (Alt+9 equivalent)** | 🟡 | GitToolWindowProvider.ts | Single-view webview. No Log / Console / Repository / Incoming / Update Info / History tabs. Keybinding `alt+9` bound to `openGitToolWindow`. |
| **Log tab 4-pane layout** (Branches ‖ Commits ‖ Changed Files ‖ Details) | 🟡 | GitToolWindowProvider.ts | Currently 2-pane (graph + combined details); right side does not split files vs metadata |
| **Branches popup** (QuickPick sectioned) | 🟡 | BranchPopup.ts | Single flat picker; no Recent / Favorites / Tags sections; no search-filter chip; no grouping by `/` |
| **Branches tree view** | ✅ | BranchTreeProvider.ts | Panel tree with Local/Remote |
| **Branch comparison view** | ✅ | BranchComparisonView.ts | |
| **Shelf tab** (inside Commit tool window) | ❌ | ShelfView.ts | Exists as QuickPick, not a tabbed panel |
| **Stash tab** / combined Stash+Shelf | ❌ | StashView.ts | QuickPick only |
| **Console (raw command output) tab** | 🟡 | ConsoleService.ts | Service streams (BUG-16 fixed); no visible tab/webview |
| **Push dialog** | ❌ | — | |
| **Pull dialog** | ❌ | — | |
| **New Tag dialog** | ❌ | — | |
| **Reset dialog** (radio soft/mixed/hard/keep) | ❌ | — | QuickPick mode picker only, no "keep" |
| **Merge dialog** (no-ff / squash / no-commit) | ❌ | — | |
| **New Branch dialog** (tracking / overwrite) | ❌ | — | Input box only |
| **Rebase progress status-bar** | ✅ | RebaseProgressView.ts | |
| **Status-bar branch indicator** | ✅ | StatusBarService.ts | `intellig.showStatusBarBranch` config |

## Right-click / context menus (wired)

| Location | Wired items | Missing vs IntelliJ |
|---|---|---|
| **Branch tree — local current branch** (package.json:333) | newBranchFrom, update, push, rename | `Checkout & Update`, `Merge into Current` (no self-merge), `Rebase Current onto…`, `Compare with…`, `Push...` dialog, `Tag at HEAD` |
| **Branch tree — local branch (non-current)** (package.json:352) | checkout, newBranchFrom, checkoutAndRebase, compareWithCurrent, showDiffWithWorkingTree, rebaseCurrentOnto, mergeIntoCurrent, update, push, rename, delete | `Checkout and Update` (separate item), push-dialog, restore-after-delete |
| **Branch tree — remote** (package.json:406) | checkoutAsLocal, newBranchFrom, checkoutAndRebase, compareWithCurrent, showDiffWithWorkingTree, rebaseCurrentOnto, mergeIntoCurrent, pullUsingRebase, pullUsingMerge, deleteRemote | `Cherry-Pick Commits` (registered as command but not in menu), `Compare with Working Tree`, `Pull into Current Using…` labels |
| **Tag tree item** | — **no menu entries declared in package.json** | 🔴 Gap: `intellig.tag.*` commands exist but `viewItem == intellig.tag` menu group is missing from `view/item/context` |
| **Log commit right-click** (dispatched in webview) | copyHash, cherryPick, revert, checkoutRevision, resetToHere, createPatch, showRepoAtRevision, compareWithLocal, undoCommit, dropCommit, editCommitMessage (stub), mergeIntoCurrent, interactiveRebase | `New Branch…`, `New Tag…`, `Compare with HEAD`, `Compare with…` (arbitrary ref), `Show File in Revision`, `File History from Here`, `Show Diff`, `Copy Revision Number` label (currently `Copy hash`), `Reword / Squash / Fixup` (available only via rebase editor), `Show all Branches for this Commit` |
| **Explorer context menu (on file)** (package.json:458) | showHistory, showDiff, compareWithBranch, stage, unstage, revert | `Add to VCS`, `Annotate with Git Blame`, `Rollback…` label, `Create Patch from File…`, `Apply Patch…`, `Compare with Revision…`, `Compare with the Same Repository Version` |
| **Editor context menu** (package.json:491) | toggleBlame, showLineHistory, copyCommitHash, showCommit | `Annotate`/`Rollback`/`Show History`, `Show Commit Dialog on Selection`, `Apply Patch` |
| **Changelist context menu** | — | ❌ Missing entirely (no changelist view exists) |
| **Shelf context menu** | — | ❌ Missing (ShelfView is QuickPick, not contextual tree) |
| **Stash context menu** | apply, pop, drop (via QuickPick actions) | Rename, branch-from-stash, diff-preview action |
| **Gutter blame context menu** | — | ❌ No right-click menu on blame gutter; only commands bound |

## Keybindings (from package.json)

| Key | Command | Mac | When | Notes |
|---|---|---|---|---|
| Ctrl+K | intellig.commit | Cmd+K | !inDebugMode | |
| Ctrl+Shift+K | intellig.push | Cmd+Shift+K | — | (Push itself is a stub) |
| Ctrl+T | intellig.pull | Cmd+T | — | Maps to Update Project in IntelliJ (but Pull is stub) |
| Alt+9 | intellig.openGitToolWindow | Cmd+9 | — | |
| Ctrl+Shift+\` | intellig.showBranchPopup | Cmd+Shift+\` | — | |
| Ctrl+Shift+R | intellig.refresh | Cmd+Shift+R | — | |
| Ctrl+Alt+A | intellig.stageSelected | Cmd+Alt+A | — | |
| Ctrl+Alt+Z | intellig.unstageSelected / intellig.revertFile | Cmd+Alt+Z | — | Rollback semantics |
| Alt+↓ / Alt+↑ | merge next/prev conflict | — | mergeView active | |
| Alt+1/2/3 | merge acceptCurrent/acceptBoth/acceptIncoming | — | mergeView active | |
| Alt+\` | intellig.showBranchPopup | same | `useIntelliJKeymap` | IntelliJ VCS popup key |
| Ctrl+Alt+Shift+A | intellig.toggleBlame | Cmd+Alt+Shift+A | editorTextFocus, IntelliJ keymap | |
| Ctrl+H | intellig.showHistory | Cmd+Shift+H (OTHER-07 fixed) | IntelliJ keymap | |
| Ctrl+D | intellig.branch.compareWithCurrent | Cmd+D | IntelliJ keymap | |

Missing shortcuts vs IntelliJ reference: Ctrl+Shift+H (silent shelve), Ctrl+Shift+U (unshelve), Ctrl+Alt+U (silent unshelve), Shift+Esc / Ctrl+Shift+F12 (hide tool windows — platform-provided but unbound), F4 (jump to source), F6 (move to changelist), Ctrl+F in log (go-to-hash).

## Configuration keys (from package.json)

`intellig.defaultCommitSignOff`, `intellig.commitMessageTemplate`, `intellig.pullRebase`, `intellig.autoFetchEnabled` (default true), `intellig.autoFetchInterval` (180s), `intellig.blameAnnotationStyle` (inline/gutter/both), `intellig.showStatusBarBranch`, `intellig.useIntelliJKeymap`, `intellig.keymapPreset` (default/intellij), plus five `intellig.*FileColor` keys.

## Key internal infrastructure (not user-facing)

| Component | Purpose | File:line |
|---|---|---|
| `GitService` | Core git wrapper + repository state | services/GitService.ts |
| `GitCacheManager` | LRU/TTL caches (branches 10s, status 5s, log 30s, blame 30s, diff 10s) | utils/cache.ts |
| `gitParser` | `\x1e`-separator parsing of log/branches/tags/stash/blame (BUG-04/05/11 fixed) | utils/gitParser.ts |
| `commitGraph` / `optimizedCommitGraph` / `graphRenderer` | SVG graph construction + simplified-mode threshold | utils/*.ts |
| `ExtensionServices` | Service-locator container | services/ExtensionServices.ts |
| `ConflictResolutionService` | Unified merge/rebase/cherry-pick/revert conflict workflow | services/ConflictResolutionService.ts |
| `CommandTitleProvider` | Dynamic-title scaffolding (shadow commands removed per BUG-18) | commands/CommandTitleProvider.ts |
| `TextDocumentContentProvider` for `intellig-git:` | Read-only revision content provider | extension.ts:~2311 |
| `KeymapService` | Runtime rebinding for IntelliJ preset | services/KeymapService.ts |
| `NotificationService` | Centralized toast/error wrapper | services/NotificationService.ts |
| `ConfigurationService` | VS Code settings facade | services/ConfigurationService.ts |
| `ConsoleService` | Streaming command-output log (streaming fix BUG-16) | services/ConsoleService.ts |

---

## Known gaps observed while reading

1. `intellig.push`, `intellig.pull`, `intellig.fetch` are literal "Coming Soon" stubs despite their underlying `GitService` methods being fully implemented.
2. `intellig.autoFetchEnabled/Interval` config exists but no `setInterval` or timer-based fetch scheduler appears in `extension.ts` activation path.
3. Tag tree items have wired commands (`intellig.tag.*`) but no `view/item/context` menu binding — the context menu on tags in the tree is empty.
4. No "New Tag" command or dialog exists in `package.json contributes.commands`; `GitService.createTag` is reachable only programmatically.
5. `ChangelistService` is fully implemented (create/rename/delete/move/setDefault) but **has no UI** — no tree provider, no webview, no context menu, no visible changelist concept.
6. Commit dialog is modal-style (spawned on demand); there is no persistent Commit tool window with tabs for Local Changes / Shelf (unlike IntelliJ's Alt+0).
7. Git tool window is a single 2-pane webview; no separate Log / Console / Incoming / Update Info / History tabs.
8. Branches popup is a flat QuickPick — no Favorites, Recent, Tags sections, no grouping, no filter chip.
9. Reset is offered as a QuickPick of "Soft / Mixed / Hard" — missing "Keep" and not presented as a radio dialog with target-commit display.
10. There is no Push dialog / Pull dialog / Merge dialog / New Branch dialog / New Tag dialog — all these paths are `showInputBox` or `showQuickPick`.
11. `intellig.branch.showDiffWithWorkingTree` has a TODO comment acknowledging the directory-URI limitation (BUG-17).
12. Patch apply (`git apply` / `git am`) is not wired at all; only patch creation from a commit exists.
13. Multi-root: repos are discovered and a repository picker exists in the tool window, but most commands target `repositories[0]`.
