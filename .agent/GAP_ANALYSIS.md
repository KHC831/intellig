# IntelliG → IntelliJ Parity Gap Analysis

_Scope: core parity (incl. UI layout + right-click menu structure). Excludes submodules, GPG, Git flow, PR integration, filter DSLs (see §5). Evidence cites `CURRENT_FEATURES.md` (CF) and `INTELLIJ_REFERENCE.md` (IR). All `file:line` evidence lives in CF; this doc refers to CF rows rather than re-citing sources._

---

## 1. Gap matrix

### Commit

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Commit dialog w/ file + hunk + line staging | ✅ | CF Commit §1–4 | None (BUG-01 fixed) |
| Non-modal **Commit tool window** (Alt+0) w/ Local Changes + Shelf tabs, message history, gear menu | 🟡 | CF UI §"Commit tool window" | Current dialog is a floating webview panel; no persistent tool window, no tabs, no history dropdown, no gear |
| Amend / Sign-off toggles | ✅ | CF rows 6–7 | None |
| Commit and Push (Ctrl+Alt+K) | ⚠️ | CF row 9 | `intellig.push` is a "Coming Soon" stub; no combined Commit-and-Push |
| Recent message history dropdown | ❌ | CF row 10 | Missing |
| Custom author override | ❌ | CF row 11 | Missing |
| Pre-commit checks (reformat, optimize, TODO, inspections, run-config, upload-after) | ❌ | CF row 12 | Whole feature class missing |
| `--no-verify` hook toggle | ❌ | CF row 13 | Missing |

### Branches

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Branches popup: sections Recent / Local / Remote / Tags + search + favorites + auto-group | 🟡 | CF Branches §1, UI §"Branches popup" | Flat QuickPick — no sections, no recent, no favorites, no search chip, no `/`-grouping |
| Branch tree with local/remote | ✅ | CF row 2 | OK; lacks tag tree node w/ menu |
| Create / checkout / rename / delete / merge / rebase / compare / push / update | ✅ | CF rows 3–11 | `update` now merges for current branch (BUG-08 fixed) |
| Show diff with working tree | 🟡 | CF row 12 | URI scheme fixed, but `vscode.diff` still receives a directory URI on right side (BUG-17) — effectively broken |
| Checkout and Rebase onto Current | 🟡 | CF row 14 | Registered; flagged stub in menu commands file |
| Pull remote → current (rebase / merge variants) | 🟡 | CF rows 16–17 | Both registered but lack dedicated dialog; reuse generic pull |
| Cherry-pick commits from remote branch | ✅ | CF row 18 | BUG-07 fixed |
| Favorites / Recent branches / auto-group by `/` | ❌ | CF rows 21–23 | Missing |
| Multi-root synchronous ops | 🟡 | CF row 24 | Discovery only; most commands use `repositories[0]` |

### Log & history

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Log tab with commit graph, branches/remotes filters, inlay hints | 🟡 | CF Log §1–5 | Graph + load + path/author/date/text filters present; **no 4-pane layout**, no branch-filter source, no indexing toggle, no inlay hints |
| 4-pane layout: Branches ‖ Commits ‖ Changed Files ‖ Details | 🟡 | CF Log row "Separate Log tab" | Currently 2-panel; right side does not split files vs metadata; no left branches pane |
| Go-to-hash / tag / branch (Ctrl+F) | ❌ | CF row "Go-to-hash" | Missing |
| Commit right-click: New Branch, New Tag, Compare with HEAD, Show File in Revision, File History from Here, Show Diff, Show all Branches for this Commit | ❌ / 🟡 | CF "Context menus" row "Log commit" | Several absent; rebase-specific reword/squash/fixup only via rebase editor |
| Separate Git tool window tabs: Log / Console / Repository / Incoming / Update Info / History | 🟡 | CF UI "Git tool window" | Single-view webview; Console streams but has no UI tab; no Incoming / Update Info; history is QuickPick only |
| External hosting / issue tracker links | ❌ | CF row "External hosting" | Missing |
| File history: follow rename, filter by branch, diff any two revisions, open read-only, get/rollback to revision | 🟡 / ❌ | CF File&line section | Most missing; read-only URI provider exists; no `--follow`; no two-rev diff; no rollback-to-revision |

### Merge & conflict resolution

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Three-pane merge view (Current / Result / Incoming) w/ accept + nav | ✅ | CF Merge §1–7 | BUG-02 fixed |
| Apply all non-conflicting changes (left / right / both) | 🟡 | CF row "Apply all non-conflicting…" | Have "all current" / "all incoming"; missing per-side variants |
| Auto-open merge view on conflict | ❌ | CF row "Auto-open…" | User must manually open |
| Resolve Conflicts dialog (file list w/ Accept Yours / Theirs / Merge…) | ❌ | CF row "Merge dialog" | No dedicated conflict-file picker — users re-enter via command palette |
| Merge dialog (branch + no-ff / squash / no-commit / message) | ❌ | CF row "Merge dialog" | Missing |

