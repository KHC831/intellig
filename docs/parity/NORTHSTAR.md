# IntelliG ↔ IntelliJ git4idea parity — NORTHSTAR

_Forward-looking parity plan: **what's left**, by component, with files + ordered work. North-star =
IntelliJ `git4idea` + `platform/vcs-impl` (clone at `~/Documents/workspace/intellij-community`). Scope:
**pure Git plugin parity**; GitHub/GitLab/PR integration excluded. Weight: a git op that silently does
the **wrong thing** > security hole > missing daily feature > visual polish. Last updated 2026-06-21._

> **Open feature gaps surfaced by the 2026-06-21 source-grounded re-audit** (tracked in sections 4b/5
> below): **Configure Remotes UI** (backend built + unit-locked in `RemoteOps`, but no command/menu/dialog;
> ref `Git.Configure.Remotes`); **worktree lifecycle** (`WorktreeOps` = `list`+`add` only — no
> remove/prune/refresh; ref `Git.WorkingTrees.Remove/Prune/Refresh`); **`Git.RevertResolved`** (un-resolve a
> conflicted file). Minor still-absent ops: Unshallow, Open-Exclude-File, Add-Commit-To-Remote-Branch (all
> low-frequency).

> What's landed (progress log, SHAs, pending-merge branches) lives in **[`STATUS.md`](./STATUS.md)**.
> UI/UX **layout** parity (menu order/grouping, labels, ellipsis, icons, tool-window tabs, dialogs)
> is a first-class goal, tracked in **section 4b** below; the detailed per-menu findings live in
> **[`R2-UX-03-menus.md`](./R2-UX-03-menus.md)** (+ `R2-UX-01/02/04` for log/dialogs/editors).
> This doc lists only remaining work; done items are removed once they land in STATUS.
>
> **Doc map** (3 classes — that's all there is): **plan** = this file (what's left) · **log** =
> `STATUS.md` (what landed) · **reference** = everything else (`R2-*` deep audits + the durable
> per-surface contract specs). Every reference file carries a `> **NORTHSTAR tie-back:**` header
> naming its workstream; the full file→workstream map is **section 7** below.

---

## 1. Headline

The hard architecture exists — changelists, shelf-as-patch-store, interactive-rebase editor,
commit-graph log, 3-way merge all built. **Remaining work is mostly fidelity, not invention.** The
2026-06-21 source-grounded re-audit found a handful of genuine *feature* gaps (not fidelity): the
Configure-Remotes front door (backend done, UI missing), worktree remove/prune teardown, `Git.RevertResolved`
(un-resolve a file), the rejected-push strategy dialog (partial), and the 3 unported before-commit checks
(CRLF / large-file / bad-filename). Everything else is polish. Reset and interactive-rebase plumbing already
*exceed* git4idea.

