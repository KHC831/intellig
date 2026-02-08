# IntelliG for VS Code

IntelliJ IDEA-style Git integration for Visual Studio Code. Brings familiar Git workflows — changelists, commit dialog, interactive rebase, shelf, blame annotations, and more — right into VS Code.

## Features

- **Commit Dialog** — structured commit workflow with sign-off support and message templates
- **Branch Management** — create, checkout, rename, delete, merge, and rebase branches from a rich context menu
- **Interactive Rebase** — reorder, squash, fixup, edit, and reword commits visually
- **Shelf & Stash** — shelve and unshelve changes, or use Git stash with a visual interface
- **Blame Annotations** — inline, gutter, or both — see who changed each line and when
- **Merge & Conflict Resolution** — three-way merge view with accept current/incoming/both actions
- **Branch Comparison** — compare any branch with your current branch or working tree
- **Git Log** — browse commit history with graph visualization and filtering
- **Explorer & Editor Integration** — stage, unstage, revert, diff, and view history from context menus
- **Auto Fetch** — configurable automatic fetching from remotes
- **IntelliJ Keymap** — optional IntelliJ IDEA-style keyboard shortcuts

## Requirements

- VS Code 1.85+
- Git installed and available on PATH

## Keyboard Shortcuts

| Action              | Default           | IntelliJ Preset   |
|---------------------|-------------------|--------------------|
| Commit              | Ctrl+K / Cmd+K    | Ctrl+K / Cmd+K     |
| Push                | Ctrl+Shift+K      | Ctrl+Shift+K       |
| Pull                | Ctrl+T / Cmd+T    | Ctrl+T / Cmd+T     |
| Branch Popup        | Ctrl+Shift+`      | Alt+`              |
| Git Tool Window     | Alt+9 / Cmd+9     | Alt+9 / Cmd+9      |
| Refresh             | Ctrl+Shift+R      | Ctrl+Shift+R       |
| Stage Selected      | Ctrl+Alt+A        | Ctrl+Alt+A         |
| Blame Annotations   | —                 | Ctrl+Alt+Shift+A   |
| Show History        | —                 | Ctrl+H             |

Enable the IntelliJ keymap preset in settings: `intellig.keymapPreset: "intellij"`

## Configuration

| Setting                          | Default     | Description                                      |
|----------------------------------|-------------|--------------------------------------------------|
| `intellig.defaultCommitSignOff`  | `false`     | Add Signed-off-by line to commit messages        |
| `intellig.commitMessageTemplate` | `""`        | Default commit message template                  |
| `intellig.pullRebase`            | `false`     | Use rebase instead of merge when pulling         |
| `intellig.autoFetchEnabled`      | `true`      | Enable automatic fetching from remotes           |
| `intellig.autoFetchInterval`     | `180`       | Auto-fetch interval in seconds                   |
| `intellig.blameAnnotationStyle`  | `"inline"`  | Style for blame annotations (inline/gutter/both) |
| `intellig.showStatusBarBranch`   | `true`      | Show current branch in status bar                |
| `intellig.keymapPreset`          | `"default"` | Keyboard shortcut preset (default/intellij)      |

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build commands, and project structure.

## Feedback & Issues

Found a bug or have a question? [Open an issue](https://github.com/KHC831/intellig/issues) on GitHub.

## License

See [LICENSE](LICENSE) for details.