### Rebase

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Interactive rebase editor (pick/reword/edit/squash/fixup/drop + reorder + abort/continue) | ✅ | CF Rebase §1–6 | BUG-12 fixed |
| Rebase --skip | ❌ | CF row "Skip commit" | Missing |
| Plain rebase from branches popup | ✅ | CF row "Plain rebase" | OK |
| Checkout-and-rebase-onto-current | 🟡 | (see Branches row 14) | Stub |

### Cherry-pick

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Single / multi cherry-pick | ✅ | CF Cherry-pick §1–2 | OK |
| Cherry-pick without commit (`--no-commit`) | ❌ | CF row 4 | Missing |
| Apply Selected Changes (file-subset) | ❌ | CF row 5 | Missing |
| Apply Files to Branch | ❌ | CF row 6 | Missing |
| Highlight already-cherry-picked commits in log | ❌ | CF row 7 | Missing |

### Reset & revert

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Reset modes soft / mixed / hard / keep | 🟡 | CF Reset §1–2 | `keep` missing (only 3 of 4 modes) |
| "Reset Current Branch to Here…" dialog (radios + target commit) | 🟡 | CF row 3 | Implemented as QuickPick of modes, not as dialog |
| Undo last commit | ✅ | CF row 4 | |
| Drop commit | ✅ | CF row 5 | Uses rebase-drop, no protected-branch blocker |
| Revert commit (creates inverse) | ✅ | CF row 6 | |
| Revert file | ✅ | CF row 7 | |
| Selective file-subset revert | ❌ | CF row 8 | Missing |
| Drop selected changes from unpushed commit | ❌ | CF row 9 | Missing |

### Remote ops (push / pull / fetch)

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Push dialog (repo table, target editing, force-with-lease, push-tags, Push All up to Here, preview) | ❌ | CF Remote §1,4 | `intellig.push` is stub; no dialog |
| Pull dialog w/ flags (`--rebase`, `--ff-only`, `--no-ff`, `--squash`, `--no-commit`, `--no-verify`) | ❌ | CF Remote §2,5 | `intellig.pull` is stub; only `intellig.pullRebase` config toggle |
| Fetch (command palette, VCS widget) | ⚠️ | CF row 3 | "Coming Soon" stub (underlying `fetch()` service works) |
| Update Project (Ctrl+T, multi-root, merge/rebase/reset strategies, Update Info tab) | ❌ | CF row 6 | Missing entirely |
| Auto-fetch scheduler | 🟡 | CF row 7 | Config keys present, no scheduler code |
| Incoming commits indicator | ❌ | CF row 8 | Missing |
| Manage Remotes UI (add / edit / remove) | 🟡 | CF row 9 | Service methods exist, no UI |
| Branch context-menu Push with dialog | 🟡 | CF row 10 | Invokes push but no force-with-lease / target-editing dialog |

### Tags

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Create lightweight tag from Log context menu "New Tag…" | ❌ | CF Tags §1 | No `intellig.tag.new` command; createTag reachable only from service |
| Create annotated tag (Git \| New Tag, commit + message) | 🟡 | CF row 2 | Service supports; no UI |
| Delete / push-single / checkout-detached / cherry-pick / new-branch-from | ✅ | CF rows 3–8 | OK — but **tag tree node has no `view/item/context` menu entry**, so these are reachable only via command palette |
| Push all tags / `--follow-tags` | ❌ | CF row 5 | Missing |
| Jump-to-tag picker | ❌ | CF row 9 | Missing |
| `fetch.tags` / auto-sync tags setting | ❌ | CF row 11 | Missing |

### Blame / annotate

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Inline + gutter annotation, toggle, hover, copy hash, show commit | ✅ | CF Blame §1–5,9–10 | OK (PERF-05/07 fixed) |
| Ignore whitespace changes | ❌ | CF row 6 | Missing |
| Detect movements within/across files | ❌ | CF row 7 | Missing |
| Annotate previous revision | ❌ | CF row 8 | Missing |
| Hide revision | ❌ | CF row 9 | Missing |
| Gutter right-click menu (Show Commit / Copy Revision / Annotate Previous / Hide / Options / Show Diff) | ❌ | CF Context menus "Gutter blame" | No right-click menu on blame gutter — only toggles via command palette |

### Shelve

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Create / unshelve / delete / preview | ✅ | CF Shelve §1–2,5,7 | Async fs in place |
| Silent shelve (Ctrl+Shift+H uses changelist name) | ❌ | CF row 3 | Missing |
| Silent unshelve (Ctrl+Alt+U) | ❌ | CF row 4 | Missing |
| Rename shelf | ❌ | CF row 6 | Missing |
| "Remove successfully applied files from shelf" toggle | ❌ | CF row 8 | Missing |
| Already-Unshelved filter / Restore | ❌ | CF row 10 | Missing |
| Import Patches into shelf | ❌ | CF row 11 | Missing |
| Shelf right-click context menu in a tab | ❌ | CF Context menus "Shelf" | ShelfView is QuickPick, not a tree with context menu |
| Shelf tab inside Commit tool window (with diff preview pane) | ❌ | CF UI "Shelf tab" | Missing |

