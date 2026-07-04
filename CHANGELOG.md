# Changelog

All notable changes to IntelliG will be documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Changes between releases land here. At release time, this section is
renamed to the new version (e.g. `## [0.2.0] - YYYY-MM-DD`) and a
fresh empty `[Unreleased]` block is added on top.

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
