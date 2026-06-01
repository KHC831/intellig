# Changelog

All notable changes to IntelliG will be documented in this file. Format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Changes between releases land here. At release time, this section is
renamed to the new version (e.g. `## [0.2.0] - YYYY-MM-DD`) and a
fresh empty `[Unreleased]` block is added on top.

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
