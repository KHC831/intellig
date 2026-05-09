# IntelliJ IDEA Core Git Features — Reference

_Status: complete. Note: parity target is feature coverage **plus** UI layout / right-click menu structure — each section lists the IntelliJ UI surface where actions live (VCS widget, Branches popup, Log tab, Commit tool window, annotate gutter, etc.) so surfaces can be matched, not just capabilities._

## Sources fetched
- commit-and-push-changes → commit dialog staging/checks/amend/sign-off; push dialog force-with-lease, push tags, new remote branch
- manage-branches → branches popup list/checkout/new/merge/rebase/compare/rename/delete/push/update, favorites, multi-root
- set-up-a-git-repository → enable VCS, clone, init, git executable, multi-root, remotes, ignore files
- resolve-conflicts → three-pane merge view, accept left/right/both, auto-merge non-conflicting, manual edit, conflict navigation
- apply-changes-from-one-branch-to-another → cherry-pick single/multiple/without-commit, apply selected changes, apply files to branch
- investigate-changes → log filters, navigation, commit details, file history, external hosting links
- edit-project-history → interactive rebase pick/reword/edit/squash/fixup/drop/reorder + abort/continue/skip
- investigate-changes#annotate_blame → annotate gutter, ignore whitespace, detect movements, annotate previous revision, hide revision
- use-tags-to-mark-specific-commits → create lightweight/annotated, push (individual or all), delete, checkout, jump-to-tag
- undo-changes → revert, reset soft/mixed/hard/keep, undo last commit, drop commit (force push), drop selected changes
- sync-with-a-remote-repository → fetch, pull (flags: --rebase/--ff-only/--no-ff/--squash/--no-commit), update branch, update project (merge/rebase/reset), auto-fetch
- create-patch → create from local changes / from commit / from file history; clipboard or file; apply patch with base-dir mapping, diff preview, assign-to-changelist
- (shelve): fetched subset via shelve-changes → create, silent shelve, unshelve, silent unshelve, preview, remove-on-apply, multi-root
- version-control-tool-window → VC tool window tabs (Local Changes, Log, Console, Repository, Incoming, Update Info, History)
- log-tab → Log tab 4-pane layout (Branches L / Commits center / Changed Files R / Details bottom-R) + commit context menu
- commit-and-push-changes (push dialog section) → Push dialog structure, force-with-lease, edit targets, push tags
- shelving-and-unshelving-changes → Shelf tab pane + right-click (Unshelve, Unshelve Silently, Show Diff, Delete, Rename, Restore, Import Patches)
- undo-changes (reset dialog) → Reset dialog radios soft/mixed/hard/keep + target commit

## Weakly sourced areas
- **Changelists** — dedicated docs page 404'd (`work-with-changelists`, `change-lists`, `local-changes-view`, `local-changes`); description drawn from general Git commit/shelve docs + general IntelliJ knowledge (uncertain on exact sub-ops).
- **File & line history** — dedicated `file-history` page 404'd; description drawn from `investigate-changes` "File History Features" section.
- **Using-git-integration overview** — 404 on canonical overview URL; replaced with `set-up-a-git-repository`.
- **VCS menu / Project-view Git submenu exact labels & order** — 404 on `vcs-menu` and `version-control-integration` details. Labels below are (inferred) from long-standing IntelliJ conventions.
- **Merge dialog & Rebase editor dialog exact layout** — no dedicated doc found; described from operation docs + (inferred).
- **Keyboard shortcuts** — `keyboard-shortcuts-you-cannot-miss` only listed one VCS shortcut. Common defaults below marked (inferred) where not directly sourced.

## Features

### Commit
- **Commit dialog**: stage files and granular hunks
  - Stage entire files or specific code chunks
  - Partial (line-level) staging via "Split Chunks and Include Selected Lines"
  - Interactive three-way diff view during commit
  - Commit tool window (non-modal) vs modal dialog
- **Pre-commit checks**: configurable batch run before commit
  - Reformat code, rearrange code, optimize imports
  - Run inspection profile / batch quick-fix cleanup
  - Update copyright notices
  - Detect malicious dependencies (uncertain — verify)
  - Run code analysis on modified files
  - TODO review with filters
  - Run tests as commit check
  - Git hook execution (toggleable)
