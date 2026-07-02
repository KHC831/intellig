# IntelliG for VS Code

The native-feeling Git UI for VS Code users who miss IntelliJ's. It borrows the ideas that made Git pleasant in IntelliJ IDEA — changelists, the branch popup, the shelf, the interactive-rebase planner, the commit-graph log — and rebuilds them as first-class VS Code, so you feel at home instead of like you're running a transplanted IDE.

![The IntelliG log with graph visualization](https://raw.githubusercontent.com/KHC831/intellig-issues/main/images/screenshots/graph.png)

**The idea:** IntelliJ's `git4idea` is the inspiration, not a spec to clone. IntelliG keeps its best daily workflows, embraces native VS Code idioms (the built-in 3-way merge editor, the native SCM commit surface) rather than transplanting Swing, and puts trusting-it-with-your-repo ahead of matching every menu item.

## Marketplace

Install IntelliG from either marketplace:

- **Visual Studio Marketplace** — <https://marketplace.visualstudio.com/items?itemName=KaHoChan.intellig>
- **Open VSX** (VSCodium, Cursor, Gitpod, and other non-Microsoft builds) — <https://open-vsx.org/extension/KaHoChan/intellig>

Or from the Extensions view (`Ctrl/Cmd+Shift+X`), search **IntelliG** and click Install.

## Features

### Commits & Changelists

- **Commit Dialog** — structured commit workflow with sign-off, custom author, recent-message history, and issue-link shortcuts
- **Commit Tool Window** _(opt-in)_ — dedicated SCM view with Local Changes + combined Shelf/Stash tab
- **Changelists** — organize pending changes into named lists with descriptions and an active-list indicator
- **Revert & Drop Selected Changes** — deselect individual files before reverting or dropping
- **Commit File** — commit a single file straight from its Explorer right-click menu (top of the IntelliG submenu)

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

- **Git Tool Window (tabbed)** _(opt-in)_ — Log, History, Update Info, Incoming, Console tabs
- **Explorer & Editor Context Menus** — stage, unstage, revert, diff, show history, open on remote
- **External Hosting Links** — open commit / compare / branch pages on GitHub, GitLab, or Bitbucket
- **Status Bar** — current branch + incoming/outgoing commit badge
- **IntelliJ Keymap Preset** — optional set of IntelliJ IDEA-style keyboard shortcuts

## Screenshots

**Commit tool window** — Local Changes with staged, unstaged, and untracked files.

![Commit tool window](https://raw.githubusercontent.com/KHC831/intellig-issues/main/images/screenshots/commit.png)

**Branch popup** — local, remote, and tag groups with contextual actions.

![Branch popup](https://raw.githubusercontent.com/KHC831/intellig-issues/main/images/screenshots/branch.png)

**Incoming tab** — commits waiting upstream before you pull.

![Incoming commits tab](https://raw.githubusercontent.com/KHC831/intellig-issues/main/images/screenshots/incoming.png)

**File history** — follows renames across the file's whole history.

![File history following a rename](https://raw.githubusercontent.com/KHC831/intellig-issues/main/images/screenshots/history.png)

**Blame annotations** — per-line author and commit, color-coded by commit.

![Inline blame annotations](https://raw.githubusercontent.com/KHC831/intellig-issues/main/images/screenshots/blame.png)

**Shelve Changes** — pick which files to shelve in a dedicated dialog.

![Shelve Changes dialog](https://raw.githubusercontent.com/KHC831/intellig-issues/main/images/screenshots/shelf.png)

## Multi-repo support

IntelliG discovers Git repositories in three layered ways and surfaces
them all together — single-repo workspaces, multi-root workspaces, and
folders that _contain_ nested repos all "just work."

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

### Repository scope

When more than one repository is open, the Git Tool Window toolbar shows
a repository selector. It controls which repo the **Log** and the
**Branches** view show:

- **Pick a single repository** to scope both views to that repo — the
  branch tree lists only that repo's local/remote/tag refs, and the log
  graph shows only its commits.
- **All Repositories** (the default) shows a merged view: the branch tree
  groups every repo's refs, and the log interleaves commits from all
  roots into one graph.

Right-click actions resolve against the repository the clicked branch,
tag, or commit actually belongs to — so in the merged view an action on a
ref from one repo never operates on another.

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

### Structured-record format

Each diagnostic is written as a structured record — one block per
event — so you can scan, grep, and copy entries reliably. The first
line always follows this shape:

```
[<timestamp>] <LEVEL> <component>: <message>
```

- `<timestamp>` is an ISO-8601 instant (e.g. `2026-05-12T14:03:11.482Z`).
- `<LEVEL>` is the record's severity, uppercased and padded to five
  characters (`TRACE`, `DEBUG`, `INFO `, `WARN `, `ERROR`).
- `<component>` names the subsystem that emitted the record.
- `<message>` is the sanitized message; embedded newlines are escaped
  to a literal `\n` so each record stays on one parseable line.

When present, the following detail lines follow the header, each
indented two spaces:

- `ctx=<json>` — structured context for the event, as a single-line
  JSON object.
- `cid=<correlationId>` — correlates every record emitted while
  handling the same command invocation.
- `err=<message>` — the error message, followed by its stack trace
  with each frame on its own indented line.

### Controlling log output

Two settings tune what reaches the channel:

- **`intellig.log.level`** — the minimum severity admitted to the
  logger (`trace`, `debug`, `info`, `warn`, `error`, or `off`;
  default `info`). Records below the threshold are dropped before
  they're built, and `off` silences the logger entirely. Changes
  apply to subsequent records without a reload.
- **`intellig.log.console`** — when `true`, mirror each record to the
  developer console as well as the channel (default `false`). The
  console output is visible only in the Extension Development Host,
  so this is aimed at contributors debugging IntelliG itself.

## Coexistence with VS Code's built-in Git

IntelliG runs `git` directly via `child_process` rather than going
through VS Code's git extension API. The practical implications:

- IntelliG works even when `git.enabled` is set to `false`.
- IntelliG registers its own **"IntelliG Git"** Source Control provider
  in the SCM view (Staged Changes / Changes groups + a commit input box,
  `Ctrl/Cmd+Enter` to commit). It appears alongside VS Code's built-in
  SCM entry rather than replacing it, so both views keep working — use
  whichever you prefer, plus IntelliG's IntelliJ-style panels (Branch
  popup, Git tool window, etc.).
- File-tree decorations (M / U / A glyphs in the Explorer) come from
  VS Code's built-in git extension. IntelliG does not register a global
  file-decoration provider, so it does not double-paint Explorer
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

| Action                       | Default                    | IntelliJ Preset                                |
| ---------------------------- | -------------------------- | ---------------------------------------------- |
| Commit                       | Ctrl/Cmd+K                 | Ctrl/Cmd+K                                     |
| Push                         | Ctrl+Shift+K               | Ctrl+Shift+K                                   |
| Pull                         | Ctrl/Cmd+T                 | Ctrl/Cmd+T                                     |
| Branch Popup                 | Ctrl+Shift+`               | Alt+`                                          |
| Git Tool Window              | Alt+9 / Cmd+9              | Alt+9 / Cmd+9                                  |
| Commit Tool Window           | Alt+0                      | Alt+0                                          |
| Refresh Status               | Ctrl+Shift+R               | Ctrl+Shift+R                                   |
| Stage Selected               | Ctrl/Cmd+Alt+A             | Ctrl/Cmd+Alt+A                                 |
| Unstage Selected             | Ctrl/Cmd+Alt+Z             | — (chord taken by Revert File; see note below) |
| Revert File                  | —                          | Ctrl/Cmd+Alt+Z                                 |
| Shelve Silently              | Ctrl+Shift+H / Cmd+Shift+H | Ctrl+Shift+H / Cmd+Shift+H                     |
| Unshelve Silently            | Ctrl/Cmd+Alt+U             | Ctrl/Cmd+Alt+U                                 |
| Jump to Commit (Log)         | Ctrl/Cmd+F                 | Ctrl/Cmd+F                                     |
| Show Blame                   | —                          | Ctrl/Cmd+Alt+Shift+A                           |
| Show File History            | —                          | Ctrl/Cmd+H                                     |
| Show Shelf List              | —                          | Ctrl/Cmd+Shift+U                               |
| Compare with Current         | —                          | Ctrl/Cmd+D                                     |
| Move Files To Changelist     | —                          | F6                                             |
| Open File from Local Changes | —                          | F4                                             |

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

| Action            | Binding  |
| ----------------- | -------- |
| Next Conflict     | Alt+Down |
| Previous Conflict | Alt+Up   |
| Accept Current    | Alt+1    |
| Accept Both       | Alt+2    |
| Accept Incoming   | Alt+3    |

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

| Setting                           | Default     | Description                                                                                                      |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `intellig.useCommitToolWindow`    | `true`      | Show the IntelliJ-style Commit tool window in the IntelliG panel; disable to use the classic modal Commit dialog |
| `intellig.useTabbedGitToolWindow` | `true`      | Use the tabbed Git tool window (Log/History/Incoming/…)                                                          |
| `intellig.keymapPreset`           | `"default"` | `"default"` or `"intellij"`                                                                                      |

### Multi-repo discovery

| Setting                                 | Default | Description                                                     |
| --------------------------------------- | ------- | --------------------------------------------------------------- |
| `intellig.repositoryScanMaxDepth`       | `1`     | Max depth for nested-repo discovery; `-1` for unlimited         |
| `intellig.repositoryScanIgnoredFolders` | `[]`    | Extra folder basenames to skip during the scan                  |
| `intellig.defaultRepo`                  | `""`    | Preferred repo basename or absolute path when multiple are open |

### Commit & Push behavior

| Setting                                   | Default              | Description                                                  |
| ----------------------------------------- | -------------------- | ------------------------------------------------------------ |
| `intellig.defaultCommitSignOff`           | `false`              | Add `Signed-off-by` line to commit messages                  |
| `intellig.commitAuthor`                   | `""`                 | Optional commit-author override in `Name <email>` format     |
| `intellig.commitMessageTemplate`          | `""`                 | Default commit message template                              |
| `intellig.commitMessageIssueLinks`        | `true`               | Detect issue/PR references and render as clickable links     |
| `intellig.protectedBranches`              | `["main", "master"]` | Branches that require a confirm before destructive ops       |
| `intellig.pullRebase`                     | `false`              | Use `--rebase` by default in the Pull dialog                 |
| `intellig.autoOpenResolveConflictsDialog` | `true`               | Open the Resolve Conflicts dialog automatically on conflicts |

### Fetch & shelf

| Setting                              | Default  | Description                                          |
| ------------------------------------ | -------- | ---------------------------------------------------- |
| `intellig.autoFetchEnabled`          | `true`   | Enable periodic background fetch                     |
| `intellig.autoFetchInterval`         | `180`    | Auto-fetch interval in seconds                       |
| `intellig.fetchTags`                 | `"auto"` | Tag-fetch policy: `"auto"`, `"all"`, or `"never"`    |
| `intellig.shelve.removeAppliedFiles` | `false`  | Remove successfully-applied files from a shelf entry |

### Blame annotations

| Setting                                     | Default    | Description                                                                         |
| ------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `intellig.blameAnnotationStyle`             | `"inline"` | `"inline"`, `"gutter"`, `"both"`, or `"off"`                                        |
| `intellig.blame.ignoreWhitespace`           | `false`    | Pass `-w` to `git blame`                                                            |
| `intellig.blame.detectMovementsWithinFile`  | `false`    | Pass `-M` to `git blame`                                                            |
| `intellig.blame.detectMovementsAcrossFiles` | `false`    | Pass `-C -C` to `git blame`                                                         |
| `intellig.blame.colorMode`                  | `"order"`  | Background tint: `"order"` (age heat) or `"author"`                                 |
| `intellig.blame.showAuthor`                 | `true`     | Show the author column (Author aspect)                                              |
| `intellig.blame.showDate`                   | `true`     | Show the date column (Date aspect)                                                  |
| `intellig.blame.showRevision`               | `true`     | Show the revision/hash column (Revision aspect)                                     |
| `intellig.blame.authorNameFormat`           | `"full"`   | Author rendering: `"full"`, `"firstname"`, `"lastname"`, `"initials"`, or `"email"` |

### Diff

| Setting                       | Default     | Description                                                                                                                                                         |
| ----------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intellig.diff.ignorePolicy`  | `"default"` | Whitespace ignore policy for diffs (IntelliJ "Ignore whitespace"): `"default"`, `"trim-whitespaces"`, `"ignore-whitespaces"`, or `"ignore-whitespaces-empty-lines"` |
| `intellig.lineStatus.enabled` | `true`      | Show live changed-line markers (added/modified/deleted vs `HEAD`) in the editor gutter, mirroring IntelliJ's change markers                                         |

### Branches popup

| Setting                                | Default | Description                                                                         |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `intellig.branches.showTags`           | `true`  | Show the Tags section in the branches popup (toggle from the popup's settings gear) |
| `intellig.branches.showRecentBranches` | `true`  | Show the Recent section in the branches popup (toggle from the settings gear)       |
| `intellig.branches.groupByDirectory`   | `true`  | Indent branches that share a `/`-prefix (e.g. `feature/*`) in the branches popup    |

### UI polish

| Setting                              | Default     | Description                                                                                                                                          |
| ------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intellig.showStatusBarBranch`       | `true`      | Show current branch + incoming/outgoing badge in the status bar                                                                                      |
| `intellig.log.highlightCherryPicked` | `true`      | Dim commits already cherry-picked into the current branch                                                                                            |
| `intellig.log.showGpgColumn`         | `false`     | Show a GPG/SSH signature status column in the commit log                                                                                             |
| `intellig.log.showAllRoots`          | `true`      | Show commits from all workspace repositories merged into one log, matching the branch view; disable to scope a multi-repo log to one repository (G8) |
| `intellig.modifiedFileColor`         | `"#6897BB"` | Color for modified files (IntelliJ blue)                                                                                                             |
| `intellig.addedFileColor`            | `"#629755"` | Color for added files (IntelliJ green)                                                                                                               |
| `intellig.deletedFileColor`          | `"#6C6C6C"` | Color for deleted files (IntelliJ gray)                                                                                                              |
| `intellig.ignoredFileColor`          | `"#848504"` | Color for ignored files                                                                                                                              |
| `intellig.conflictFileColor`         | `"#FF0000"` | Color for conflicted files (red)                                                                                                                     |

### Logging

| Setting                | Default  | Description                                                                                                                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `intellig.log.level`   | `"info"` | Minimum severity admitted to the logger (`trace`, `debug`, `info`, `warn`, `error`, `off`). Records below the threshold are dropped; `off` silences the logger entirely. |
| `intellig.log.console` | `false`  | Mirror log records to the developer console (visible only in the Extension Development Host)                                                                             |

## Feedback & Issues

Found a bug, have a question, or want to request a feature? [Open an issue](https://github.com/KHC831/intellig-issues/issues) on the public issue tracker.

For security vulnerabilities, please use [GitHub's private vulnerability reporting](https://github.com/KHC831/intellig-issues/security/advisories/new) — your report stays private to repo maintainers and isn't disclosed publicly until a fix ships.

## License

Proprietary — all rights reserved. The full LICENSE file is included
in the extension package. For licensing inquiries, [open an issue](https://github.com/KHC831/intellig-issues/issues) tagged `licensing`.
