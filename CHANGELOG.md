# Changelog

All notable changes to IntelliG will be documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Changes between releases land here. At release time, this section is
renamed to the new version (e.g. `## [0.2.0] - YYYY-MM-DD`) and a
fresh empty `[Unreleased]` block is added on top.

### Added

- Right-clicking a changed file in the log's details panel now offers Show Diff, Open Repository Version, and Show History for Revision.
- Right-clicking a revision in the file-history tab now offers Compare with HEAD and Compare With.

### Changed

- IntelliG no longer binds keyboard shortcuts out of the box: set `intellig.keymapPreset` to `intellij` for the IntelliJ-style chords. The old always-on bindings shadowed VS Code defaults like Delete Line, Go to Symbol, New Terminal, and the Ctrl+K chord leader.
- Under the `intellij` preset: Move to Another Changelist is Alt+Shift+M (IntelliJ's current gesture, was F6), the VCS popup is Ctrl+V on mac, and the Commit tool window gains Cmd+0 on mac.
- Blame now ignores whitespace-only changes by default, matching IntelliJ; turn `intellig.blame.ignoreWhitespace` off to get the old attribution.
- The two moved-line detection settings merged into one: `intellig.blame.detectMovements` (`none`/`within`/`across`). Across-files detection now passes a single `-C` like IntelliJ, and turning it off falls back to within-file detection.

### Fixed

- The IntelliG sidebar keeps its views in a stable order at startup: Branches, Git, Commit. The Commit view's late appearance no longer shuffles the panel.
- Ctrl+D under the `intellij` preset opens the active file's diff; it previously targeted a branch-compare action that can never run from the keyboard.
- F4 opens the file last selected in the Commit tool window instead of always asking you to select one.
- Branch favorites are now per-workspace, like IntelliJ's per-project favorites; existing stars carry over once per workspace.
- Picking a revision in Show Line History opens that revision's diff instead of an info toast.
- Selecting text in the merge window shows the selection highlight again, including over conflict-colored lines.
- "Push All up to Here" now opens the push dialog to preview the push instead of pushing immediately, shows the commit it will push, and can push a commit no local branch contains.

## [0.4.2] - 2026-07-15

### Fixed

- The commit tool window now populates on first open and refreshes after you commit or roll back changes.
- Ctrl/Cmd+C on a selected commit copies its hash again.
- Panel dividers and column widths in the git log now stick across reloads instead of resetting on every drag.
- The commit tool window's Stashes tab actions (apply, pop, drop, and the rest) work again instead of failing "Stash not found".

### Removed

- Dropped eight settings that no longer did anything, and the non-working recent-messages button in the commit tool window.

## [0.4.1] - 2026-07-13

### Fixed

- Background refreshes no longer rebuild the git log: scroll position, the commit details panel, and open right-click menus survive file changes in the workspace.
- Editing or saving files no longer re-runs the full log/branches/tags pipeline; working-tree changes only refresh the views that show them.
- The New Branch dialog no longer offers tracking when starting from a commit hash, and a branch created from the dialog appears in the graph immediately.

## [0.4.0] - 2026-07-12

### Added

- The git log can open as an editor tab and float into its own window; close the tab to dock it back.
- The merge window has an Apply Non-Conflicting button, plus a setting to apply non-conflicting changes automatically on open.
- The merge window counts conflicts ("Conflict 1 / 3") and its Prev/Next buttons jump between them.

### Changed

- Merge window colors follow your VS Code theme, including light themes.
- Merge window changes show only on the side that made them, matching IntelliJ.
- The three merge panes scroll together horizontally.
- Change highlights in the merge window cover the line numbers and flow unbroken into the center connectors.

## [0.3.5] - 2026-07-10

### Fixed

- Repositories no longer vanish from the repository selector after git operations.
- Repositories behind symlinked folders are now found.
- Files added or deleted on both sides of a merge now show as conflicts.
- Aborting conflicts no longer fails on files that are new on both branches.
- Reset's Smart option always restores the stash it created.
- The graph search box accepts SHA-256 commit ids.
- A bad date in a saved log filter no longer blanks the graph.
- Text diffs mentioning "Binary files ... differ" no longer display as binary.
- New Branch and New Tag are disabled when multiple commits are selected.
- File names with backslashes no longer break the Commit tool window.

## [0.3.4] - 2026-07-09

### Added

- `intellig.autorefresh` (on by default) controls whether the Git views refresh live as the working tree changes.

### Changed

- The push dialog's "Push tags" option is now a dropdown (All tags / Follow tags) with a short explanation of what each choice pushes.

### Fixed

- The Commit tool window now tracks each file's real staged state, so committing a partial selection no longer sweeps in files you left unchecked, and the view refreshes when you stage or unstage from outside the extension.
- Branch favorites stay in sync between the branches tree and the branch popup. Star a branch in one and it shows in the other.
- "Push tags" in the push dialog now sends every tag by default. It previously used `--follow-tags`, which silently skipped lightweight tags and tags not reachable from the pushed branch.
- The Local Changes view now refreshes as soon as you save a file in the working tree, instead of only after a Git operation or switching tabs.
- Deleting a tag now offers to delete it on the remote too, so a deleted tag no longer reappears after the next fetch.

## [0.3.3] - 2026-07-08

### Changed

- The commit graph colors your repository's default branch as the blue mainline — whatever it's named (main, master, mainline, or a custom default it follows), and it stays the same color as its remote-tracking copy.

### Fixed

- Adding or removing a folder in a multi-root workspace no longer drops the other repositories from the selector or collapses the view to a single repo.

## [0.3.2] - 2026-07-06

### Changed

- The commit graph stays narrow on a deep merge history — long branch lines collapse to small arrows near their ends and the freed lanes are reused. Turn on `intellig.log.showLongEdges` for full-length lines.
- "Interactively Rebase from Here" now warns when the range replays many commits and flattens merges, and hints to pick a mainline commit when you clicked one off the mainline.

### Fixed

- Blame's previous-revision annotation and multi-commit diffs no longer resolve the wrong revision on Git 2.50 and newer.
- Interactive rebase and squash now work from a linked git worktree.
- Creating a patch or shelving changes now fails safely instead of acting on truncated Git output.
- Acting on a multi-repository selection groups the changes by repository instead of failing the whole batch.

## [0.3.1] - 2026-07-05

### Changed

- The interactive rebase editor keeps its scroll position when you change a commit's action, and now spells out that commits run oldest-to-newest (top to bottom) and that squash and fixup meld into the commit above.
- The commit details panel gives the changed-files list and message a bit more room, and the changed-files heading now shows the project name, file count, and path.

### Fixed

- Squashing commits no longer flashes a "rebase is paused" warning while it runs.

## [0.3.0] - 2026-07-04

### Added

- Search box in the branches tree to filter branches and tags by name.
- Multi-select in the branches tree — delete several branches or tags at once, with a single confirm for the batch.

### Fixed

- Log filters now persist across window reloads, and a background refresh no longer quietly drops the filter you had applied.
- Squash, Drop, Edit Message, and Interactive Rebase on a commit from another branch no longer silently move your current branch — they are disabled for commits that aren't on the checked-out branch.

## [0.2.12] - 2026-07-03

### Fixed

- Clicking a tag in the branches tree now jumps the graph to the tagged commit, just like clicking a branch.
- Background refreshes no longer fight your git commands over the index lock, which could make a checkout or rebase fail with "index.lock: File exists".
- A repository removed from the workspace no longer comes back as a ghost in repository pickers.
- Continue/Abort/Skip on a paused rebase could be refused right after resolving a conflict; they now read fresh repository state.

### Changed

- The extension is now shipped as a single bundled file — a smaller download that loads faster.

## [0.2.11] - 2026-07-03

### Added

- Configure Remotes — add, rename, change the URL of, or remove a remote from the command palette.
- Remove Worktree — delete a linked worktree (with a force option for dirty ones) and prune stale worktree records.
- Un-Resolve File — send a mis-resolved conflict back to its conflicted state so you can redo the resolution.
- A rejected push now offers Merge or Rebase and retries automatically instead of leaving you to pull by hand.
- Before-commit warnings for CRLF line endings, files over 50 MB, and file names that break on Windows.
- A three-pane merge window ported from IntelliJ's merge engine is now the default way to resolve conflicts; turn off `intellig.mergeWindow.enabled` to keep using VS Code's built-in merge editor.

### Fixed

- The packaged extension no longer includes 35 MB of internal test-coverage data that shipped in 0.2.10.
- Right-clicking a branch just as the tree refreshed could crash the command instead of running it.
- Many command-surface fixes from a full user's-point-of-view review: multi-file selections are respected everywhere, palette commands no longer fail silently, and error messages are honest about what happened.

## [0.2.10] - 2026-06-29

### Added

- Shelve Changes — pick which files to shelve in a dedicated dialog, from a file's right-click or the command palette.

### Changed

- File history now follows renames automatically, so you see a file's whole past even after it was moved or renamed.

### Fixed

- File history now works correctly in multi-root workspaces.
- The Incoming tab now refreshes when you open it and after a fetch.

## [0.2.9] - 2026-06-27

### Added

- Filter the log by multiple branches or repositories at once — both are checkbox menus now.
- The filter row stays put when you scroll.

### Changed

- Easier to tell apart blue and cyan branches in the graph.

### Fixed

- Blame stays aligned with your edits in an unsaved file, and the gutter no longer flickers as you type.
- Filtering by branches that aren't in every repo no longer hides a repo's history.
- Rewording a commit keeps the message body instead of dropping it.

## [0.2.8] - 2026-06-26

### Changed

- Colorblind-safe graph branch coloring — one stable color per branch across lines, nodes, and chips.
- Branch & tag labels are now neutral chips with a colored icon and foreground text (transparent tag chip), readable on any theme.
- Commit message text and branch/tag chips scale with the editor font size.
- Commit details: the subject is shown in bold and the redundant "Message:" label was removed.

### Fixed

- The current-branch ring is no longer clipped at the chip edges.

## [0.2.7] - 2026-06-25

### Fixed

- Multi-repo: double-clicking a changed file opens the correct diff (no repo prompt, correct base).
- Graph: the `main`/`master` line stays one color across merges; branch colors begin at each divergence point.

## [0.2.6] - 2026-06-24

### Added

- Branch-colored graph (one stable color per branch) and per-file `+N | -N` diff stats in the changed-files list.

### Changed

- IntelliJ-parity log filter row (text/branch/user/date/path in one row) and branch context-menu labels.

### Fixed

- Graph through-lane gap; commit menu now closes on click-away; "All Repositories" stays default during multi-repo discovery; repositories no longer vanish on transient `.git/HEAD` changes.

### Removed

- "Highlight commits common to a selected branch" (misleading — shaded off-window shared history).

## [0.2.5] - 2026-06-24

### Fixed

- Packaged extension failed to activate ("no data provider") — the `neverthrow` runtime dependency was missing from the VSIX.

## [0.2.4] - 2026-06-24

### Fixed

- Corrected release package (0.2.3 was packaged incorrectly).

## [0.2.3] - 2026-06-24

### Added

- Containing branches in commit details, a log branch filter, and highlighting of commits common to a selected branch.

### Fixed

- Squash keeps your combined message; graph edge gaps, stray `HEAD` branch entries, the filter bar auto-opening, and Git Console command spam.

### Changed

- Git operations now run through a typed error-handling boundary.

## [0.2.2] - 2026-06-22

### Added

- Blame annotation gutter: per-line author, date, and revision with per-commit colors and hover actions.

### Fixed

- Blame line attribution, commit-graph rendering, commit selection, and multi-repo diff resolution.

### Changed

- Faster graph load and repository switching.

## [0.2.1] - 2026-06-21

### Fixed

- Commit graph: removed a stray line above just-merged branches; lanes with unloaded parents now end in a "more history below" chevron.
- Commit graph: selecting an already-visible commit no longer jerks the view.
- Console tab: rows are compact again.

### Changed

- Webviews now build their UI via DOM APIs instead of HTML strings (injection-hardening + cleanup).

## [0.2.0] - 2026-06-19

A broad release across the log, branches, shelf, rebase, merge, and blame surfaces.

### Added

- Multi-repo scope selector that drives the log and Branches views, with a filter bar for branch, author, range, and merge filters.
- Richer commit log: GPG column, parent/child navigation, `fixup!`/`squash!` links, scroll-to-load-more, and a tabbed tool window by default.
- File history with line-scoped history, affected paths, and per-revision file access.
- Expanded shelf: partial and binary unshelve, a recycle bin, working-tree diff, and per-file patch import.
- Fuller rebase and merge dialogs, including --onto/--root, autosquash, inline reword/squash, and a native three-way merge editor.
- More branch, tag, push, pull, and cherry-pick/revert options, plus Set Upstream, worktrees, and Smart Reset.
- Native VS Code Source Control provider, a changed-line gutter tracker with revert, a rollback dialog, and a Git command Console.

### Fixed

- Commit graph rendering around merges and off-window history, and scroll position is kept when more history loads.
- Multi-repo and explorer actions now target the repository you clicked.
- Blame and line-status caches refresh on repository state changes.
- Hardened credential scrubbing and git argument handling.

### Changed

- Command palette titles, toolbar, and explorer menu order now follow IntelliJ's layout.

## [0.1.6] - 2026-06-13

### Added

- Drag-to-resize the author and date columns in the commit log; widths persist across reloads.
- Annotated tags now appear on the commit graph.

### Fixed

- Right-click → Push now pushes the branch you clicked, not the branch HEAD is on.
- A rebase started from the extension no longer leaves a phantom session that blocked later branch operations.
- Checking out a branch in use by another worktree now names that worktree instead of surfacing a raw git error.
- Branch labels match IntelliJ: current branch highlighted, a lone branch is never hidden behind "+1", and collapsed refs are clickable.
- Local branch labels render green, remote violet, current yellow.
- The Changed Files tree is now collapsible.
- Far-parent graph edges no longer cut through unrelated rows.

### Changed

- Commit timestamps now show an absolute date and time instead of a stale relative label.

## [0.1.5] - 2026-06-11

### Fixed

- The commit graph no longer splits the mainline across multiple lanes when branches share an ancestor.
- HEAD stays on lane 0 even when newer commits sit above it.
- First-parent lines now match their commit's node colour.
- Removed phantom strokes through unrelated mainline rows.
- Closed the gap under merge commits whose mainline continues below.
- Outer branches are no longer clipped when many lanes are present.
- Lanes are reused when branches end, keeping the graph compact.

### Changed

- Slightly smaller commit nodes for a tighter look.

## [0.1.4] - 2026-06-09

### Added

- Paused rebases are surfaced on activation, with continue/abort commands in the palette.
- Graph edges to history below the loaded window now render dashed.

### Fixed

- "Checkout & Rebase" onto a remote branch no longer detaches HEAD.
- The repository selector now updates both the graph and the Branches view.
- The commit graph no longer collapses into a linear tree after a squash, rebase, or cherry-pick.
- Branch lanes stay on stable columns across refreshes and reloads.
- A local branch and its remote-tracking ref on the same commit no longer split into separate lanes.

## [0.1.3] - 2026-06-03

### Added

- The Changed Files panel now renders as a collapsible tree.
- The Git tool window shows a clear "no repository" message when no Git repo is open.

### Fixed

- Merge commits now show their changed files in the details panel instead of "No changed files".
- Removed a phantom lane stub that drew above the topmost commit row in the graph.
- Tightened the column spacing in the commit history pane.
- Bug fixes for failed merge / rebase / cherry-pick / revert operations.

### Changed

- Every IntelliG command invocation and handler outcome is now logged to `Output → IntelliG` for easier troubleshooting.

## [0.1.2] - 2026-05-31

### Fixed

- Deleting an unmerged branch now prompts for force-delete instead of surfacing git's raw CLI hint.

## [0.1.1] - 2026-05-31

### Changed

- Bug reports and security disclosures now route through the public `intellig-issues` repo instead of a direct email address.

## [0.1.0] - 2026-05-31

Initial Marketplace release as a preview.

### Added

- IntelliJ IDEA-style Git workflows for VS Code: changelists, commit dialog, branch popup, interactive rebase, shelf, three-way merge view, blame annotations, and IntelliJ-style context menus.
- Multi-repo support including nested-repo discovery and mid-session `git init` auto-detection.
- `Output → IntelliG` diagnostic channel for init, watcher, and per-file operation errors.
- Coexistence with VS Code's built-in Git extension.

### Deprecated

- `intellig.useIntelliJKeymap` is superseded by `intellig.keymapPreset` and migrates automatically on first activation.
