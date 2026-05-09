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

## Requirements

- VS Code 1.85+
- Git installed and available on `PATH`

## Keyboard Shortcuts

| Action                | Default            | IntelliJ Preset    |
|-----------------------|--------------------|--------------------|
| Commit                | Ctrl/Cmd+K         | Ctrl/Cmd+K         |
| Push                  | Ctrl+Shift+K       | Ctrl+Shift+K       |
| Pull                  | Ctrl/Cmd+T         | Ctrl/Cmd+T         |
| Branch Popup          | Ctrl+Shift+`       | Alt+`              |
| Git Tool Window       | Alt/Cmd+9          | Alt/Cmd+9          |
| Refresh Status        | Ctrl+Shift+R       | Ctrl+Shift+R       |
| Stage Selected        | Ctrl+Alt+A         | Ctrl+Alt+A         |
| Show Blame            | —                  | Ctrl+Alt+Shift+A   |
| Show File History     | —                  | Ctrl+H             |
| Show Shelf            | —                  | Ctrl+Alt+Shift+H   |

Enable the IntelliJ preset in settings: `intellig.keymapPreset: "intellij"`.

## Configuration

### Opt-in feature flags

| Setting                            | Default | Description                                                |
|------------------------------------|---------|------------------------------------------------------------|
| `intellig.useCommitToolWindow`     | `false` | Show the dedicated Commit tool window in the SCM container |
| `intellig.useTabbedGitToolWindow`  | `false` | Use the tabbed Git tool window (Log/History/Incoming/…)    |
| `intellig.keymapPreset`            | `"default"` | `"default"` or `"intellij"`                            |
| `intellig.fetchTags`               | `"when-missing"` | Tag auto-fetch policy: `"always"`, `"when-missing"`, or `"never"` |

### Commit & Push behavior

| Setting                                | Default     | Description                                                   |
|----------------------------------------|-------------|---------------------------------------------------------------|
| `intellig.defaultCommitSignOff`        | `false`     | Add `Signed-off-by` line to commit messages                   |
| `intellig.commitAuthor`                | `""`        | Optional commit-author override in `Name <email>` format      |
| `intellig.commitMessageTemplate`       | `""`        | Default commit message template                               |
| `intellig.commitMessageIssueLinks`     | `[]`        | Regex rules to turn issue keys into clickable links           |
| `intellig.protectedBranches`           | `["main", "master", "develop"]` | Branches that require a confirm before destructive ops |
| `intellig.pullRebase`                  | `false`     | Use `--rebase` by default in the Pull dialog                  |
| `intellig.autoOpenResolveConflictsDialog` | `true`   | Open the Resolve Conflicts dialog automatically on conflicts  |

### Fetch & shelf

| Setting                             | Default | Description                                          |
|-------------------------------------|---------|------------------------------------------------------|
| `intellig.autoFetchEnabled`         | `true`  | Enable periodic background fetch                     |
| `intellig.autoFetchInterval`        | `180`   | Auto-fetch interval in seconds                       |
| `intellig.shelve.removeAppliedFiles`| `true`  | Remove shelved files after they are successfully applied |

### Blame annotations

| Setting                                      | Default   | Description                                         |
|----------------------------------------------|-----------|-----------------------------------------------------|
| `intellig.blameAnnotationStyle`              | `"inline"`| `"inline"`, `"gutter"`, `"both"`, or `"off"`        |
| `intellig.blame.ignoreWhitespace`            | `false`   | Pass `-w` to `git blame`                            |
| `intellig.blame.detectMovementsWithinFile`   | `false`   | Pass `-M` to `git blame`                            |
| `intellig.blame.detectMovementsAcrossFiles`  | `false`   | Pass `-C` to `git blame`                            |

### UI polish

| Setting                              | Default | Description                                      |
|--------------------------------------|---------|--------------------------------------------------|
| `intellig.showStatusBarBranch`       | `true`  | Show the current branch + incoming/outgoing badge in the status bar |
| `intellig.log.highlightCherryPicked` | `true`  | Dim commits already cherry-picked into the current branch |
| `intellig.defaultRepo`               | `""`    | Preferred repo when multiple are open            |
| `intellig.modifiedFileColor`         | `""`    | Optional color override for modified files      |
| `intellig.addedFileColor`            | `""`    | Optional color override for added files         |
| `intellig.deletedFileColor`          | `""`    | Optional color override for deleted files       |
| `intellig.ignoredFileColor`          | `""`    | Optional color override for ignored files       |
| `intellig.conflictFileColor`         | `""`    | Optional color override for conflicted files    |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build commands, and project structure.

## Feedback & Issues

Found a bug or have a question? [Open an issue](https://github.com/KHC831/intellig/issues) on GitHub.

## License

See [LICENSE](LICENSE) for details.
