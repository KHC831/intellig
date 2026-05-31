# Changelog

All notable changes to IntelliG will be documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Changes between releases land here. At release time, this section is
renamed to the new version (e.g. `## [0.2.0] - YYYY-MM-DD`) and a
fresh empty `[Unreleased]` block is added on top.

## [0.1.1] - 2026-05-31

### Changed

- Removed direct email contact from public-facing docs. Bug reports,
  feature requests, and security vulnerabilities now route through
  the `intellig-issues` repo (security via GitHub's private
  vulnerability reporting flow).

### Fixed

- Stray blank lines in two `CommitDialog.ts` template-literal
  expressions that triggered prettier warnings on CI.

## [0.1.0] - 2026-05-31

Initial Marketplace release. Marked as `preview` while the project
gathers real-world feedback.

### Highlights

- **IntelliJ IDEA-style Git workflows for VS Code** — changelists,
  commit dialog, branch popup, interactive rebase, shelf, custom
  three-way merge view, blame annotations, and IntelliJ-style
  context menus.
- **Multi-repo support** — workspace folders, nested-repo discovery
  (configurable depth), and mid-session `git init` auto-detection
  (no reload required).
- **Atomic file writes** for changelist and shelf state, with
  forward-compatible round-trip preservation of unknown fields so a
  newer-version state file survives a downgrade without data loss.
- **Sanitized error toasts** — credentialed URLs and home-directory
  paths are redacted before any notification surface, so secrets
  never end up in screenshots or screen recordings.
- **`Output → IntelliG` diagnostic channel** for init and watcher
  errors, plus per-file diagnostics from operations like
  `Import Patches`.
- **Coexistence with VS Code's built-in Git** — IntelliG runs `git`
  directly (works even with `git.enabled: false`) and does not
  register a Source Control panel of its own.
- **Strict CI** — zero lint warnings, structural guards for the
  canonical-channel and sanitized-toast invariants, and round-trip
  property tests for storage forward-compat.

### Known limitations

See the README "Known limitations" section for the full list. The
shortlist for v0:

- `.git` as a *file* (linked worktrees, submodules with detached
  gitdir) is not yet supported.
- Mid-session repo deletion (`rm -rf .git`) may leave orphan
  watchers until the session is reloaded.
- One stress-only graph tie-break flake is pinned but not yet
  root-caused (tracked internally).

### Deprecated

- `intellig.useIntelliJKeymap` — superseded by
  `intellig.keymapPreset`. All five keybindings that previously
  gated on the legacy boolean now gate on
  `intellig.keymapPreset == 'intellij'`. The setting remains in
  the schema with a `deprecationMessage` so existing user settings
  show the warning in VS Code's settings UI. **Existing users with
  `intellig.useIntelliJKeymap: true` are migrated automatically
  on first activation** — IntelliG sets `keymapPreset` to
  `"intellij"`, clears the legacy boolean, and shows a one-time
  info notification. Users who explicitly chose `keymapPreset`
  already (at any scope) are not touched. The setting will be
  removed in a future minor release.

### Architecture decisions

This release ships with seven Architecture Decision Records (ADRs)
in the bundled `docs/adr/` directory documenting the key engineering
decisions taken during the parity effort.