### Stash

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Create / apply / pop / drop / list / preview | ✅ | CF Stash §1–7 | BUG-11 fixed (real timestamps) |
| Branch from stash (`git stash branch`) | ❌ | CF row 8 | Missing |
| Stash right-click context menu (rename, diff, branch-from) | 🟡 | CF row 9 | Partial — apply/pop/drop only |
| Combined Stash+Shelf tab | ❌ | CF UI "Stash tab" | Missing |

### Changelists

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Service: create / rename / delete / move / set-default | ✅ | CF Changelists §1–3,5 | OK |
| UI surface (tree / panel / changelist node in Commit tool window) | ❌ | CF UI "Changelist tree" | **No visible changelist anywhere** — service is dead weight to users |
| Commit a specific changelist | ❌ | CF row 4 | Missing |
| Shelve a changelist | ❌ | CF row 5 | Missing |
| Changelist right-click menu (New, Set Active, Rename, Remove, Edit Description) | ❌ | CF Context menus "Changelist" | Missing entirely |

### Remote ops — see Remote ops matrix above.

### Patches

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Create patch from commit | ✅ | CF Patches §1 | OK |
| Create patch from local changes | ❌ | CF row 2 | Missing |
| Create patch from file-history revision | ❌ | CF row 3 | Missing |
| Apply patch (file or clipboard, base-dir mapping, strip-path, diff preview, assign-to-changelist) | ❌ | CF row 4 | Missing entirely — no `git apply` / `git am` surface |
| Patch-to-clipboard output target | ❌ | CF row 5 | Missing |

### File & line history

| IntelliJ capability | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| Show History for File / Selection / Line | ✅ | CF File&line §1–2 | QuickPick, not tabbed panel |
| Follow rename | ❌ | CF row 3 | No `--follow` |
| Filter by branch | ❌ | CF row 4 | Missing |
| Diff any two revisions | ❌ | CF row 5 | Missing |
| Compare with local | ✅ | CF row 6 | From log, not history view |
| Open revision content (read-only) | ✅ | CF row 7 | `intellig-git:` URI |
| Create patch from revision | 🟡 | CF row 8 | Via commit menu only |
| Get/rollback file to revision | ❌ | CF row 9 | Missing |

### UI structure

| IntelliJ surface | IntelliG status | Evidence | Gap summary |
|---|---|---|---|
| **Commit tool window** (Alt+0, non-modal, Local Changes + Shelf tabs, message history, gear w/ checks) | 🟡 | CF UI | Floating webview only; no tool window, no tabs, no message history, no gear |
| **Git tool window** (Alt+9) w/ tabs Log / Console / Repository / Incoming / Update Info / History | 🟡 | CF UI | Single 2-panel webview; no tabs beyond the built-in graph+details |
| **Log tab 4-pane layout** | 🟡 | CF UI | 2-pane only; no left-branches, right not split files/details |
| **Branches popup** sections (Recent / Local / Remote / Tags) + filter + favorites | 🟡 | CF UI | Flat QuickPick |
| **Push / Pull / Merge / New Branch / New Tag / Reset dialogs** | ❌ | CF UI "Dialog layouts" | None of these dialogs exist; input-box + quickPick substitutes |
| **Resolve Conflicts dialog** (file list + per-row Yours/Theirs/Merge) | ❌ | CF UI | Missing |
| **Shelf tab / Stash tab** in Commit tool window | ❌ | CF UI | QuickPick surfaces only |
| **Console tab** (raw command output) | 🟡 | CF UI | Service streams, no UI tab |
| **Status-bar branch indicator + VCS widget** | ✅ | CF UI | StatusBarService |
| **Rebase progress in status bar** | ✅ | CF UI | RebaseProgressView |

### Right-click menus (the biggest menu-parity gaps)

| Menu | Missing items (by IntelliJ label) |
|---|---|
| **Tag tree item** | Entire menu missing (`view/item/context` not declared for `viewItem == intellig.tag`). Should include: `Checkout`, `Compare with working tree`, `Merge`, `Push`, `Delete`, `New Branch from Tag…`, `Cherry-Pick` |
| **Log commit right-click** | `New Branch…`, `New Tag…`, `Reset Current Branch to Here…` (currently `resetToHere` QuickPick — label mismatch), `Compare with HEAD`, `Compare with…` (arbitrary ref), `Show File in Revision`, `File History from Here`, `Show Diff`, `Show all Branches for this Commit`, `Reword` / `Squash` / `Fixup` as top-level entries |
| **Branches popup — local (non-current)** | `Checkout and Update` (distinct from `Checkout and Rebase`), `Compare with Working Tree` (separate from `Show Diff with Working Tree`) |
| **Branches popup — remote** | `Cherry-Pick Commits` is a registered command but **not bound to the remote menu group** (package.json:406 lacks it) |
| **Explorer (file)** | `Add to VCS`, `Annotate with Git Blame`, `Rollback…`, `Create Patch from File…`, `Apply Patch…`, `Compare with Revision…`, `Compare with the Same Repository Version` |
| **Editor** | `Annotate`, `Rollback`, `Show History for Selection`, `Apply Patch…` |
| **Changelist** | Entire menu missing (no changelist surface) |
| **Shelf** | Entire menu missing (QuickPick has implicit actions, no right-click tree) |
| **Stash** | `Rename`, `Create Branch from Stash`, explicit `Show Diff` entry |
| **Gutter blame** | No right-click menu surface at all (`Show Commit`, `Copy Revision Number`, `Annotate Previous Revision`, `Hide Revision`, `Options` submenu) |