- **Amend commit**: toggle to amend HEAD in commit dialog
- **Sign-off**: append `Signed-off-by: <user>` via checkbox
- **Commit author**: override author on this commit
- **Commit message**: history browser of recent messages; custom templates via `.git/hooks`
- **Post-commit**: optional upload of files to server/FTP (uncertain — verify)

### Branches
- **Branches popup** (VCS widget, Git tool window Branches pane, Log context menu):
  - List local, remote, tags nodes
  - Recent branches node (up to 5)
  - Search / filter branches
  - Favorites (starred, pinned to top)
  - Auto-group branches by `/` prefix
- **Create**: new branch from HEAD, from selected branch, from selected commit
- **Checkout**: switch to local; checkout remote as local; "Checkout and Rebase onto Current"
- **Checkout and Update** (sync with remote while switching)
- **Rename** local branch (with option to rename upstream)
- **Delete** local/remote branch (with restore option if unmerged)
- **Merge into current**
- **Rebase current onto selected**
- **Compare** branch vs current or vs working tree; two-dot "commits in one not in other"; swap comparison
- **Push** branch (also push to new remote branch via Push dialog)
- **Update** branch (pull with merge or rebase strategy)
- **Remote-only actions**: remove remote tracking branch
- **Multi-root**: synchronous branch ops across all roots; divergence warning

### Log & history
- **Log tab (Git tool window)** commit list across branches + remotes
  - Commit graph, messages, metadata; inlay hints for author
  - Toggle Git Log Indexing for faster search
  - Date format, show/hide details/diff preview
- **Filters**
  - Branch or favorite branches
  - User/author
  - Date range
  - Folder / path (or root+folder in multi-repo)
  - Text search: hash / message fragments / regex
- **Navigation**
  - Jump to commit by hash / tag / branch (Ctrl+F)
  - Parent/child navigation (arrow keys)
  - Next commit in branch
  - New filtered tab (preserve current filters)
- **Commit details pane**
  - Changed files list
  - Diff viewer (Ctrl+D)
  - Compare two commits
  - Compare selected revision with local
  - Merge commit: three-panel diff vs each parent
- **Commit actions from log**
  - Create branch / create tag from commit
  - Checkout revision (detached HEAD)
  - Reset current branch to this commit
  - Revert commit
  - Cherry-pick
  - Copy hash
  - Show file in revision
  - File history from here
  - Interactive rebase (reword/squash/fixup/drop/edit/pick)
- **External integration**: open on GitHub / GitLab; jump to issue tracker

### Merge & conflict resolution
- **Three-pane merge view**: Local (left) | Result (center, editable) | Repository (right)
- **Accept actions**:
  - Accept yours (left)
  - Accept theirs (right)
  - Accept both (resolves conflict by keeping both)
  - "Resolve using Left" / "Resolve using Right" shortcuts
- **Apply all non-conflicting changes** simultaneously via toolbar
- **Manual edit** in center pane (full editor)
- **Conflict navigation**: next/prev conflict; Merge Conflicts node in Commit tool window
- **Color-coded** modified/deleted/added/conflicting lines
- **Triggered by**: merge, rebase, cherry-pick, pull, unstash/unshelve, patch apply
- **Comparison** across base/local/repo/result versions
- **CRLF/LF auto-detection** with `core.autocrlf` hint
- **Merge history review** via Log commit details

### Rebase (including interactive)
- **Plain rebase**: rebase current branch onto selected branch (from Branches popup)
- **Interactive rebase actions** (triggered from Log tab right-click on commit → "Interactively Rebase from Here"):
  - **pick** — keep commit
  - **reword** — edit commit message
  - **edit** — stop at commit to amend content / split
  - **squash** — combine with previous, merge messages
  - **fixup** — combine with previous, discard message
  - **drop** — remove commit
  - **reorder** — drag to rearrange
- **Workflow controls**: abort, continue, skip (via VCS widget / status bar)
- **Conflict resolution during rebase** via three-pane merge view
- **Checkout and Rebase onto Current** (from Branches popup)

