# IntelliG for VS Code

IntelliJ IDEA-style Git integration for Visual Studio Code. Brings familiar Git workflows — changelists, commit dialog, branch popup, interactive rebase, shelf, blame annotations, merge resolution, and more — right into VS Code.

## Features

### Commits & Changelists
- **Commit Dialog** — structured commit workflow with sign-off, custom author, recent-message history, and issue-link shortcuts
- **Commit Tool Window** *(opt-in)* — dedicated SCM view with Local Changes + combined Shelf/Stash tab
- **Changelists** — organize pending changes into named lists with descriptions and an active-list indicator
- **Revert & Drop Selected Changes** — deselect individual files before reverting or dropping

### Branches, Tags & Log
- **Branch Popup** — sectioned, searchable popup with Recent, Favorites, and contextual action menus
- **Branch Tree Provider** — local, remote, and tag groups with right-click context menus
- **Favorites** — star branches for quick access
- **New Branch / New Tag dialogs** — with validation and remote-start-point detection
- **Log with Graph** — commit-history viewer with graph visualization, filtering, jump-to-hash, and cherry-pick highlighting
- **File History** — `--follow` file history with branch filter, diff-any-two, and compare-with-local
- **Branch Comparison** — compare any branch with the current branch or the working tree

### Push, Pull & Fetch
- **Push Dialog** — force-with-lease as the default safe force, protected-branch guard, multi-repo
- **Pull Dialog** — `--rebase` / `--ff-only` / `--autostash` flags with automatic conflict handoff
- **Push All Tags**
- **Auto Fetch** — configurable scheduler with `fetch.tags` auto-sync and an incoming-commits status-bar badge

### Merge, Rebase & Cherry-pick
- **Interactive Rebase** — reorder, squash, fixup, edit, reword, and skip commits visually
- **Merge Dialog** — strategy flags (`--ff-only`, `--no-ff`, `--squash`) with conflict handoff
- **Three-way Merge View** — accept current / incoming / both, plus apply-all-non-conflicting left/right
- **Cherry-pick Variants** — standard, without-commit, apply-selected-changes, and apply-files-to-branch

### Shelf, Stash & Patches
- **Shelf** — shelve and unshelve changes, with silent variants, rename, and import-patches
- **Stash Context Menu** — branch-from-stash, rename, drop
- **Apply Patch** — create a patch from local changes or apply any `.patch` / `.diff`

### Blame & Annotations
- **Inline + Gutter Blame** — configurable annotation style (inline / gutter / both / off)
- **Blame Options** — Ignore Whitespace, Detect Movements Within File / Across Files, Annotate Previous Revision

### Integrations
- **Git Tool Window (tabbed)** *(opt-in)* — Log, History, Update Info, Incoming, Console tabs
- **Explorer & Editor Context Menus** — stage, unstage, revert, diff, show history, open on remote
- **External Hosting Links** — open commit / compare / branch pages on GitHub, GitLab, or Bitbucket
- **Status Bar** — current branch + incoming/outgoing commit badge
- **IntelliJ Keymap Preset** — optional set of IntelliJ IDEA-style keyboard shortcuts

## Multi-repo support

IntelliG discovers Git repositories in three layered ways and surfaces
them all together — single-repo workspaces, multi-root workspaces, and
folders that *contain* nested repos all "just work."

- **One workspace folder, one repo.** The most common case. The folder
  itself is treated as a repository if it contains a `.git` directory.
- **Multi-root workspace.** Each top-level workspace folder is scanned
  for a repo. All discovered repos appear together in the branch popup,
  status bar, and tool windows.
- **Nested-repo discovery.** If a workspace folder contains nested
  repos (for example, a `~/work/` folder that holds
  `~/work/projectA/.git` and `~/work/projectB/.git`), both are
  discovered up to the configured scan depth.
- **Mid-session new-repo detection.** Running `git init newproject/`
  inside a workspace folder is auto-detected — the new repository is
  picked up without a reload.

### Scan-depth and ignore configuration