---

## 2. Work items (tiered)

Legend: **Effort** S < 1d, M 1–3d, L 3–7d. **Risk** flagged where data-loss or UX regression is material.

### Tier 1 — Core parity blockers (ship-stopping)

#### T1-01: Implement Push dialog (force-with-lease, push-tags, target editing, commit preview)
- Scope: Replace `intellig.push` "Coming Soon" stub with a webview dialog matching IR "Push dialog" (repo table, per-row target editing, Push-tags checkbox, Push button w/ dropdown to Force-with-lease). Wire to `GitService.push` (force-with-lease flag already plumbed).
- Files: `extension.ts:284` (`intellig.push`), `services/GitService.ts:637` (push opts), **new** `services/PushDialog.ts`, `commands/BranchContextMenuCommands.ts` (`branch.push` handler).
- Effort: **L** (new webview, multi-repo layout, diff preview pane).
- Risk: **Data-loss** — force-with-lease default required; bare `--force` must never be default. Confirm dialog for protected-branch override. Document in `BUGS.md`.
- UI specifics: lives where IR places Push dialog — launched from `Ctrl+Shift+K`, `intellig.push`, branch context menus (`Push...`), and "Commit and Push" from Commit tool window. Menu label parity: `Push...` (ellipsis on commands that open dialogs).

#### T1-02: Implement Pull dialog w/ flags & wire `intellig.pull`
- Scope: Replace `intellig.pull` stub. Dialog with remote dropdown, branch list, checkboxes `--rebase / --ff-only / --no-ff / --squash / --no-commit / --no-verify`. `pullUsingRebase` / `pullUsingMerge` remote-branch menu items should route to this dialog with pre-filled flags.
- Files: `extension.ts:290`, `services/GitService.ts` (`pull()` needs fresh flags beyond current `--rebase`), `BranchContextMenuCommands.ts:131/137`, **new** `services/PullDialog.ts`.
- Effort: **M**.
- Risk: `--no-commit` + conflicts require the auto-merge-view integration (T1-08).
- UI specifics: invoked by `Ctrl+T` (current keybinding to `intellig.pull`), Branches popup remote→`Pull into Current Using…`, command palette.

#### T1-03: Implement `intellig.fetch` + Auto-fetch scheduler
- Scope: Wire `intellig.fetch` to `GitService.fetch`. Start a `setInterval` (or recursive `setTimeout`) on activation honoring `intellig.autoFetchEnabled` + `autoFetchInterval` (currently 180s default). Cancel on deactivate. Expose "Fetch all remotes" path. Add status-bar incoming-commits indicator after fetch (reuse `StatusBarService`).
- Files: `extension.ts:296` (stub), `services/GitService.ts:605`, `services/StatusBarService.ts`.
- Effort: **S**.
- Risk: low; dispose schedulers on deactivate to avoid leak.
- UI specifics: command palette, VCS widget incoming-commits badge.

#### T1-04: Commit tool window (non-modal) w/ tabs Local Changes | Shelf
- Scope: Introduce a persistent view (webview or tree) at `Alt+0`-equivalent that replaces the spawned Commit Dialog panel. Tabs: `Local Changes` (files grouped by changelist — depends on T1-06), `Shelf` (list w/ diff preview pane). Message history dropdown. Gear submenu stub (content in T2-06).
- Files: register new view in `package.json` `views.intellig`, new `services/CommitToolWindow.ts`, reuse `CommitDialog.ts` internals, integrate `ShelfView` as tab content.
- Effort: **L**.
- Risk: UX regression if old modal dialog disappears — keep `intellig.commit` working; new window is additional surface. Consider feature flag initially.
- UI specifics: `Alt+0` keybinding (add to package.json). Matches IR "Commit tool window" layout.

#### T1-05: Git tool window tabs: Log | Console | Incoming | Update Info | History
- Scope: Refactor `GitToolWindowProvider` from a single 2-panel view into a tabbed layout. Re-home existing graph+details into the `Log` tab. New `Console` tab binds to `ConsoleService` streams (already wired internally). New `Incoming` tab lists commits fetched but not merged (leverage `rev-list HEAD..@{u}`). `Update Info` tab shows last pull/update result. `History` tab replaces the current QuickPick-based file history with an embedded panel.
- Files: `services/GitToolWindowProvider.ts` (3572 lines, major split), `services/ConsoleService.ts`, `package.json` views config.
- Effort: **L**.
- Risk: Perf regression from managing multiple DOMs; keep incremental-postMessage pattern (PERF-04 principle) per tab.
- UI specifics: `Alt+9` already bound. Each tab matches IR "Git tool window" section.

