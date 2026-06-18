# IntelliG ↔ IntelliJ git4idea parity — NORTHSTAR

_Forward-looking parity plan: **what's left**, by component, with files + ordered work. North-star =
IntelliJ `git4idea` + `platform/vcs-impl` (clone at `~/Documents/workspace/intellij-community`). Scope:
**pure Git plugin parity**; GitHub/GitLab/PR integration excluded. Weight: a git op that silently does
the **wrong thing** > security hole > missing daily feature > visual polish. Last updated 2026-06-16._

> What's landed (progress log, SHAs, pending-merge branches) lives in **[`STATUS.md`](./STATUS.md)**.
> This doc lists only remaining work; done items are removed once they land in STATUS.

---

## 1. Headline

The hard architecture exists — changelists, shelf-as-patch-store, interactive-rebase editor,
commit-graph log, 3-way merge all built. **Remaining work is fidelity, not invention.** Reset and
interactive-rebase plumbing already *exceed* git4idea.

Remaining backlog: residuals under **C** (shell/sync) and the open workstreams **E** (shelf),
**H** (rebase), plus residual gaps under the now-mostly-done **B / D / F**. **G (log) is complete** — G1-G9 all merged.

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
| 3-way Merge view (B) | 🟢 ~85% | only "accept non-conflicting from both sides" (shared w/ H) left — auto-flip landed |
| Commit & Changelists (A) | 🟢 ~80% | live line-status tracker, commit-and-push dialog, rollback dialog |
| Rebase / Cherry-pick / Revert (H) | 🟢 ~80% | inline reword/squash, `--onto`/`--root`, `-m` revert/cherry-pick |
| Log & Commit Graph (G) | ✅ 100% | DONE — G1-G9 all merged (ref filters, cherry-compare, GPG, fixup links, incoming tab, push-up-to, multi-root, go-to-parent/child) |
| Branches & Tags (D) | 🟡 ~75% | tree HEAD/favorites/multi-repo, worktrees, conflict-aware validation |
| Shell / Menus / Sync (C) | 🟡 ~70% | `--autostash`, log-menu history-rewrite, console surface |
| Shelf / Stash / Patches (E) | 🟡 ~70% | per-file unshelve, binary, recycle bin |
| Blame / History / Diff (F) | 🟡 ~70% | file-history graph + affected paths (AUTHOR color mode landed) |

---

## 4. Cross-cutting remaining work

**Correctness / security (highest weight — do first):** _cluster cleared — staging hunk-patch
quoting + revert-hunk stale-index guard (5e6855a) and the any-scheme `sanitizeGitError` credential
scrub (bafee52) all landed; see STATUS. Remaining backlog is daily-feature workstreams below._

**Medium / polish:** menu order/grouping vs git4idea action XML (R2-UX-03 findings #1–3: Reset to top of
log menu, Integrate↔Sync separator, tracked-branch submenu); command-palette title pass (drop redundant
`Git:` prefix on remaining commands, ellipsis audit); reset-dialog F5 confirmation.

**Process:** F5 dogfood sweep for unit-locked-but-unconfirmed UI; re-run the R2 review against the
merged tree (it predates the A/C/phase-0 merges). Evidence: `R2-0N-*.md`, `R2-UX-0N-*.md`.

---

## 5. Remaining workstreams (component audits)

Each lists remaining gaps + ordered work + files. Reference: `git4idea` (portable git logic) vs
`platform` (UI we hand-build).

### B. 3-way Merge view — 🟢 ~85%
**Landed 2026-06-17:** resolved-row auto-flip — `ConflictResolutionService` reconciles the open
`ResolveConflictsDialog` against the unmerged set on the existing git-index watch (no new watcher),
flipping externally-resolved rows and enabling Continue.
**Remaining:** "Accept non-conflicting from both sides" (shared with H).
**Files:** `src/conflicts/{MergeView,ResolveConflictsDialog}.ts`.