### Cherry-pick
- **Single commit** from Log via Cherry-Pick button / context menu
- **Multiple commits** (multi-select)
- **Cherry-pick without commit** — leaves changes staged for review
- **Highlight non-picked commits** (log decoration to show what has not yet been cherry-picked between branches)
- **Conflict handling** — surfaces in Commit tool window; abort/continue via VCS widget
- **Apply Selected Changes** — apply changes from specific files within a commit to a changelist (not a full cherry-pick)
- **Apply Files to Branch** — copy whole file contents from another branch; diff preview w/ color markers; swap branches

### Reset & revert
- **Revert commit** — creates new commit reversing; selective file-subset revert from multi-file commit
- **Reset current branch** to commit — four modes:
  - **Soft** — changes staged
  - **Mixed** — changes preserved unstaged
  - **Hard** — discard all
  - **Keep** — discard committed, retain local uncommitted
- **Undo Last Commit** — moves changes to a changelist; blocked on protected branches
- **Drop commit** — removes pushed commit via force push; blocked on protected branches
- **Drop selected changes** — remove specific file changes from an un-pushed commit (unrecoverable)

### Remote ops (push/pull/fetch)
- **Fetch**
  - Git menu, VCS widget, auto-fetch (default 20 min)
  - Fetch all remotes
  - VCS widget incoming-commits indicator
- **Pull**
  - Choose remote (default `origin`)
  - Flags: `--rebase`, `--ff-only`, `--no-ff`, `--squash`, `--no-commit`, `--no-verify`
- **Update Branch** — fetch + apply per configured merge/rebase strategy
- **Update Project** (Ctrl+T)
  - All roots, all tracked branches
  - Strategies: Merge / Rebase / Reset to Remote Branch
  - "Update Info" tab lists commits since last sync
- **Push**
  - Push current or selected local branch
  - Push to new remote branch (edit target name in Push dialog)
  - "Push All up to Here" (commit-range push)
  - Preview diff before push
  - Force-with-lease
  - Push tags (all / branch tags only)
  - Auto-rebase or auto-merge on rejection
  - Multi-repo synchronous push
- **Remotes**
  - Add/edit/remove via Git | Manage Remotes or Push dialog
  - Multiple remotes for forks
  - Password storage: Keychain / KeePass / session

### Tags
- **Create lightweight tag** from Log context menu → "New Tag"
- **Create annotated tag** via Git | New Tag (commit + message)
- **Delete tag** via Log commit context menu or Git tool window Tags node
- **Checkout tag** (results in detached HEAD; prompts for branch-from-tag)
- **Push tags** — individually from context menu, or "Push tags" during commit push (all / branch tags)
- **Jump to tag** via Go To Hash/Branch/Tag (Ctrl+F)
- **Fetch tags setting**: Auto / Sync / Always / Never

### Blame / annotate
- **Gutter annotation** — per-line author + date, color-coded by commit; current-revision lines bolded with asterisk
- **Hover popup** — commit details on annotation hover
- **Highlight lines from same commit** on hover
- **Jump to commit** in Log by clicking annotation
- **External link**: open commit on GitHub / GitLab
- **Issue tracker link** from commit message (if configured)
- **Options**
  - Ignore whitespace changes
  - Detect movements within file
  - Detect movements across files
- **Annotate Previous Revision** — useful when HEAD change is trivial
- **Hide Revision** — filter administrative commits from blame
- (uncertain — verify) Inline "current line blame" overlay — not explicitly documented in fetched pages but commonly present

### Shelve
- **Create shelf** — from Commit tool window context menu; select files; name via commit-message field
- **Silent shelve** — Ctrl+Shift+H, uses changelist name as shelf name
- **Unshelve** — Ctrl+Shift+U; target existing or new changelist; "Remove successfully applied files from shelf" toggle
- **Silent unshelve** — Ctrl+Alt+U (instant unshelve to active changelist)
- **Drag shelf → Commit tab** (Ctrl = copy, keep shelf)
- **Preview** — double-click shelf file to diff before apply
- **Delete shelf** — right-click → Delete
- **Already Unshelved tracking** — reapply previously-applied shelves
- **Base revision storage** — for conflict resolution on unshelve
- **Custom shelf directory** in Version Control settings
- **Combined view** — Stash + Shelf tabs merged into one (optional)
- **Multi-root** — Git root selector in shelve dialog