#### T1-06: Changelist tree UI + context menu + commit-one-changelist
- Scope: Currently `ChangelistService` has zero UI. Add a tree or nested node inside the Commit tool window (T1-04) showing changelists as expandable groups of modified files. Context menu: `New Changelist…`, `Set Active Changelist`, `Rename Changelist…`, `Remove Changelist`, `Edit Description`, `Move to Another Changelist…` (F6), `Shelve Changelist`. Extend commit path to target only the active changelist's files.
- Files: new `services/ChangelistTreeProvider.ts`, extend `ChangelistService`, `CommitDialog`/`CommitToolWindow` integration, `package.json` menus.
- Effort: **L**.
- Risk: Changelist is a client-side overlay — reconciliation with external `git add` actions needs care. Document interactions with partial staging.
- UI specifics: IR §"Local Changes / changelist context menu" — match labels exactly.

#### T1-07: Log commit right-click menu parity
- Scope: Extend the commit context menu to match IR §"Log commit context menu" (10 sourced items). Add `New Branch…`, `New Tag…` (depends on T1-09), `Compare with HEAD`, `Compare with…`, `Show File in Revision`, `File History from Here`, `Show Diff`, `Show all Branches for this Commit`. Rename `Copy hash` → `Copy Revision Number` for label parity. Split `Reword` / `Squash` / `Fixup` as top-level items in addition to the rebase editor path.
- Files: `services/GitToolWindowProvider.ts` (context menu dispatcher around `onDidRequestLogContextAction`), `commands/CommitContextMenuCommands.ts`.
- Effort: **M**.
- Risk: Reword/squash/fixup as one-off actions must reuse the rebase machinery and respect protected-branch rules.
- UI specifics: IR §"Log commit context menu".

#### T1-08: Auto-open merge view on conflict + Resolve Conflicts dialog
- Scope: When `merge`, `rebase`, `cherry-pick`, `pull`, `revert`, or `unshelve/unstash` encounters conflicts (currently surfaced as `result.conflicts`), open a Resolve Conflicts dialog: file list w/ unmerged status + per-row buttons `Accept Yours` / `Accept Theirs` / `Merge…` (opens existing three-pane view). Auto-watch for `.git/MERGE_HEAD` / `REBASE_HEAD` etc. and surface a status-bar prompt.
- Files: `services/ConflictResolutionService.ts` (add auto-trigger), **new** `services/ResolveConflictsDialog.ts`, hook sites in `GitService.mergeBranch/rebaseBranch/cherryPick/pull` and `BranchPopup` actions.
- Effort: **M**.
- Risk: UX critical — without it, users hit a dead end on conflicts. Ensure abort/continue buttons remain discoverable.
- UI specifics: IR §"Resolve Conflicts dialog".

#### T1-09: New Tag dialog + command + tag-node right-click menu
- Scope: Add `intellig.tag.new` command + webview/input dialog for lightweight *and* annotated tags (name + optional message). Add `view/item/context` menu group in `package.json` for `viewItem == intellig.tag` (currently missing — see CF "Right-click menus" row for Tag tree item). Bind the existing `intellig.tag.{checkoutDetached,newBranchFrom,cherryPick,delete,push}` commands to the menu.
- Files: `package.json` contributes.commands + menus, **new** `services/NewTagDialog.ts`, `extension.ts` registration.
- Effort: **S**.
- Risk: low.
- UI specifics: IR §Tags; tag-tree menu and Log commit → `New Tag…` entry (T1-07 depends on this).

#### T1-10: Branches popup redesign — sections + search + favorites + recent
- Scope: Rebuild `BranchPopup` as a sectioned picker: `Recent` (≤5, tracked in workspace state) · `Local` · `Remote` · `Tags`. Search/filter at top, favorites star (persist to `ConfigurationService`), auto-group by `/` prefix (collapsible headers). Matches IR §"Branches popup".
- Files: `services/BranchPopup.ts` (major rewrite of `show()` / picker build).
- Effort: **M**.
- Risk: UX regression for existing users of the flat picker — provide keybinding parity (`Ctrl+Shift+\``).
- UI specifics: IR §"Branches popup"; sourced contextually to IntelliJ.

#### T1-11: Reset dialog (radio soft/mixed/hard/keep + commit display)
- Scope: Replace the QuickPick in `CommitContextMenuCommands._handleResetToHere` with a webview dialog showing the target commit hash/subject and 4 radio buttons (add missing `keep`). Match IR §"Reset Current Branch to Here dialog".
- Files: `commands/CommitContextMenuCommands.ts:293`, **new** `services/ResetDialog.ts` (or keep as webview inlined).
- Effort: **S**.
- Risk: **Data-loss** (hard reset) — confirm dialog must surface destructiveness; blocked on protected branch check if that infra lands.
- UI specifics: Launched from Log → `Reset Current Branch to Here…` (new label).

#### T1-12: Apply Patch command (+ Create Patch from Local Changes)
- Scope: Add `intellig.patch.apply` command (file picker + optional clipboard input), parse headers, optionally map base-dir / strip leading paths, show diff preview (reuse `ShelfView` preview), assign to changelist (needs T1-06). Also add `intellig.patch.createFromLocal` to complement existing "create from commit".
- Files: new `services/PatchService.ts`, new `services/ApplyPatchDialog.ts`, `extension.ts` registrations, `package.json` menus (Explorer `Apply Patch…`, VCS menu).
- Effort: **M**.
- Risk: data-correctness — patch rejection must be surfaced; fallback to `git am` vs `git apply`.
- UI specifics: Explorer right-click `Apply Patch…`, Commit tool window "Create Patch from Local Changes".

