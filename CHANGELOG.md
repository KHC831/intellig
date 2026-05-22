# Changelog

All notable changes to IntelliG will be documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Wave-squashes between releases land here. At release time, this section
is renamed to the new version (e.g. `## [0.2.0] - YYYY-MM-DD`) and a
fresh empty `[Unreleased]` block is added on top. See
[`CONTRIBUTING.md` → "Changelog cadence"](CONTRIBUTING.md#changelog-cadence)
for the workflow.

> **1.0.0 release tracking:** the four gate conditions for 1.0.0 are
> tracked inline in
> [`CONTRIBUTING.md` → "1.0.0 gate checklist"](CONTRIBUTING.md#100-gate-checklist).
> The `npm run check:100-gate` script enforces that every checkbox is
> ticked before any 1.0.0 release packages.

### Deprecated

- `intellig.useIntelliJKeymap` — superseded by
  `intellig.keymapPreset`. All five keybindings that previously
  gated on the legacy boolean now gate on
  `intellig.keymapPreset == 'intellij'`, matching the three that
  already did. The setting remains in the schema with a
  `deprecationMessage` so existing user settings show the warning
  in VS Code's settings UI. **Existing users with
  `intellig.useIntelliJKeymap: true` are migrated automatically
  on first activation** — IntelliG sets `keymapPreset` to
  `"intellij"`, clears the legacy boolean, and shows a one-time
  info notification. Users who explicitly chose
  `keymapPreset` already (at any scope) are not touched. The
  setting will be removed in a future minor release.

## [0.1.0] - 2026-05-22

Initial Marketplace release.

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

### Architecture decisions

This release ships with seven Architecture Decision Records (ADRs)
documenting the key engineering decisions taken during the
parity effort. See [`docs/adr/README.md`](docs/adr/README.md) for
the index.