### Stash
- **Create stash** — Git | Uncommitted Changes | Stash Changes; optional message; includes untracked (toggle)
- **Pop stash** — apply + drop
- **Apply stash** — apply, keep in stash list
- **Drop stash** — delete a stash entry
- **List stashes** in Stash tab / combined Stash+Shelf tab
- **Preview** diff before apply
- **Conflict resolution on unstash** via three-pane merge view
- (uncertain — verify) Stash branch creation (`git stash branch`) availability

### Changelists
- **Create changelist** (named group of modified files)
- **Set active / default** changelist — new changes land here
- **Move files between changelists** (drag or context menu)
- **Rename / edit description** of changelist
- **Delete changelist** (reassigns files to default)
- **Commit a specific changelist** — other changelists stay uncommitted
- **Shelve a changelist** (silent shelf uses changelist name)
- **Apply Selected Changes → changelist** (from another commit or patch)
- **Diff vs. active changelist** (uncertain — verify)
- Note: IntelliJ changelists are a client-side construct layered on the index (not pure git). They interact with partial-staging and shelf workflows.

### Patches
- **Create patch**
  - From uncommitted local changes (Commit tool window → "Create Patch from Local Changes")
  - From commit (Log tab → context → Create Patch)
  - From file history revision
  - Options: base path, reverse patch, output to file or clipboard
- **Apply patch**
  - Git | Patch | Apply Patch (file or clipboard)
  - Map base directory if paths differ
  - Strip/manage leading directory path elements
  - Show Diff preview (red-highlights conflicts)
  - Assign to existing or new changelist
  - Auto-extract metadata from git-format patches (commit fields pre-populated)

## UI Structure & Menus

### Tool windows & panel layout

- **Commit tool window** (`Alt+0`) — non-modal commit surface
  - Top: **Changelist panel** (tree of changelists w/ modified + unversioned files)
  - Middle: **Commit message field** with history dropdown (recent messages)
  - Bottom buttons: `"Commit"` (Ctrl+K), `"Commit and Push…"` (Ctrl+Alt+K)
  - Toolbar icons: Diff (Ctrl+D), Gear/Settings (Ctrl+O), history-of-messages
  - Gear menu sections: `Commit Checks` (Reformat code, Rearrange code, Optimize imports, Cleanup, Check malicious dependencies) · `Advanced Commit Checks` (Analyze code, Check TODO, Run Configuration) · `After Commit` (upload to server)
  - `Ctrl+K` selects entire active changelist
  - Shelf tab is shown alongside (combined view optional)

- **Git tool window** (`Alt+9`) — investigation surface, tabbed:
  - `"Log"` — Git/Mercurial only, cross-branch commit graph
  - `"Console"` — raw VCS command output
  - `"Repository"` — commits under VCS roots (uncertain — verify relationship to Log)
  - `"Incoming"` — commits pulled but not checked out
  - `"Update Info"` — appears after fetch/pull, lists new commits
  - `"History"` — appears on Show-History-for-File invocation
  - Title-bar: Hide (Shift+Esc), Hide all tool windows (Ctrl+Shift+F12), mode/position configure

- **Log tab layout** (4 panes):
  - **Left pane** — Branches tree (local / remote / tags / favorites / recent)
  - **Center pane** — Commits graph (author, timestamp, branch/tag labels on tip commits)
  - **Right-top pane** — Changed Files for selected commit
  - **Right-bottom pane** — Commit Details (message, hash, author, signature, parents)
  - Toolbar above commits: search field (regex, case), filter chips (Branch, User, Date, Paths), graph-customization, `"Cherry-pick"` button, presentation/settings gear

- **Branches popup** (VCS widget click, or `Ctrl+Shift+\`` inferred):
  - Sections (top-to-bottom): `Recent` (≤5) · `Local` · `Remote` · `Tags`
  - Search/filter field at top
  - Favorites starred and pinned
  - Auto-group by `/` prefix

- **Shelf tab** (inside Commit tool window)
  - List of shelved changesets; expand to show files
  - Diff preview pane below on selection
  - Filter toggles incl. `"Already Unshelved"`

### Right-click / context menus