### Tier 2 — Rough edges / partials to finish

#### T2-01: Fix `branch.showDiffWithWorkingTree` directory-URI bug (BUG-17 residual)
- Scope: Current code sets right URI to `repo.rootUri` (a directory). Replace with per-file flow: list changed files between branch & working tree, then `vscode.diff` per-file, or render a custom diff tree-view.
- Files: `commands/BranchContextMenuCommands.ts:513–534`.
- Effort: **S**.
- Risk: low (bug already latent).

#### T2-02: Finish `checkoutAndRebase` / `pullUsingRebase` / `pullUsingMerge` handlers
- Scope: These are registered as commands but are stubs/partial in `BranchContextMenuCommands`. Implement to call `GitService.checkout` + `rebaseBranch`, and `pull` with the appropriate flag. Depends on T1-02.
- Files: `commands/BranchContextMenuCommands.ts:125/131/137`.
- Effort: **S**.

#### T2-03: Multi-root command targeting
- Scope: Commands currently default to `repositories[0]`. Add a repository picker prompt (or use the tool-window repo selector) for: `intellig.commit`, `intellig.showHistory`, `intellig.stash`, `intellig.showBranchPopup`, `intellig.rebase.interactive`, `intellig.revertFile`. Apply synchronously across roots where IntelliJ does (branches popup ops).
- Files: `extension.ts` activation handlers; consider helper `resolveRepo(context)`.
- Effort: **M**.
- Risk: subtle behavior change; add config toggle `intellig.defaultRepo`.

#### T2-04: Multi-file revert from commit & drop-selected-changes
- Scope: Extend revert UI to allow deselecting files within a multi-file commit (IR "selective file-subset revert"). Add "Drop selected changes" for hunk-level removal from an unpushed commit.
- Files: `commands/CommitContextMenuCommands.ts:181`, new file-selection dialog.
- Effort: **M**.
- Risk: **Data-loss** for drop-selected-changes; confirm.

#### T2-05: Cherry-pick `--no-commit` + Apply Selected Changes + Apply Files to Branch
- Scope: Expose `--no-commit` flag (new menu entry `Cherry-Pick Without Commit`). Add `Apply Selected Changes` (file-subset cherry-pick from commit detail file list) and `Apply Files to Branch`.
- Files: `services/GitService.ts:999` (plumb flag), menu items in package.json.
- Effort: **M**.

#### T2-06: Commit dialog — recent messages + custom author + gear menu stubs
- Scope: Message history dropdown (store last N subjects in workspaceState). Author override field. Gear menu UI (content deferred; at minimum checkboxes for `Run before-commit checks` and `--no-verify`).
- Files: `services/CommitDialog.ts`, `services/ConfigurationService.ts`.
- Effort: **M**.
- Risk: low.

#### T2-07: File history panel + `--follow` + branch filter + two-rev diff
- Scope: Upgrade current QuickPick-based `showHistory` to an embedded panel in the Git tool window History tab (depends on T1-05). Add `--follow` for rename tracking, per-branch filter, diff-any-two-revisions action, compare-with-local.
- Files: `extension.ts:1288` (showHistory), `services/GitService.ts:877`, `services/GitToolWindowProvider.ts` History tab.
- Effort: **M**.

#### T2-08: Blame gutter right-click menu + ignore-whitespace / detect-movements
- Scope: Attach editor-gutter command palette menu via `editor/lineNumber/context` (if feasible) or a CodeLens. Add options `Ignore Whitespaces`, `Detect Movements Within File`, `Detect Movements Across Files`, `Annotate Previous Revision`, `Hide Revision`. Pass corresponding flags to `git blame` (`-w`, `-M`, `-C`).
- Files: `services/BlameService.ts`, `services/GutterBlameProvider.ts`, `services/InlineBlameProvider.ts`, `package.json` menus.
- Effort: **M**.
- Risk: parser change when adding `-w/-M/-C` — verify `parseBlame` handles heuristic output.

#### T2-09: Stash context menu: branch-from-stash, rename
- Scope: Convert `StashView` from QuickPick-only to a tree with right-click menu: `Apply`, `Pop`, `Drop`, `Rename`, `Create Branch from Stash`. Add `GitService.stashBranch` method (`git stash branch`).
- Files: `services/StashView.ts`, `services/GitService.ts`, package.json menus.
- Effort: **S**.

#### T2-10: Shelf tab + context menu + rename / silent / import-patches / already-unshelved
- Scope: Convert ShelfView to a tree tab (in Commit tool window — depends on T1-04). Right-click menu per IR §"Shelf context menu". Add silent shelve (Ctrl+Shift+H), silent unshelve (Ctrl+Alt+U), Rename, `Remove successfully applied files from shelf` toggle, Already-Unshelved filter+Restore, Import Patches.
- Files: `services/ShelfView.ts`, `services/ShelfService.ts`, `package.json` keybindings & menus.
- Effort: **M**.