**Functional/backend** parity is high: **G** ~98%; **A / B / C / D / E / F / H** all effectively complete
(~90-98%) on feature coverage. **But visual/layout fidelity is a separate, lower axis** — section 4b's
*numbered feature gaps* (#2–#10) landed, yet the surfaces do **not** visually match IntelliJ: the merge editor
is VS Code's native one (not IntelliJ's Swing 3-pane), the blame gutter is a single inline decoration (not a
multi-column gutter), the log panel is webview flex-rows (not a JTable), and the major dialogs use a QuickPick
wizard / read-only-ref paradigm (not IntelliJ's modal forms). Some of these are **accepted platform
substitutions** (Swing → VS Code can't be pixel-matched); others (dialog paradigm, gutter render, menu
ordering) are real visual-parity gaps. Tracked honestly in section 4b + `R2-UX-01/02/03/04`. The F5 dogfood
sweep for visual confirmation remains open.

## 2. Standing constraints

- **3-way merge = VS Code's native editor** (`git.openMergeEditor`). The custom webview was removed;
  `MergeView` is a thin adapter. Don't reintroduce a hand-rolled merge UI.
- **`package.json` `contributes` is the only shared file across workstreams** — additive-only edits,
  no reordering, to keep parallel work conflict-free.

---

## 3. Maturity heatmap (remaining gap)

| Component | Parity | Biggest remaining gap |
|---|---|---|
| Reset | 🟢 ~95% | — (exceeds ref) |
| 3-way Merge view (B) | 🟢 ~92% | native editor + auto-flip + accept-non-conflicting landed; only `RevertResolved` (un-resolve) + conflict-type labels remain |
| Commit & Changelists (A) | 🟢 ~90% | 3 unported before-commit checks (CRLF / large-file / bad-filename) + `commit.template` prefill remain; else near-complete |
| Rebase / Cherry-pick / Revert (H) | 🟢 ~93% | ops complete; residuals: Action.Other "edit as text" fallback (🟠 stacked-branch), interactive-editor richness (P4), `fixup -C/-c` (polish) |
| Log & Commit Graph (G) | ✅ ~98% | G1-G9 features all merged (filters, highlighting, headers, GPG, incoming, multi-root, nav); only UI polish left (branch-union picker, user dropdown, file context menu, Ctrl+F) |
| Branches & Tags (D) | 🟢 ~95% | worktree teardown (remove/prune/refresh) unbuilt — create+open only; else near-complete |
| Shell / Menus / Sync (C) | 🟢 ~93% | Configure-Remotes UI missing (backend done); else near-complete (`--autostash`/console/scm/tabbed all landed) |
| Shelf / Stash / Patches (E) | 🟢 ~95% | residuals: stash apply-time `--index` UI toggle, file-subset stash, stash per-file changes browser; shelf/patches complete |
| Blame / History / Diff (F) | 🟢 ~95% | blame complete; residuals are file-history-panel P4 polish (single-rev show-diff, sortable columns/tree-as-graph) |

---

## 4. Cross-cutting remaining work

**Correctness / security (highest weight — do first):** _cluster cleared — staging hunk-patch
quoting + revert-hunk stale-index guard (5e6855a) and the any-scheme `sanitizeGitError` credential
scrub (bafee52) all landed; see STATUS. Remaining backlog is daily-feature workstreams below._

**Medium / polish:** UI/UX layout parity (menu order/grouping, labels, ellipsis, icons, tool-window
tabs, dialogs) — tracked as its own goal in **section 4b** (detail in `R2-UX-03-menus.md`).

**Process:** F5 dogfood sweep for unit-locked-but-unconfirmed UI remains. (The R2 re-audit against the
merged tree was completed in Batch 10 — see STATUS — so it's no longer pending.)

**Code-health (Batch C — from the 2026-06-18 dead-code sweep, REFRAMED + CLOSED):** the sweep's "dead
command" premise was false (it grepped production-only, missed the e2e suite) — the `intellig.commit.*`
commands are e2e-tested, not dead. New-Branch/New-Tag + Fixup/Squash-into were the genuine UI-orphan gaps
and got surfaced in the webview menu (#10). The **remaining "surface ~9 orphaned ops" action is CLOSED as
none-required**: the parity-audit verified the webview menu (`htmlBuilders.ts:220-251`) already mirrors
git4idea `Git.Log.ContextMenu` + platform `Vcs.Log.ContextMenu` line-by-line — the other orphaned commands
(show-diff/compare/show-file-in-revision/apply-selected/apply-files/cherry-pick-no-commit; open-on-host is
GitHub-excluded) are NOT git4idea commit-menu items, so surfacing them would be over-parity; they stay
palette-reachable. Still open: `blame.clearHiddenRevisions` may need a `blameOptionsSubmenu` entry (parity
fix); a genuinely-dead-only TS cleanup (e.g. the verified-dead `utils/index.ts` barrel) is a separate
low-priority, item-by-item-proven pass. Detail: `workspace-notes/batch2-plan.md`.

**Deferred backlog (non-blocking):**
- _a11y (cross-cutting):_ chip `aria-haspopup="menu"` when chip-as-button interactivity lands (NOT
  `aria-pressed` — chips open menus, they aren't toggles); left/right arrow-key navigation across chips
  within a commit row (mirrors IntelliJ's branches-popup nav); per-feature manual high-contrast sweep
  (`Default High Contrast` ± Light) — automation covers the theme-var contract, not contrast ratios.
- _edge-state UI:_ merge-in-progress branch-chip rendering on the not-yet-committed merge (no SHA) +
  "New Branch From Here" start-point selection during a paused merge; empty-repo log-graph / branches-
  popup polish (currently blank — visually fine). _(Paused-rebase Continue/Skip/Abort + conflict
  Continue/Abort are already landed — H/B workstreams — so they're dropped from this list.)_

---

## 4b. UI/UX layout parity (remaining)

_Layout fidelity — menu order/grouping, labels, ellipsis, icons, tool-window tabs, dialog structure —
is a parity goal in its own right, not just feature coverage. Authoritative ref = git4idea action XML
`~/Documents/workspace/intellij-community/plugins/git4idea/backend/resources/intellij.vcs.git.backend.xml`
(+ `GitBranchPopupActions.java`). Detailed findings + reorder recipes: `R2-UX-03-menus.md`._

> **Two different things — don't conflate them.** (1) **Structural/menu parity** — do the right actions
> exist, grouped/labelled/ordered like git4idea's XML. This is high (~85-90%, below). (2) **Visual rendering
> fidelity** — does the surface *look* like IntelliJ. This is inherently a **standing partial** because the
> platform differs: IntelliJ is Swing (JTable log, multi-column blame gutter, 3-pane Swing merge viewer,
> modal form dialogs); we are VS Code (webview flex-rows, single inline-decoration gutter, the **native**
> merge editor, QuickPick/webview dialogs). Many of these are **accepted non-matches**, not gaps to "close" —
> a webview cannot be made to look like Swing. They are tracked honestly (not stamped "✅ parity") in
> `R2-UX-01-log.md` (log panel) and `R2-UX-04-editors-panels.md` (merge editor, blame gutter, file-history
> panel). The percentages below are **structural** parity; visual fidelity is lower and platform-bounded.

**Surface heatmap (structural/menu parity):**

| Surface | Structural parity | Visual note |
|---|---|---|
| Log / commit menu | 🟢 ~90% | item set mirrors `Git.Log.ContextMenu`; ordering/grouping differs slightly (VS Code menus sort by group-string, no separator API) |
| Branch popup (QuickPick) | 🟢 ~85% | QuickPick sectioned menu, **not** IntelliJ's tree-grouped Swing popup — visual paradigm differs |
| Branch tree menu | 🟢 ~90% | VS Code TreeView (single-select, no separators) vs Swing tree |
| Tool-window tabs | 🟢 ~85% | Stash / Working-Trees tabs deferred |
| Explorer / editor submenu | 🟢 ~90% | reordered to `Git.FileActions` |
| Command-palette titles | 🟢 ~90% | de-prefix + ellipsis landed |
| Toolbar / view-title | 🟢 ~85% | fetch icon + branch widget landed |
| Major dialogs | 🟡 ~70% | **paradigm differs** — Pull is a 2-step QuickPick wizard (not a modal form); Reset/Merge show the clicked ref read-only (IntelliJ lets you edit it); push commit-preview pane missing. Per-dialog field audit deferred. See `R2-UX-02-dialogs.md` |
| Blame gutter | 🟡 ~60% | options complete, but single inline-string render vs IntelliJ multi-column + text-tint vs bg-gradient. See `R2-UX-04` |
| 3-way merge editor | n/a | intentional native-editor substitution — functional, **not** an IntelliJ visual match (accepted). See `R2-UX-04` |
| Log panel layout | 🟡 ~75% | webview flex-rows vs JTable; details panel right vs IntelliJ bottom. See `R2-UX-01` |

**Numbered feature gaps #2–#10:** landed (item coverage). **Visual/layout fidelity** is the standing partial
above + the deferred backlog below.

| # | Surface | Gap | IntelliJ ref | IntelliG site | Size |
|---|---|---|---|---|---|
| R1 | Remotes | **Configure Remotes UI** — no command/menu/dialog to add/rename/remove/set-url a remote. Backend `RemoteOps.{addRemote,removeRemote,setRemoteUrl,renameRemote}` is built + unit-locked (`GitService.test` `#P2 Configure Remotes`); only the front door is missing. | `Git.Configure.Remotes` / `GitConfigureRemotesDialog` | `RemoteOps.ts:347-413` (no caller) | S/M |
| R2 | Worktree | **Remove / Prune / Refresh** worktrees — `WorktreeOps` has `list`+`add` only; no teardown. Create+open already landed. | `Git.WorkingTrees.Remove/Prune/Refresh` | `WorktreeOps.ts:170,199` | S |
| — | Branch | Pull-into-current (rebase/merge) on LOCAL tracked branches, not just remote | `GitPullBranchAction$WithRebase/$WithMerge` | pkg.json `4_pull` (remoteBranch only) | S/M |
| — | Branch popup | New-Worktree-from-branch + Push-Tags items in the QuickPick (both reachable elsewhere) | `GitBranchPopupActions` | `BranchPopup.ts` | S |
| — | Tool window | Consider Stash tab + Working-Trees tab; make Incoming/Update-Info transient | `git.enable.stash.toolwindow`, `Git.Show.WorkingTrees` | `tabRouter.ts:25` | M |
| — | Dialogs | Field-level checkbox/label/order audit per dialog (rebase/merge/push/pull/reset/new-branch/rollback) | per-dialog git4idea classes | `src/rebase`,`src/sync`,… | M |

**Order:** the pkg.json-only quick wins (#8, #9, #6-partial) have landed; #2 resolved (the "native tree
menu" never existed — its 19 orphaned `view/item/context` entries were deleted, webview overlay is the one
true commit menu); #3 landed (reword-item ellipsis); **#10 complete** (New-Branch/New-Tag-from-commit +
Fixup…/Squash Into… in the webview menu — the log/commit menu now mirrors `Git.Log.ContextMenu`; also
resolved the orphaned-command parity gap); **#6 complete** ("Commit File…" via the SCM API per ADR-014);
**#4 reorder landed** (Rename/Delete last in the branch popup); **#5 complete** ("Set Upstream…" in the
branch popup). **All numbered section-4b gaps (#2–#10) are now landed.** Remaining is the explicitly-
deferred backlog only: branch-popup New-Worktree/Push-Tags, Pull-into-current on local branches,
Stash/Working-Trees tabs, and the per-dialog field-level audit.

**Landed (in STATUS):** log-menu reset-to-head reorder (webview) + palette ellipsis pass on
dialog-opening titles (`64c5a20`); reset-dialog destructive confirm verified present
(`ResetDialog._confirmDestructive`). **Batch 1 (`39113f5`):** palette de-prefix (#8 — rebase/blame titles
to git4idea self-describing text), Fetch distinct icon + branch widget to navigation@1 (#9), explorer
submenu reordered to `Git.FileActions` (Annotate→compare cluster→History trails) + "Compare with Branch…"
rename (#6-partial). **#2 (`ea292f8`):** removed 19 dead `intellig.logCommit` `view/item/context` entries
(no provider ever emitted that contextValue) + added a manifest↔source coherence guard. **#3 (`b7a16ee`):**
reword-item ellipsis. **#10 (`3853540`, `47b363b`):** New Branch / New Tag from commit + Fixup… / Squash
Into… in the webview log menu — the log/commit menu now mirrors `Git.Log.ContextMenu`. **#6 (`8cad885`):**
"Commit File…" at the head of the explorer submenu via the SCM API (ADR-014) — stages the file + reveals
the SCM commit input; wired `acceptInputCommand` (commit-on-accept). **#4 (`4729103`):** branch-popup
Rename/Delete moved last (git4idea `Git.Branch.Backend` order). **#5 (`285117e`):** "Set Upstream…" in the
branch popup — nested QuickPick of remote refs → reuses `setBranchUpstream`.

---

## 5. Remaining workstreams (component audits)

Each lists remaining gaps + ordered work + files. Reference: `git4idea` (portable git logic) vs
`platform` (UI we hand-build).

### B. 3-way Merge view — 🟢 ~92%
**Landed 2026-06-17:** resolved-row auto-flip — `ConflictResolutionService` reconciles the open
`ResolveConflictsDialog` against the unmerged set on the existing git-index watch (no new watcher),
flipping externally-resolved rows and enabling Continue.
**Landed 2026-06-18:** "Accept non-conflicting from both sides" — reads the index merge stages
(`:1:/:2:/:3:`) and delegates the 3-way merge to `git merge-file -p` (auto-applies one-sided hunks,
re-emits markers for two-sided), staging only when fully merged; mirrors `ApplyNonConflictsAction`.
**Remaining:** **`Git.RevertResolved`** — no in-product affordance to send a resolved/staged file back to
conflicted (`git checkout --merge -- <file>`) to redo a mis-resolution; git4idea exposes it in the merge
menus. S effort (op + command + Conflicts-list entry). Plus a P3 polish item: conflict-type labels
(DU/UD/AA) aren't shown in the file list (the resolution layer already distinguishes them for correct
`git rm` routing — only the label is missing).
**Files:** `src/conflicts/{MergeView,ResolveConflictsDialog,ConflictResolutionService}.ts`.

### C (residuals). Shell / Menus / Sync — 🟢 ~95%
**Landed 2026-06-17:** Pull `--autostash` (dialog checkbox + op flag + autostash-pop conflict routing);
Console surface (lazy "IntelliG Git Console" OutputChannel fed by the GitCli command feed; `showConsole`
+ `intellig.showGitConsole` reveal it).
**Landed (cont.):** native `vscode.scm` SourceControl provider (Staged/Changes groups from git status,
click-to-diff).
**Landed 2026-06-18:** log-menu history-rewrite parity verified complete — reword, push-up-to-here
(`Git.PushUpToCommit`, `<sha>:refs/heads/<branch>`), squash/fixup/uncommit all wired in
`CommitContextMenuCommands`; added the missing safety: a modal fail-closed warning before rewording an
already-pushed commit, covering both the HEAD-amend and non-HEAD-rebase paths (mirrors
`GitCommitEditingActionBase.checkCommitsCanBeEdited`).
**Landed 2026-06-18:** tabbed Git tool-window layout default-on (`intellig.useTabbedGitToolWindow`
false→true; provider already honored the flag per render).
**Remaining:**
- **Configure Remotes UI** — backend ops (`RemoteOps.{addRemote,removeRemote,setRemoteUrl,renameRemote}`,
  `:347-413`) built, argv-guarded, unit-locked (`#P2 Configure Remotes`), but no command/menu/dialog reaches
  them; git4idea exposes `Git.Configure.Remotes` (`GitConfigureRemotesDialog`). Wire a QuickPick/webview front
  door → existing ops. S/M.
- **Rejected-push strategy dialog** — on a non-ff push rejection git4idea loops push → modal (Merge/Rebase) →
  update → retry (max 10). Ours offers a per-row "Pull and Retry" button that opens the Pull dialog but
  doesn't auto-push or loop, with no Merge/Rebase modal (`PushDialog.ts:873-894`). 🟠 high, M.
- **Unshallow** (`Git.Unshallow` → `git fetch --unshallow`) — not surfaced. ⚪ polish, shallow-clone only.

(Detail: `R2-05-sync.md`, `R2-09-shell.md`.)
**Files:** `package.json`, `src/ui-shell/{KeymapService,ConsoleService}.ts`, `src/sync/PullDialog.ts`,
`src/git-core/gitToolWindow/tabs/*`.

### D. Branches & Tags — 🟢 ~97%
**Remaining (verified residuals only):** tree `FilteringTree` / search-as-you-type (partly covered by VS
Code's native TreeView filtering; the branch *popup* already has it via QuickPick `matchOnDescription/Detail`);
branch-tree multi-select (`canSelectMany`); **worktree teardown** — `WorktreeOps` (`:170,199`) implements
`list`+`add` only, so Remove / Prune / Refresh (ref `Git.WorkingTrees.Remove/Prune/Refresh`) are unbuilt
(create+open landed). Everything else below has landed. Branch-cleanup (merged-branch deletion) is intentionally not implemented — git4idea's
`Git.Cleanup.Branches` action is `internal="true"`, so it is not a user-facing parity requirement; the
orphaned backend was removed.
**Work (ordered):** (1) ~~popup header+toggles~~ **DONE 2026-06-17**.
(2) ~~tree HEAD+favorites~~ **DONE 2026-06-17** (HEAD root node + Memento-persisted favorites + star
icon) + ~~multi-repo grouping~~ **DONE 2026-06-17** (per-repository root nodes when >1 repo). (3)
~~conflict-aware validation~~ **DONE 2026-06-17** (`check-ref-format` validator + local/current/remote/
directory conflict detection + overwrite bypass). (4) ~~per-remote push~~ **DONE 2026-06-18**
(`_chooseTargetRemote` QuickPick when >1 remote, default = tracked/origin/first, sets upstream on
remote change; mirrors `GitPushTarget.getRemoteToPush`). (5) ~~worktrees~~
**DONE 2026-06-18** (`WorktreeOps` create via `git worktree add [-b] -- <path> <ref>` + open via
`--porcelain` parse → `vscode.openFolder`; injection-safe argv with a real-git round-trip test). (6)
~~tag submenu Merge-into-Current~~ **DONE 2026-06-18** (routes the tag through the existing merge
surface; mirrors `GitBranchPopupActions.TagActions`). (7) ~~align-local "Update Selected" submenu~~
**DONE 2026-06-18** (FF-only `<remoteRef>:<localRef>` fetch without checkout, skips diverged/checked-out;
mirrors `GitBranchPopupActions` update-selected).
**Files:** `src/branches/*`, `src/git-core/ops/{BranchOps,StashTagHistoryOps}.ts`,
`src/commands/registration/commitHelpers.ts`, `package.json`.

### E. Shelf / Stash / Patches — 🟢 ~95%
Per-file/partial unshelve, per-file imported-patch split, diff-against-local, binary support, deleted-shelf
recycle bin, target-changelist routing, per-file Apply-Patch tree, and stash `reinstateIndex` (backend) all
landed. Patches: apply (`git am`/`git apply`) + create-from-local + `--reverse` all present.
**Remaining (verified residuals):**
- **Stash apply-time `--index` UI toggle** — the `reinstateIndex` backend param exists (default true) but no
  apply-time UI affordance to disable it (`StashView.applyStash:286`). 🟡 medium.
- **Stash per-file changes browser** — StashView does whole-stash apply/pop/drop/branch-from only; no per-file
  view with Show-Diff-with-Local / Apply-Selected-Changes (`Git.Stash.ChangesBrowser.ContextMenu`). The shelf
  already has per-file granularity; the stash doesn't. ⚪ polish.
- **File-subset stash** (`stash push -- <paths>`) and **shelf "restore to changelist" picker** — both still
  whole-tree / active-changelist only. 🟡 medium / ⚪ polish.
**Files:** `src/shelf/{ShelfService,ShelfView,StashView}.ts`, `src/patches/{ApplyPatchDialog,PatchService}.ts`,
`src/git-core/ops/StashTagHistoryOps.ts`.

### F. Blame / History / Diff — 🟢 ~95%
Blame is feature-complete: AUTHOR/ORDER color modes, aspect columns + name formats, affected-paths pane,
details pane + mini-graph, annotate-previous-revision (wired), hide-revision, detect-movements (-M/-C),
ignore-whitespace, interactive gutter/inline hover (View-Commit / Previous-Revision links), options
persisted via Memento. History: line-scoped (`log -L`), `--follow` + `--full-history --simplify-merges`,
get-version (read-only), diff ignore-policy. Argv-secure (buildGitArgs).
**Remaining (P4 polish):**
- **File-history single-rev "Show Diff"** (commit vs parent) — HistoryTab has compare-two + compare-with-local
  but no one-click rev-vs-parent (`resolveDiffParent` exists to reuse). 🟡 medium, S.
- **File-history panel richness** — sortable columns / tree-as-graph / speed-search / copy (Platform rebuild). 🟡 P4.
- Blame hunk-header origLine (line-level previous-rev nav) + cache-invalidation on HEAD change — ⚪ polish.
**Files:** `src/blame/*`, `src/git-core/gitToolWindow/tabs/HistoryTab.ts` + `html/historyHtml.ts`,
`src/commands/registration/blameEditorCommands.ts`, `package.json`.

### G. Log & Commit Graph — ✅ ~98% (core complete)
**All 9 feature items merged:** (1) ref-aware branch+author dropdowns. (2) match-mode toggles (regex/case).
(3) range/parent/simplify-merges filters. (4) manual cherry-compare. (5) GPG signature column.
(6) fixup!/squash! message links. (7) Incoming tab + push-up-to-commit. (8) merged multi-root log.
(9) go-to-parent/child nav (Right/Left keys + context menu). Column headers, focused-branch highlighting,
and cherry-mark badges all render.
**Remaining (UI polish only):** branch filter as a multi-select *union* picker (single-ref + range cover most
cases); known-committers user dropdown; file-row context menu in the details panel; Up/Down row-stepping
keyboard nav; in-page Ctrl+F search; log-filter persistence across sessions; `Git.AddCommitToRemoteBranch`
(niche). None are correctness gaps. (Detail: `R2-01-log.md`, `R2-UX-01-log.md`.)

### H. Rebase / Cherry-pick / Revert — 🟢 ~93%
Inline reword/squash message editing, `--onto`/`--root` (RebaseDialog:124), revert/cherry-pick `-m <mainline>`
for merge commits (CherryPickRevertOps:80/253, validated), and accept-non-conflicting (shared with B) all
landed. Rebase continue/skip/abort + options (`--rebase-merges`/`--keep-empty`/`--update-refs`/`--autosquash`)
+ in-progress guard + options-persistence all present.
**Remaining:**
- **Unstructured "Edit as text" fallback for Action.Other lines** — when a todo carries label/reset/merge/exec
  (`--rebase-merges` / `rebase.updateRefs`), git4idea drops to a raw text editor for hand-editing; we always
  show the commit-list UI and preserve those lines silently (`RebaseService` keeps them but can't hand-edit).
  🟠 high for stacked-branch users (dormant otherwise). M effort.
- **Interactive editor richness** — commit detail pane + inline diff preview + P/R/E/S/F/D keyboard mnemonics
  (RebaseEditor has dropdown + drag only). 🟡 P4 polish.
- **`fixup -C`/`-c`** parameter recognition (git 2.38+) — ⚪ polish. **`--no-ff`** rebase — ⚪ near-zero demand.
**Files:** `src/rebase/{RebaseEditor,RebaseDialog}.ts`, `src/git-core/{rebaseTodo,RebaseService}.ts`,
`src/git-core/ops/CherryPickRevertOps.ts`, `package.json`.
**Fragility:** interactive rebase spawns the Electron binary as node (`ELECTRON_RUN_AS_NODE=1`) — worth a fallback.

---

## 6. Execution order

1. **Unwired front-doors batch** (section 4) — cheap command+menu wiring over tested backends.
2. **Remaining workstreams**, parallelizable on disjoint dirs: **G** (ref-aware filters), **E**
   (per-file unshelve), **H** (inline reword, `--onto`), **C residuals** (`--autostash`, log-menu
   rewrite), plus the **B / D / F** residuals (section 5).
3. **F5 dogfood sweep** for unit-locked-but-unconfirmed UI items. (The R2 re-audit against the merged
   tree is done — Batch 10.)

**Effort remaining:** weeks of polish, not engineer-years — all workstreams are ~90-97% (G complete; B/C
effectively complete), with only a handful of low-tier residuals left (the section-5 D residuals, the
deferred a11y + edge-state backlog, per-dialog field-level fidelity, and the F5 dogfood sweep). Nothing in
the wrong-git-behavior or security tiers is open. The earlier "engineer-years" figure predated the
2026-06-17/18 landings and is retired.

---

## 7. Reference docs index

Every file in `docs/parity/` ties back to a workstream here. Two reference roles: **audit** =
point-in-time Round-2 deep review (`R2-*`); **spec** = durable, test-pinned per-surface behavior
contract (ADR-010 Layer-3). Each file repeats its mapping in a `> **NORTHSTAR tie-back:**` header.

| Workstream / area (this doc) | Round-2 audit | Durable contract spec |
|---|---|---|
| **A** — Commit & Changelists (section 5.A-equiv) | `R2-06-localchanges`, `R2-08-commitops` | folded into appendices: Local-Changes panel + Changed-files tree = `R2-06`; Before-commit checks = `R2-08` |
| **B** — 3-way Merge (section 5.B) | `R2-04-conflicts` | — (UX in `R2-UX-04`) |
| **C** — Shell / Menus / Sync (section 5.C) | `R2-05-sync`, `R2-09-shell` | Update-Project + Incoming-tab specs = `R2-05` appendices |
| **D** — Branches & Tags (section 5.D) | `R2-02-branches` | — (UX in `R2-UX-04`) |
| **E** — Shelf / Stash / Patches (section 5.E) | `R2-06-localchanges` | — |
| **F** — Blame / History / Diff (section 5.F) | `R2-07-history` | history-row layout = `R2-06` appendix; UX in `R2-UX-04` |
| **G** — Log & Commit Graph (section 5.G) | `R2-01-log`, `R2-UX-01-log` | — |
| **H** — Rebase / Cherry-pick / Revert (section 5.H) | `R2-03-rebase` | — |
| **UI/UX layout** (section 4b) | `R2-UX-02-dialogs`, `R2-UX-03-menus` | — |

The behavior contracts are enforced by the property + snapshot tests (and ADR-013 for the commit-graph
data model), not by prose docs.

_Removed in the 2026-06-18 consolidation: `UX-PARITY.md` (→ section 4b + `R2-UX-03`);
`update-project.md` / `incoming-tab.md` (→ `R2-05` appendices); `commit-tool-window-changes.md` +
`changed-files-tree.md` (→ `R2-06` appendices); `before-commit-checks.md` (→ `R2-08` appendix);
`accessibility.md` / `git-log-graph.md` / `repo-states.md` (Wave-jargon reference narration — contracts
live in the tests/ADR-013/code they pointed to); `_TEMPLATE.md` / `workstream-assignment-template.md`
(dead scaffolding)._