- **Log commit context menu** (sourced, partial order):
  1. `"New Branch…"`
  2. `"New Tag…"`
  3. `"Checkout Revision"`
  4. `"Reset Current Branch to Here…"`
  5. `"Revert Commit"`
  6. `"Cherry-Pick"`
  7. `"Interactively Rebase from Here…"`
  8. `"Create Patch…"`
  9. `"Compare with Local"`
  10. `"Copy Revision Number"`
  - (inferred) `"Compare with HEAD"`, `"Show Diff"`, `"Edit Commit Message"` (reword) on unpushed HEAD, `"Squash Commits"`, `"Fixup"`, `"Drop Commit"`, `"Show all Branches for this Commit"`

- **Branches popup — local branch context menu** (sourced):
  1. `"Checkout"`
  2. `"Checkout and Update"` (and/or `"Checkout and Rebase onto Current"` — inferred split)
  3. `"New Branch from Selected…"`
  4. `"Rename…"`
  5. `"Merge into Current"`
  6. `"Rebase Current onto Selected"`
  7. `"Compare with Current"`
  8. `"Show Diff with Working Tree"`
  9. `"Delete"`
  10. `"Push…"`
  11. `"Update"`

- **Branches popup — remote branch context menu** (sourced):
  1. `"Checkout"` (creates tracking local)
  2. `"Pull into Current Using Merge"` / `"Pull into Current Using Rebase"` (variants — inferred split)
  3. `"Merge"`
  4. `"Rebase"`
  5. `"Compare"`
  6. `"Update"`
  7. `"Delete"` (remove remote tracking ref)

- **Branches popup — tag context menu** (sourced, less detail): `"Checkout"`, `"Compare with working tree"`, `"Merge"`, `"Push"`, `"Delete"` (labels inferred)