Two settings control how deep IntelliG looks for nested repos.
Defaults and full descriptions live in the [Configuration
reference → Multi-repo discovery](#multi-repo-discovery) table below;
the short version:

- **`intellig.repositoryScanMaxDepth`** — how many directory levels
  below each workspace folder are scanned for `.git` directories.
  Default `1` (workspace folder itself + immediate children); `-1`
  for unlimited depth (uses a `realpath` cycle guard so symlink
  loops are safe). Mirrors VS Code's `git.repositoryScanMaxDepth`.
- **`intellig.repositoryScanIgnoredFolders`** — extra folder
  basenames you want to skip during the scan. User-extensible.

The following folder basenames are **always excluded** from the nested-repo
scan and **cannot be overridden**: `.git`, `node_modules`, `.vscode`,
`out`, `dist`, `.next`, `target`, `build`, `vendor`. These are
hard-coded to keep the scan fast on real-world projects.

Submodule init mid-session is loaded as a separate top-level repo
(intentional — matches VS Code's built-in git extension behaviour).

## Diagnostics: `Output → IntelliG`

IntelliG writes init failures, watcher errors, and per-file operation
diagnostics to a dedicated `Output` channel called **IntelliG**.

- Open via VS Code's **Output** panel (`View → Output`), then pick
  `IntelliG` from the channel dropdown.
- Init / watcher errors are surfaced here without flooding the
  notification toast area.
- Operations that batch over many files — for example **Import
  Patches into Shelf** — write a sanitized line per failed file so
  you can spot the bad one without re-running.
- All output is sanitized: credentialed URLs and home-directory
  paths are redacted before being written.

If the IntelliG output channel is missing, the extension didn't
finish activating. Reload the window and check the channel again.

## Coexistence with VS Code's built-in Git

IntelliG runs `git` directly via `child_process` rather than going
through VS Code's git extension API. The practical implications:

- IntelliG works even when `git.enabled` is set to `false`.
- IntelliG does **not** register a Source Control panel — VS Code's
  built-in SCM view continues to work alongside IntelliG's
  IntelliJ-style panels (Branch popup, Git tool window, etc.).
- File-tree decorations (M / U / A glyphs in the Explorer) come from
  VS Code's built-in git extension. IntelliG does not double-paint
  decorations.
- You can disable VS Code's built-in git decorations and still have
  IntelliG's tool windows fully functional.
- Both extensions write to the same `.git/index` file. Git serializes
  concurrent writes via `.git/index.lock`; if you trigger
  stage / commit / amend operations in both extensions in the same
  instant, you may briefly see an "index locked" toast. This is
  harmless — retry the operation and it will succeed.

## Known limitations

- **Submodule init mid-session** — auto-loaded as a separate top-level
  repo (intentional, matches VS Code's git extension).
- **One-shot `rm -rf .git/` may not auto-detect** — when the entire
  `.git/` directory is removed in a single syscall (`rm -rf .git`),
  VS Code's `FileSystemWatcher` does not always deliver a child-path
  delete event, so the repo may stay in IntelliG's view until you
  reload the window. As a workaround, deleting `.git/HEAD` first
  (`rm .git/HEAD`) reliably triggers the removal event. The repo is
  fully removed if you drag its workspace folder out of VS Code, or
  on the next window reload.

## Requirements

- VS Code 1.85+
- Git installed and available on `PATH`

## Keyboard Shortcuts

| Action                | Default            | IntelliJ Preset       |
|-----------------------|--------------------|-----------------------|
| Commit                | Ctrl/Cmd+K         | Ctrl/Cmd+K            |
| Push                  | Ctrl+Shift+K       | Ctrl+Shift+K          |
| Pull                  | Ctrl/Cmd+T         | Ctrl/Cmd+T            |
| Branch Popup          | Ctrl+Shift+`       | Alt+`                 |
| Git Tool Window       | Alt+9 / Cmd+9      | Alt+9 / Cmd+9         |
| Commit Tool Window    | Alt+0              | Alt+0                 |
| Refresh Status        | Ctrl+Shift+R       | Ctrl+Shift+R          |
| Stage Selected        | Ctrl/Cmd+Alt+A     | Ctrl/Cmd+Alt+A        |
| Unstage Selected      | Ctrl/Cmd+Alt+Z     | — (chord taken by Revert File; see note below) |
| Revert File           | —                  | Ctrl/Cmd+Alt+Z        |
| Shelve Silently       | Ctrl+Shift+H / Cmd+Shift+H | Ctrl+Shift+H / Cmd+Shift+H |
| Unshelve Silently     | Ctrl/Cmd+Alt+U     | Ctrl/Cmd+Alt+U        |
| Jump to Commit (Log)  | Ctrl/Cmd+F         | Ctrl/Cmd+F            |
| Show Blame            | —                  | Ctrl/Cmd+Alt+Shift+A  |
| Show File History     | —                  | Ctrl/Cmd+H            |
| Show Shelf List       | —                  | Ctrl/Cmd+Shift+U      |
| Compare with Current  | —                  | Ctrl/Cmd+D            |
| Move Files To Changelist | —               | F6                    |
| Open File from Local Changes | —            | F4                    |

> **Heads up — `Ctrl/Cmd+Alt+Z` collision under IntelliJ preset.**
> Both `intellig.unstageSelected` (default keymap) and
> `intellig.revertFile` (IntelliJ preset) bind to `Ctrl/Cmd+Alt+Z`,
> and the IntelliJ-preset binding is more specific so it wins. If
> the IntelliJ preset is enabled, this chord performs a **revert
> on disk** (a destructive operation) — not unstage. To unstage
> while the preset is on, right-click the file in Local Changes →
> "Unstage" or run `IntelliG: Unstage Selected Files` from the
> command palette.

### Merge view (active when the IntelliG merge tab is focused)

These bindings are scoped to `activeWebviewPanelId == 'intellig.mergeView'`,
so they don't collide with anything outside the merge view.

| Action                | Binding |
|-----------------------|---------|
| Next Conflict         | Alt+Down |
| Previous Conflict     | Alt+Up |
| Accept Current        | Alt+1 |
| Accept Both           | Alt+2 |
| Accept Incoming       | Alt+3 |

### How to read this table

The **Default** column lists the binding active out of the box (no
preset). The **IntelliJ Preset** column lists the binding active
when the preset is on. When the same chord appears in both columns,
it's the same command under either mode. An em-dash (—) means the
action has no chord under that mode; use the command palette
(`Ctrl/Cmd+Shift+P` → `IntelliG: <action>`) to invoke it.

Enable the IntelliJ preset in settings:

```jsonc
"intellig.keymapPreset": "intellij"
```

## Configuration reference

### Opt-in feature flags

| Setting                            | Default     | Description                                                |
|------------------------------------|-------------|------------------------------------------------------------|
| `intellig.useCommitToolWindow`     | `false`     | Show the dedicated Commit tool window in the SCM container |
| `intellig.useTabbedGitToolWindow`  | `false`     | Use the tabbed Git tool window (Log/History/Incoming/…)    |
| `intellig.keymapPreset`            | `"default"` | `"default"` or `"intellij"`                                |
| `intellig.useIntelliJKeymap`       | `false`     | **Deprecated** — superseded by `intellig.keymapPreset`. No longer read by any keybinding's `when` clause; will be removed in a future minor release. |

### Multi-repo discovery

| Setting                                 | Default | Description |
|-----------------------------------------|---------|-------------|
| `intellig.repositoryScanMaxDepth`       | `1`     | Max depth for nested-repo discovery; `-1` for unlimited |
| `intellig.repositoryScanIgnoredFolders` | `[]`    | Extra folder basenames to skip during the scan          |
| `intellig.defaultRepo`                  | `""`    | Preferred repo basename or absolute path when multiple are open |

### Commit & Push behavior

| Setting                                   | Default                         | Description |
|-------------------------------------------|---------------------------------|-------------|
| `intellig.defaultCommitSignOff`           | `false`                         | Add `Signed-off-by` line to commit messages |
| `intellig.commitAuthor`                   | `""`                            | Optional commit-author override in `Name <email>` format |
| `intellig.commitMessageTemplate`          | `""`                            | Default commit message template |
| `intellig.commitMessageIssueLinks`        | `true`                          | Detect issue/PR references and render as clickable links |
| `intellig.protectedBranches`              | `["main", "master"]`            | Branches that require a confirm before destructive ops |
| `intellig.pullRebase`                     | `false`                         | Use `--rebase` by default in the Pull dialog |
| `intellig.autoOpenResolveConflictsDialog` | `true`                          | Open the Resolve Conflicts dialog automatically on conflicts |

### Fetch & shelf

| Setting                                | Default  | Description                                              |
|----------------------------------------|----------|----------------------------------------------------------|
| `intellig.autoFetchEnabled`            | `true`   | Enable periodic background fetch                         |
| `intellig.autoFetchInterval`           | `180`    | Auto-fetch interval in seconds                           |
| `intellig.fetchTags`                   | `"auto"` | Tag-fetch policy: `"auto"`, `"all"`, or `"never"`        |
| `intellig.shelve.removeAppliedFiles`   | `false`  | Remove successfully-applied files from a shelf entry     |

### Blame annotations

| Setting                                      | Default    | Description                                  |
|----------------------------------------------|------------|----------------------------------------------|
| `intellig.blameAnnotationStyle`              | `"inline"` | `"inline"`, `"gutter"`, or `"both"`          |
| `intellig.blame.ignoreWhitespace`            | `false`    | Pass `-w` to `git blame`                     |
| `intellig.blame.detectMovementsWithinFile`   | `false`    | Pass `-M` to `git blame`                     |
| `intellig.blame.detectMovementsAcrossFiles`  | `false`    | Pass `-C -C` to `git blame`                  |

### UI polish

| Setting                              | Default    | Description                                              |
|--------------------------------------|------------|----------------------------------------------------------|
| `intellig.showStatusBarBranch`       | `true`     | Show current branch + incoming/outgoing badge in the status bar |
| `intellig.log.highlightCherryPicked` | `true`     | Dim commits already cherry-picked into the current branch |
| `intellig.modifiedFileColor`         | `"#6897BB"`| Color for modified files (IntelliJ blue)                 |
| `intellig.addedFileColor`            | `"#629755"`| Color for added files (IntelliJ green)                   |
| `intellig.deletedFileColor`          | `"#6C6C6C"`| Color for deleted files (IntelliJ gray)                  |
| `intellig.ignoredFileColor`          | `"#848504"`| Color for ignored files                                  |
| `intellig.conflictFileColor`         | `"#FF0000"`| Color for conflicted files (red)                         |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build commands, and project structure.

## Feedback & Issues

Found a bug or have a question? [Open an issue](https://github.com/KHC831/intellig/issues) on GitHub.

## License

See [LICENSE](LICENSE) for details. **Note (v0.1.0):** licensing terms
are placeholder pending finalization. The current `LICENSE` file
states evaluation-only use; final terms will be set before a public
GA release.