#### T2-11: Explorer/editor menu parity (Add to VCS, Annotate, Rollback, Compare with Revision, Compare with Repo Version, Apply Patch)
- Scope: Add missing entries to `explorer/context > intellig.explorerSubmenu` and `editor/context > intellig.editorSubmenu` per CF "Right-click menus" missing-items list.
- Files: `package.json`, new command handlers in `extension.ts`.
- Effort: **M**.

#### T2-12: Incoming commits badge
- Scope: Status-bar indicator showing `↑N ↓M` after fetch; click opens Git tool window → Incoming tab (T1-05).
- Files: `services/StatusBarService.ts`, hook post-fetch in `GitService`.
- Effort: **S**.

### Tier 3 — Polish / nice-to-have

#### T3-01: Favorites branches
- Scope: Star UI + persistence in `ConfigurationService`. Depends on T1-10.
- Effort: **S**.

#### T3-02: Merge dialog (no-ff / squash / no-commit / message)
- Scope: Webview replacing inline merge. Low urgency since `mergeBranch` works.
- Effort: **S**.

#### T3-03: New Branch dialog (tracking toggle, overwrite toggle, checkout toggle)
- Scope: Replace `showInputBox` in branch creation paths with a webview.
- Effort: **S**.

#### T3-04: `Apply all non-conflicting changes from Left/Right`
- Scope: Two additional merge-view toolbar buttons beyond the existing all-current / all-incoming.
- Files: `services/MergeView.ts`.
- Effort: **S**.

#### T3-05: Rebase `--skip`
- Scope: Add command to continue rebase past a conflicting commit.
- Effort: **S**. Risk: documented commit loss.

#### T3-06: Jump-to-hash / branch / tag picker (Ctrl+F in log)
- Scope: QuickPick over commits/branches/tags that scrolls the Log to the selection.
- Effort: **S**.

#### T3-07: Highlight already-cherry-picked commits
- Scope: Log decoration using `git cherry` or `--cherry-mark`.
- Effort: **M**.

#### T3-08: Push all tags / `--follow-tags`
- Scope: Push-dialog checkbox (T1-01 extension) + standalone command.
- Effort: **S**.

#### T3-09: External hosting / issue tracker links
- Scope: Parse remote URL, surface `Open on GitHub` / `Open on GitLab` in commit and blame menus. Detect issue refs in messages.
- Effort: **M**.

#### T3-10: Combined Stash+Shelf tab
- Scope: Cosmetic — fold Stash into Shelf tab with a toggle.
- Effort: **S**.

#### T3-11: Branch auto-group by `/`, Recent branches
- Scope: Part of T1-10 scope; promoted here as Tier 3 if implemented minimally in T1-10.
- Effort: covered.

#### T3-12: `fetch.tags` auto-sync config
- Scope: Config key + `--tags` flag wiring on auto-fetch.
- Effort: **S**.

#### T3-13: Keybinding parity (Ctrl+Shift+H silent shelve, Ctrl+Shift+U unshelve, Ctrl+Alt+U silent unshelve, F4, F6, Ctrl+F in log)
- Scope: Add bindings gated on `useIntelliJKeymap`.
- Files: `package.json` keybindings, `services/KeymapService.ts`.
- Effort: **S**.

---

## 3. Recommended implementation order

1. **T1-03 (Fetch + auto-fetch)** — smallest Tier-1, unblocks Incoming badge (T2-12) and makes the existing `autoFetchEnabled` config honest. No destructive paths.
2. **T1-09 (New Tag + tag-menu)** — S effort, closes a glaring hole where `intellig.tag.*` commands exist but have no menu entry. Unblocks T1-07 (`New Tag…` in log menu).
3. **T1-11 (Reset dialog)** — S effort; correctness + data-loss guard; unblocks matching IntelliJ label `Reset Current Branch to Here…` for T1-07.
4. **T2-01 (Show Diff with Working Tree directory-URI fix)** — S effort; closes lingering BUG-17. No dependency.
5. **T1-02 (Pull dialog)** — M effort; sits in the Remote-ops cluster; enables T2-02.
6. **T1-01 (Push dialog)** — L; paired with T1-02 in the same cluster (GitService.push flags are already plumbed). Requires confident force-with-lease UX; land tests first.
7. **T1-08 (Auto-open merge view + Resolve Conflicts dialog)** — M; critical UX fix that every conflict-producing operation above benefits from (merge, rebase, pull, cherry-pick, revert, unshelve).
8. **T1-07 (Log commit menu parity)** — M; most visible IntelliJ-parity win. Depends on T1-09 (for `New Tag…`) and T1-11 (for `Reset…` label).
9. **T1-10 (Branches popup redesign)** — M; high-visibility UX parity once Tag/Push/Pull flows are in.
10. **T1-06 (Changelist UI + context menu)** — L; self-contained; necessary for any "Commit a changelist" / "Shelve a changelist" work. **Do BEFORE T1-04** so the Commit tool window can host it.
11. **T1-04 (Commit tool window)** — L; depends on T1-06 for Local Changes tab content and T2-06 for message history + gear.
12. **T1-05 (Git tool window tabs)** — L; depends on Console streaming (already done) and benefits from T2-07 (File history panel).
13. **T1-12 (Apply Patch + Create Patch from Local)** — M; depends on T1-06 (assign-to-changelist target).
14. **Tier 2 cluster** — T2-02 → T2-03 → T2-08 → T2-09 → T2-10 → T2-11 → T2-12 → T2-07 → T2-04 → T2-05 → T2-06 (roughly ordered by dependency chains above).
15. **Tier 3 polish** — in any order; save pure UX sugar (T3-02, T3-03, T3-04, T3-06, T3-09, T3-10, T3-13) until the structural work lands.