- **Local Changes / changelist context menu** (inferred — page 404'd):
  1. `"Commit…"` (Ctrl+K)
  2. `"Show Diff"` (Ctrl+D)
  3. `"Jump to Source"` (F4)
  4. `"Rollback…"` / `"Revert"` (Ctrl+Alt+Z)
  5. `"Shelve Changes…"` (Ctrl+Shift+H silent)
  6. `"Move to Another Changelist…"` (F6)
  7. `"Add to VCS"` (Ctrl+Alt+A for unversioned)
  8. `"Delete"` (for unversioned)
  9. `"Show History"`
  10. `"Annotate with Git Blame"`
  - On changelist node: `"New Changelist…"`, `"Set Active Changelist"`, `"Rename Changelist…"`, `"Remove Changelist"`, `"Edit Description"`

- **Shelf context menu** (sourced):
  1. `"Unshelve Changes…"` (Ctrl+Shift+U) — opens dialog
  2. `"Unshelve Silently"` (Ctrl+Alt+U)
  3. `"Restore"` (visible with Already-Unshelved filter)
  4. `"Show Diff"` (Ctrl+D)
  5. `"Rename…"`
  6. `"Delete"`
  7. `"Import Patches…"` (on root / empty area)

- **Editor gutter — blame annotation context menu** (sourced, labels partially inferred):
  - `"Show Commit"` / jump to commit in Log
  - `"Copy Revision Number"`
  - `"Annotate Previous Revision"`
  - `"Hide Revision"`
  - Options submenu: `"Ignore Whitespaces"`, `"Detect Movements Within File"`, `"Detect Movements Across Files"`
  - `"Open on GitHub"` / `"Open on GitLab"` (when configured)
  - `"Show Diff"` against prior revision (inferred)

- **Project tool window — Git submenu** (inferred exact labels; the submenu is standard on any versioned file/folder):
  1. `"Commit File…"` (Ctrl+K for active file)
  2. `"Add to VCS"` (Ctrl+Alt+A)
  3. `"Annotate with Git Blame"`
  4. `"Show History"`
  5. `"Show Current Revision"`
  6. `"Show Diff"` / `"Compare with…"` submenu → `"Compare with Branch…"`, `"Compare with Revision…"`, `"Compare with the Same Repository Version"`
  7. `"Rollback…"` (Ctrl+Alt+Z)
  8. `"Revert"`
  9. `"Shelve Changes…"`
  10. `"Create Patch…"`
  11. `"Apply Patch…"`
  12. `"Push…"`, `"Pull…"`, `"Fetch"` (from VCS menu root)

### Dialog layouts

- **Commit dialog (modal variant)** — same sections as Commit tool window; checkboxes for `"Amend commit"`, `"Sign-off commit"`, `"Run before-commit checks"`; author override field; commit/commit-and-push button
- **Push dialog** (sourced):
  - Left: repositories with branch → remote-branch rows; each row shows commits since last push; multi-repo selection
  - Right: commit preview pane (diff on Enter)
  - Click branch name → inline editable (type existing or new branch name)
  - Bottom-right link: `"Edit all targets"`
  - Bottom checkbox: `"Push tags"` → sub-option (all tags / `--follow-tags`)
  - Bottom button: `"Push"` with dropdown → `"Push"` or `"Force Push"` (`--force-with-lease`)
  - Protected-branches restrict Force Push
  - Commits by other authors marked with asterisk
- **Pull dialog**: remote dropdown, branch list, flag checkboxes (`--rebase`, `--ff-only`, `--no-ff`, `--squash`, `--no-commit`, `--no-verify`), `"Pull"` / `"Cancel"`
- **New Branch dialog** (inferred): name field, `"Checkout branch"` checkbox, `"Overwrite if exists"` option, `"Set as tracking"` for upstream
- **Merge dialog** (inferred): branch dropdown, `"No fast-forward"`, `"Squash commit"`, `"Don't commit after merge"` checkboxes, commit message field, `"Merge"` button
- **Interactive Rebase editor**: list of commits in chronological order; action dropdown per row (`"pick"` / `"reword"` / `"edit"` / `"squash"` / `"fixup"` / `"drop"`); drag handles to reorder; `"Start Rebasing"` / `"Cancel"`; status shows "Rebasing onto ..."
- **Resolve Conflicts dialog**: file list showing conflicted files with status markers; per-row buttons `"Accept Yours"`, `"Accept Theirs"`, `"Merge…"` (opens three-pane)
  - **Three-pane merge view**: `Local (left)` | `Result (center, editable)` | `Repository (right)`; arrows per change to accept/skip; toolbar buttons `"Apply All Non-Conflicting Changes"`, `"Apply Non-Conflicting Changes from Left Side"`, `"Apply Non-Conflicting Changes from Right Side"`; `"Apply"` and `"Abort"` at bottom
- **Reset Current Branch to Here dialog** (sourced): four radio buttons — `"Soft"`, `"Mixed"`, `"Hard"`, `"Keep"` — with descriptions; target commit hash displayed; `"Reset"` + `"Cancel"` buttons

### Keyboard shortcuts

Sourced or widely-known IntelliJ defaults (Win/Linux; macOS substitutes Cmd for Ctrl where applicable):

- `Alt+\`` — **VCS Operations Popup** (sourced)
- `Ctrl+K` — **Commit** (inferred, universally known)
- `Ctrl+Shift+K` — **Push** (inferred)
- `Ctrl+T` — **Update Project** (sourced in sync doc)
- `Ctrl+D` — **Show Diff** (sourced in Log tab doc)
- `Ctrl+Alt+Z` — **Rollback / Revert** (inferred)
- `Ctrl+Alt+A` — **Add to VCS** (inferred)
- `Ctrl+Shift+H` — **Shelve Silently** (sourced)
- `Ctrl+Shift+U` — **Unshelve…** (sourced)
- `Ctrl+Alt+U` — **Unshelve Silently** (sourced)
- `Ctrl+F` (in Log) — **Go to Hash/Branch/Tag** (sourced)
- `Alt+0` — **Commit tool window** (sourced)
- `Alt+9` — **Git tool window** (sourced)
- `Shift+Esc` — **Hide current tool window** (sourced)
- `Ctrl+Shift+F12` — **Hide all tool windows** (sourced)
- (inferred) `Ctrl+Shift+Alt+K` — Edit Commit Message / reword current
- (inferred) `F4` — Jump to Source from Local Changes
- (inferred) `F6` — Move to Another Changelist

### File & line history
- **Show History for File** — full revision list with messages, authors, dates
- **Show History for Selection** — line/block-scoped history (annotate-line-history equivalent)
- **Follow file rename** across history
- **Filter file history by branch**
- **Diff preview inline** in history view
- **Diff any two revisions**
- **Compare revision with local**
- **Open revision content** (read-only view of older version)
- **Create patch from revision**
- **Get (rollback) file to revision** (uncertain — verify exact label)
- **Annotate previous revision** from blame
