# IntelliG ↔ IntelliJ git4idea parity — NORTHSTAR

_Forward-looking parity plan: **what's left**, by component, with files + ordered work. North-star =
IntelliJ `git4idea` + `platform/vcs-impl` (clone at `~/Documents/workspace/intellij-community`). Scope:
**pure Git plugin parity**; GitHub/GitLab/PR integration excluded. Weight: a git op that silently does
the **wrong thing** > security hole > missing daily feature > visual polish. Last updated 2026-06-18._

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
commit-graph log, 3-way merge all built. **Remaining work is fidelity, not invention.** Reset and
interactive-rebase plumbing already *exceed* git4idea.

Remaining backlog is now thin: **G** complete; **A / B / C / D / E / F / H** all effectively complete
(~90-97%) — the last daily-feature gaps (A's rollback dialog, F-8b line-status hover popup) have landed.
The remaining parity work is **UI/UX layout** fidelity (section 4b — menu order/grouping, labels, icons,
dialogs) plus the R2 re-audit pass against the merged tree.

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
| 3-way Merge view (B) | 🟢 ~92% | near-complete (native editor + auto-flip + accept-non-conflicting landed) |
| Commit & Changelists (A) | 🟢 ~90% | near-complete (commit-and-push + live line-status gutter + hover popup + rollback dialog landed) |
| Rebase / Cherry-pick / Revert (H) | 🟢 ~93% | near-complete (inline reword/squash + `--onto`/`--root` + `-m` revert/cherry-pick + accept-non-conflicting landed) |
| Log & Commit Graph (G) | ✅ 100% | DONE — G1-G9 all merged (ref filters, cherry-compare, GPG, fixup links, incoming tab, push-up-to, multi-root, go-to-parent/child) |
| Branches & Tags (D) | 🟢 ~97% | near-complete (HEAD/favorites/validation/multi-repo/worktree/per-remote-push/tag-merge/align-local landed) |
| Shell / Menus / Sync (C) | 🟢 ~95% | near-complete (`--autostash` + console + scm provider + log-menu history-rewrite guard + tabbed default-on landed) |
| Shelf / Stash / Patches (E) | 🟢 ~95% | near-complete (unshelve + patch split + diff-against-local + binary + recycle bin + apply-index + apply-patch tree + target-changelist landed) |
| Blame / History / Diff (F) | 🟢 ~95% | near-complete (AUTHOR color + aspects + affected paths + line-scoped history + details-pane/commit-graph + diff ignore-policy + get-version + inline-diff-hover landed) |

---

## 4. Cross-cutting remaining work

**Correctness / security (highest weight — do first):** _cluster cleared — staging hunk-patch
quoting + revert-hunk stale-index guard (5e6855a) and the any-scheme `sanitizeGitError` credential
scrub (bafee52) all landed; see STATUS. Remaining backlog is daily-feature workstreams below._

**Medium / polish:** UI/UX layout parity (menu order/grouping, labels, ellipsis, icons, tool-window
tabs, dialogs) — tracked as its own goal in **section 4b** (detail in `R2-UX-03-menus.md`).

**Process:** F5 dogfood sweep for unit-locked-but-unconfirmed UI; re-run the R2 review against the
merged tree (it predates the A/C/phase-0 merges). Evidence: `R2-0N-*.md`, `R2-UX-0N-*.md`.

**Code-health (Batch C — from the 2026-06-18 dead-code sweep, REFRAMED):** the sweep's "dead command"
premise was largely false — it grepped production-only and missed the e2e suite, so the ~19
`intellig.commit.*` commands (+ `branches.refresh`) it flagged are actually e2e-tested and mostly sole
implementations. No deletions made. The real output flips to a **parity gap**: ~9 implemented + e2e-tested
commit ops (new branch/tag from commit, show diff, compare with revision, show file in revision, open on
host, apply selected/files, cherry-pick-without-commit, …) exist as commands but have NO live UI entry —
their only menu was the never-rendering logCommit menu. Audit git4idea `Git.Log.ContextMenu` and surface
the appropriate ones in the webview overlay (`htmlBuilders.ts` + `_handleAction`); this subsumes/expands
gap #10. Genuinely-dead-only TS cleanup (e.g. the `utils/index.ts` barrel) is a separate low-priority,
item-by-item-proven pass. Detail: `workspace-notes/batch2-plan.md` (Batch C). Also: `blame.clearHiddenRevisions`
needs a submenu entry (parity fix, not deletion).

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

**Surface heatmap:**

| Surface | Parity | Biggest remaining gap |
|---|---|---|
| Log / commit menu | 🟡 ~80% | by-subject Fixup/Squash-into-commit (#10 remainder) |
| Branch popup (QuickPick) | 🟡 ~65% | action set + Rename/Delete-last reorder (#4); tracked-branch submenu (#5) |
| Branch tree menu | 🟢 ~90% | — (near-complete) |
| Tool-window tabs | 🟢 ~85% | Stash / Working-Trees tabs (deferred) |
| Explorer / editor submenu | 🟢 ~80% | "Commit File" handler (#6) |
| Command-palette titles | 🟢 ~90% | — (de-prefix + ellipsis landed) |
| Toolbar / view-title | 🟢 ~85% | — (fetch icon + branch widget landed) |
| Major dialogs | 🟢 ~85% | per-dialog field-level audit (deferred) |

**Open gaps** (ref = git4idea XML group / Java class):

| # | Surface | Gap | IntelliJ ref | IntelliG site | Size |
|---|---|---|---|---|---|
| 4 | Branch popup | QuickPick: Rename/Delete should be LAST; missing Diff-with-Local, Update-Selected, Pull-into-current, New-Worktree, Push-Tags | `Git.Branch.Backend` | `BranchPopup.ts ~721-792` | M |
| 5 | Branch popup | Tracked-branch submenu missing (set-upstream / edit-tracked sub-popup; or QuickPick cascade) | `Git.Branch.Tracked` | absent | M |
| 6 | Explorer submenu | Add "Commit File" (CheckinFiles) at the head of the submenu — needs a single-file commit handler (the History-trails / Annotate-with-diff reorder + "Compare with Branch…" rename landed) | `Git.FileActions` (`CheckinFiles`) | pkg.json `explorerSubmenu` | S/M |
| 10 | Log menu | Add by-subject Fixup-into-Commit / Squash-into-Commit (target a SELECTED commit, distinct from the existing with-previous items). NOTE: New-Branch/New-Tag-from-commit landed (3853540) | `Git.Fixup.To.Commit` / `Git.Squash.Into.Commit` | `htmlBuilders.ts` + `_handleAction` | S/M |
| — | Branch | Pull-into-current (rebase/merge) on LOCAL tracked branches, not just remote | `GitPullBranchAction$WithRebase/$WithMerge` | pkg.json `4_pull` (remoteBranch only) | S/M |
| — | Tool window | Consider Stash tab + Working-Trees tab; make Incoming/Update-Info transient | `git.enable.stash.toolwindow`, `Git.Show.WorkingTrees` | `tabRouter.ts:25` | M |
| — | Dialogs | Field-level checkbox/label/order audit per dialog (rebase/merge/push/pull/reset/new-branch/rollback) | per-dialog git4idea classes | `src/rebase`,`src/sync`,… | M |

**Order:** the pkg.json-only quick wins (#8, #9, #6-partial) have landed; #2 resolved (the "native tree
menu" never existed — its 19 orphaned `view/item/context` entries were deleted, webview overlay is the one
true commit menu); #3 landed (reword-item ellipsis); #10 half-landed (New-Branch/New-Tag-from-commit in
the webview menu — also resolves the orphaned-command parity gap). Next: #10 remainder (by-subject
Fixup/Squash-into-commit), the #6 "Commit File" handler, branch popup (#4, #5). Stash/Working-Trees tabs +
per-dialog field audit are deferred.

**Landed (in STATUS):** log-menu reset-to-head reorder (webview) + palette ellipsis pass on
dialog-opening titles (`64c5a20`); reset-dialog destructive confirm verified present
(`ResetDialog._confirmDestructive`). **Batch 1 (`39113f5`):** palette de-prefix (#8 — rebase/blame titles
to git4idea self-describing text), Fetch distinct icon + branch widget to navigation@1 (#9), explorer
submenu reordered to `Git.FileActions` (Annotate→compare cluster→History trails) + "Compare with Branch…"
rename (#6-partial). **#2 (`ea292f8`):** removed 19 dead `intellig.logCommit` `view/item/context` entries
(no provider ever emitted that contextValue) + added a manifest↔source coherence guard.

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
**Remaining:** none tracked — workstream B is effectively complete.
**Files:** `src/conflicts/{MergeView,ResolveConflictsDialog,ConflictResolutionService}.ts`.

### C (residuals). Shell / Menus / Sync — 🟡 ~75%
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
**Remaining:** none tracked — workstream C is effectively complete.
**Files:** `package.json`, `src/ui-shell/{KeymapService,ConsoleService}.ts`, `src/sync/PullDialog.ts`,
`src/git-core/gitToolWindow/tabs/*`.

### D. Branches & Tags — 🟢 ~97%
**Remaining:** popup header actions + settings toggles + `FilteringTree`; tree HEAD root node +
favorites + multi-repo grouping + search/multi-select; `getMergedBranches` has no UI caller; no
worktree create/open; conflict-aware branch-name validation; per-remote push; tag submenu
Merge-into-Current.
**Work (ordered):** (1) ~~popup header+toggles~~ **DONE 2026-06-17**; align local submenu still pending.
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
**Remaining:** no per-file/partial unshelve; no per-file shelve from changelist; no "diff with local
changes" (static patch text only); **no binary support**; no deleted-shelf recycle bin; imported
multi-file patch collapses to one entry; Apply Patch whole-patch only; stash apply always `--index`
(no reinstate toggle).
**Work (ordered):** (1) ~~per-file unshelve~~ **DONE 2026-06-17** (files[] subset apply, remaining stay
shelved; "Unshelve Files…" picker). (2) ~~parse imported patches per-file~~ **DONE 2026-06-17**
(`splitPatchByFile` on `diff --git` boundaries → one shelf file per change). (3) ~~diff-against-local~~
**DONE 2026-06-17** (reconstruct shelved version + real `vscode.diff` vs working tree). (4) ~~binary~~
**DONE 2026-06-18** (`git diff --numstat` detect → capture raw bytes base64, byte-for-byte round-trip,
add/modified/deleted, restore via `fs`; mirrors `ShelvedBinaryFile`). (5) ~~recycle bin~~
**DONE 2026-06-18** (`deletedAt` marker → Recently-Deleted; restore / delete-permanently;
unshelve-cleanup still purges; mirrors `ShelveChangesManager.markChangeListAsDeleted`/`restoreList`).
(6) ~~target-changelist routing~~ **DONE 2026-06-18** (optional `targetChangelist` →
`moveToChangelist` on cleanly-applied files; mirrors `ShelveChangesManager.unshelveChangeList`).
(7) ~~per-file Apply Patch tree~~ **DONE 2026-06-18** (`filterPatchByFiles` reassembles the selected
verbatim blocks; mirrors `ApplyPatchDifferentiatedDialog`). (8) ~~stash apply-index toggle~~
**DONE 2026-06-18** (`reinstateIndex` gates `--index` on apply/pop; mirrors `GitUnstashDialog`).
**Files:** `src/shelf/{ShelfService,ShelfView,StashView}.ts`, `src/patches/{ApplyPatchDialog,PatchService}.ts`,
`src/git-core/ops/StashTagHistoryOps.ts`.

### F. Blame / History / Diff — 🟢 ~92%
**Remaining:** toggleable aspect columns / author-name-format; "show affected paths";
inline-diff-on-hover; file
history has no graph / details pane / get-version, and line-history isn't line-scoped (fetches whole
file); diff has no whitespace/highlight-policy UI.
**Work (ordered):** (1) ~~AUTHOR color mode + selector~~ **DONE 2026-06-17** (stable per-author tint,
faithful IntelliJ palette port; `intellig.blame.colorMode` ORDER/AUTHOR). (2) ~~aspect columns + name
format~~ **DONE 2026-06-17** (Author/Date/Revision show-hide toggles + author-name format
full/firstname/lastname/initials/email; `LineAnnotationAspect`/`ShortNameType` port). (3) affected-paths
**DONE 2026-06-17** (changed-files pane per selected revision via `getCommitDiff`). (4) ~~details pane +
graph (reuse `commitGraph.ts`)~~ **DONE 2026-06-18** (details pane: message/author+email/dates/full hash
+ copy/parents, committer line only when ≠ author; mini commit-graph column reusing `commitGraph.ts`;
single HTML-escape boundary). (5) ~~line-scoped history~~ **DONE 2026-06-17** (`git
log -L` op + HistoryTab wiring). ~~get-version~~ **DONE 2026-06-18** (`DiffOps.getFileAtRevision` →
`git show <rev>:<path>` behind `--end-of-options`, opens read-only). (6) ~~diff options~~ **DONE 2026-06-18**
(`intellig.diff.ignorePolicy` → git whitespace flags at all diff sites; mirrors `IgnorePolicy`).
(7) inline-diff-on-hover.
**Files:** `src/blame/*`, `src/git-core/gitToolWindow/tabs/HistoryTab.ts` + `html/historyHtml.ts`,
`src/commands/registration/blameEditorCommands.ts`, `package.json`.

### G. Log & Commit Graph — ✅ 100% COMPLETE
**All 9 items merged:** (1) ref-aware branch+author dropdowns. (2) match-mode toggles (regex/case).
(3) range/parent/simplify-merges filters. (4) manual cherry-compare. (5) GPG signature column.
(6) fixup!/squash! message links. (7) Incoming tab + push-up-to-commit. (8) merged multi-root log.
(9) go-to-parent/child nav (Right/Left keys + context menu).

### H. Rebase / Cherry-pick / Revert — 🟢 ~93%
**Remaining:** no inline reword/squash message editing; `--onto <newbase>`/`--root` not surfaced;
revert `--no-edit` only (no `-m` mainline, no multi-commit); cherry-pick no `-m`/`--edit` for merge
commits.
**Work (ordered):** (1) ~~inline reword/squash box~~ **DONE 2026-06-18** (`hasSquashOverride` mirrors the
reword guard — blank message never writes an empty `-F`; squash applies via `fixup` + `exec git commit
--amend -F`). (2) ~~surface `--onto`/`--root`~~ **DONE 2026-06-18** (`rebase [--root] [--onto <newbase>]
--end-of-options [<upstream>]`, refs validated, root↔upstream exclusive). (3) ~~revert/cherry-pick
`-m` + edit-message~~ **DONE 2026-06-18** (`-m <mainline>` only for merge commits, validated int,
hash behind `--end-of-options`). (4) ~~"accept non-conflicting from both sides"~~ **DONE 2026-06-18**
(shared with B — `git merge-file -p` over the index stages).
**Files:** `src/rebase/{RebaseEditor,RebaseDialog}.ts`, `src/git-core/{rebaseTodo,RebaseService}.ts`,
`src/git-core/ops/CherryPickRevertOps.ts`, `package.json`.
**Fragility:** interactive rebase spawns the Electron binary as node (`ELECTRON_RUN_AS_NODE=1`) — worth a fallback.

---

## 6. Execution order

1. **Unwired front-doors batch** (section 4) — cheap command+menu wiring over tested backends.
2. **Remaining workstreams**, parallelizable on disjoint dirs: **G** (ref-aware filters), **E**
   (per-file unshelve), **H** (inline reword, `--onto`), **C residuals** (`--autostash`, log-menu
   rewrite), plus the **B / D / F** residuals (section 5).
3. **F5 dogfood sweep** for unit-locked-but-unconfirmed UI items.
4. **Re-run the R2 review** against the merged tree.

**Effort remaining:** ~1.5–2.5 engineer-years to faithful pure-Git parity. Everything outside the
(now-native) merge view is parallelizable polish on already-working surfaces.

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