Rationale summary: (a) quick low-risk wins (T1-03, T1-09, T1-11, T2-01) restore honesty & close holes before structural work. (b) Remote-ops cluster (T1-01 + T1-02 + T1-03) is a natural batch touching `GitService.push/pull/fetch` + new dialog infra. (c) T1-08 must land before confident promotion of merge/rebase/pull dialogs. (d) Tool-window work (T1-04 + T1-05 + T1-06) is the highest-LOC chunk — sequence after the smaller dialogs so contributors aren't blocked. (e) Changelist UI (T1-06) is a hard dependency for commit-one-changelist and patch-to-changelist, so it comes before T1-04 & T1-12.

---

## 4. Cross-cutting concerns

**Testing strategy.**
- **Unit (mocha):** every new dialog's option→flag mapping (Push / Pull / Merge / Reset / New Tag / Apply Patch). Extend the pattern in `src/test/unit/commandCmdBranchPopup.fixes.test.ts` (typed private accessor).
- **Property (fast-check):** any menu-dispatch logic (new commit-context items, new changelist menu, new tag-tree menu) — extend pattern in `src/test/property/commitContextMenuDispatch.property.test.ts`.
- **Integration (VS Code Extension Host):** only the tool-window refactors (T1-04, T1-05) and auto-fetch scheduler (T1-03) need full activation tests — the rest can be unit/property.
- **BUGS.md regressions to guard:** BUG-02 merge resolution, BUG-04 separator, BUG-11 stash timestamps, BUG-12 rebase drag — keep existing 291 fix tests green on every PR.

**Data-loss safety gates.**
- `T1-01` Push dialog: default Force-with-lease, never bare `--force`. Blocked on protected-branch list (config-driven).
- `T1-11` Reset dialog: confirm-modal for `Hard` and `Keep`.
- `T2-04` Drop selected changes: confirm-modal with "cannot be undone".
- `T2-09` stash drop, `T2-10` shelf delete: already guarded by stash/shelf semantics (recoverable) — soft confirm only.
- `T3-05` Rebase `--skip`: confirm-modal with commit preview before skip.

**Multi-repo behavior.**
- Every Tier-1 dialog must accept a repository parameter (not assume `repositories[0]`). T2-03 tightens all remaining single-repo paths.
- Push / Pull / Update-Project dialogs render a repo table (IR Push dialog layout) — follow IntelliJ's synchronous all-roots pattern with per-root check-marks.
- Branches popup and Log ops already respect a repo selector; extend the pattern to all new dialogs.

**Backwards compatibility.**
- No command IDs renamed (existing user keybindings preserved). New commands added under the same `intellig.*` namespace.
- `intellig.push`/`pull`/`fetch` behavior changes from "Coming Soon" toast to functional — this is an improvement, not a regression.
- `intellig.branch.compareWithCurrent` existing `Ctrl+D` IntelliJ-keymap binding is preserved.
- `CommitContextMenuCommands` log-menu labels will shift (e.g. `Copy hash` → `Copy Revision Number`); the underlying command ID (`copyHash`) stays to not break user-customized keybindings.
- Config: no existing keys deleted; only additions (new: `intellig.defaultRepo`, `intellig.protectedBranches`, `intellig.fetchTags`).

---

## 5. Out of scope (explicit)

Per the user's scope decision, the following are NOT flagged as gaps even where IntelliJ offers them:
- **Submodules** (add, update, remove)
- **GPG / SSH commit signing** configuration & verification UI
- **Git flow** integration (the IntelliJ plugin feature)
- **PR integration** (GitHub / GitLab PR creation, review comments, check status)
- **Advanced filter DSL** in the log (structured query language); basic filters in T1-05 tabs are in scope, but not a DSL.
- **Malicious-dependency detection** commit check (mentioned "uncertain" in IR)
- **External upload-after-commit** to FTP/server
- **Code-analysis / TODO / inspection commit checks** (the non-git pre-commit features) — listed in IR but are VCS-adjacent IntelliJ IDE features, not core Git parity.

---

## 6. Open questions for the user

**None.** The scope decision (core parity + UI + right-click menus, excluding submodules/GPG/Git-flow/PR/DSL) is explicit, the bug baseline (`BUGS.md`) is clean (all fixed), and every Tier-1 item has defensible sourcing in `INTELLIJ_REFERENCE.md`. Proceed to design-approval for Tier 1.
