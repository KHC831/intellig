# Changelog

All notable changes to IntelliG will be documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Changes between releases land here. At release time, this section is
renamed to the new version (e.g. `## [0.2.0] - YYYY-MM-DD`) and a
fresh empty `[Unreleased]` block is added on top.

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