### C (residuals). Shell / Menus / Sync — 🟡 ~70%
**Remaining:** Pull `--autostash`; log-menu history-rewrite parity (reword/fixup/squash-into/uncommit/
push-up-to-here, `Git.PushUpToCommit`); restore Console surface (`ConsoleService.showConsole` is a
no-op); enable tabbed layout default-on; no `vscode.scm` provider.
**Files:** `package.json`, `src/ui-shell/{KeymapService,ConsoleService}.ts`, `src/sync/PullDialog.ts`,
`src/git-core/gitToolWindow/tabs/*`.

### D. Branches & Tags — 🟡 ~75%
**Remaining:** popup header actions + settings toggles + `FilteringTree`; tree HEAD root node +
favorites + multi-repo grouping + search/multi-select; `getMergedBranches` has no UI caller; no
worktree create/open; conflict-aware branch-name validation; per-remote push; tag submenu
Merge-into-Current.
**Work (ordered):** (1) ~~popup header+toggles~~ **DONE 2026-06-17** (New Branch/Fetch/Settings-gear +
Group-by-Directory/Show-Recent/Show-Tags toggles); align local submenu still pending. (2) tree
HEAD+favorites+multi-repo. (3) conflict-aware validation. (4) per-remote push. (5) worktrees.
(6) tag submenu Merge-into-Current.
**Files:** `src/branches/*`, `src/git-core/ops/{BranchOps,StashTagHistoryOps}.ts`,
`src/commands/registration/commitHelpers.ts`, `package.json`.

### E. Shelf / Stash / Patches — 🟡 ~70%
**Remaining:** no per-file/partial unshelve; no per-file shelve from changelist; no "diff with local
changes" (static patch text only); **no binary support**; no deleted-shelf recycle bin; imported
multi-file patch collapses to one entry; Apply Patch whole-patch only; stash apply always `--index`
(no reinstate toggle).
**Work (ordered):** (1) per-file unshelve. (2) parse imported patches per-file. (3) diff-against-local.
(4) binary. (5) recycle bin. (6) target-changelist routing. (7) per-file Apply Patch tree. (8) stash
apply-index toggle.
**Files:** `src/shelf/{ShelfService,ShelfView,StashView}.ts`, `src/patches/{ApplyPatchDialog,PatchService}.ts`,
`src/git-core/ops/StashTagHistoryOps.ts`.

### F. Blame / History / Diff — 🟡 ~65%
**Remaining:** toggleable aspect columns / author-name-format; "show affected paths";
inline-diff-on-hover; file
history has no graph / details pane / get-version, and line-history isn't line-scoped (fetches whole
file); diff has no whitespace/highlight-policy UI.
**Work (ordered):** (1) ~~AUTHOR color mode + selector~~ **DONE 2026-06-17** (stable per-author tint,
faithful IntelliJ palette port; `intellig.blame.colorMode` ORDER/AUTHOR). (2) aspect columns + name format. (3) affected-paths
+ history panel. (4) details pane + graph (reuse `commitGraph.ts`). (5) line-scoped history
(`git log -L`) + get-version. (6) diff options. (7) inline-diff-on-hover.
**Files:** `src/blame/*`, `src/git-core/gitToolWindow/tabs/HistoryTab.ts` + `html/historyHtml.ts`,
`src/commands/registration/blameEditorCommands.ts`, `package.json`.

### G. Log & Commit Graph — ✅ 100% COMPLETE
**All 9 items merged:** (1) ref-aware branch+author dropdowns. (2) match-mode toggles (regex/case).
(3) range/parent/simplify-merges filters. (4) manual cherry-compare. (5) GPG signature column.
(6) fixup!/squash! message links. (7) Incoming tab + push-up-to-commit. (8) merged multi-root log.
(9) go-to-parent/child nav (Right/Left keys + context menu).

### H. Rebase / Cherry-pick / Revert — 🟢 ~80%
**Remaining:** no inline reword/squash message editing; `--onto <newbase>`/`--root` not surfaced;
revert `--no-edit` only (no `-m` mainline, no multi-commit); cherry-pick no `-m`/`--edit` for merge
commits.
**Work (ordered):** (1) inline reword/squash box. (2) surface `--onto`/`--root`. (3) revert/cherry-pick
`-m` + edit-message. (4) "accept non-conflicting from both sides" (shared with B).
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
