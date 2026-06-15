# IntelliG ↔ IntelliJ git4idea parity — NORTHSTAR

_The single high-level parity reference. Merges the original audit, the R1/R2 syntheses, and
the UX review into one current picture. North-star = IntelliJ `git4idea` + `platform/vcs-impl`
(full clone at `~/Documents/workspace/intellij-community`). Scope: **pure Git plugin parity**;
GitHub/GitLab/PR integration explicitly excluded. Parity weight: a git op that silently does the
**wrong thing** > security hole > missing daily feature > visual polish. Last updated 2026-06-15._

> Living status (what's landed, progress log, next step) lives in **[`STATUS.md`](./STATUS.md)**.
> Per-area review evidence with file:line refs: the `R2-0N-*.md` and `R2-UX-0N-*.md` reports.

---

## 1. Headline

The hard architecture is already built. The conceptually difficult IntelliJ features VS Code
lacks natively — changelists, shelf-as-patch-store, interactive-rebase editor, commit-graph log,
3-way merge — all exist in IntelliG. **Remaining work is fidelity, not invention.** Two areas
(Reset; interactive-rebase todo plumbing) already *exceed* git4idea.

As of 2026-06-15 the Phase-0 foundations and workstreams **A** (commit/changelists) and **C**
(shell/menus/sync) have landed, plus the full R1 correctness pass. The remaining backlog is
workstreams **B, D, E, F, G, H**, one real security fix, and a tier of cheap "computed-but-not-
rendered" UX wins.

---

## 2. Maturity heatmap

| Component | Parity | Status | Biggest remaining gap |
|---|---|---|---|
| Reset | 🟢 ~95% (exceeds ref) | — | — |
| Rebase / Cherry-pick / Revert (plumbing) | 🟢 ~80% | — | inline reword/squash msg, `--onto`/`--root`, `-m` revert |
| Merge / rebase dialogs / paused-rebase | 🟢 ~85% | — | inline reword |
| Log & Commit Graph | 🟢 ~75% | — | ref-aware filters, manual cherry-compare, GPG col |
| **Commit & Changelists (A)** | 🟢 ~80% ↑ | **#44 landed** | live line-status tracker, commit-and-push dialog, rollback dialog |
| **Shell / Menus / Sync (C)** | 🟡 ~70% ↑ | **#43 landed** | `--autostash`, log-menu history-rewrite, console surface |
| Shelf / Stash / Patches (E) | 🟡 ~70% | — | per-file unshelve, binary, recycle bin |
| Branches & Tags (D) | 🟡 ~65% | — | tree HEAD/favorites, annotated-tag dialog, worktrees |
| Blame / History / Diff (F) | 🟡 ~55% | — | background heatmap, file-history graph + affected paths |
| **3-way Merge view (B)** | 🔴 ~35% | decided: native editor | adopt VS Code merge editor |

---

## 3. Locked decisions

- **3-way merge view (B) → adopt VS Code's native merge editor** (`git.openMergeEditor`). Collapses
  workstream B from months to weeks; removes the only major reimplementation risk. Soft dependency
  on the built-in Git extension accepted; the webview survives as a fallback.
- **`package.json` `contributes` is the only shared file across workstreams** — additive-only edits,
  no reordering, to keep parallel work conflict-free.

---

## 4. Landed (do not re-open)

- **Phase-0 foundations** (`267d718`): `IncomingOutgoingOps` (`git rev-list --count @{u}...HEAD`),
  `isActive` on `IChangelist`, `KeymapService` de-drift from `package.json`.
- **Workstream A — Commit & Changelists** (#44): changelist-driven commit, before-commit check
  framework, Add-to-VCS wiring fix, Local Changes grouping + Unversioned Files node, diff-preview
  pane, commit tool window default-on, AA/DD unmerged detection.
- **Workstream C — Shell / Menus / Sync** (#43): keymap conflict fixes, actionable status-bar
  branch popup, `view/title` header toolbar, Incoming tab data+handlers, Update Project dialog
  (`GitUpdateOptionsDialog`/`GitUpdateProcess` parity), structured push/update notifications.
- **Crash fix** (#42): cap git output capture at 64 MiB → stops the extension-host `RangeError`
  on multi-GB repos.
- **R1 correctness pass** — all 9 P1 silent-wrong git ops + ~14 P2/P3 slices (stash `--index`,
  delete-vs-modify→`git rm`, push divergence + force-with-lease, rebase-todo preservation, log
  path-filter, merge-parent diff, smart reset, undo-keeps-message, rebase options, remote
  set-url/rename, cherry-pick `-x`, tag force, reset/rebase-option persistence, Copy Commit
  Message, deleteRemoteTag).

> Residual line-items under A and C (e.g. `--autostash`, log-menu history-rewrite, live
> line-status tracker) are **not** yet done — see the component sections. Verify residuals against
> the merged tree before claiming any of them closed.

---

## 5. Cross-cutting findings (R2 review, lead-verified)

Severities were verified from source — **3 of 5 agent-flagged "blockers" were overstated/refuted**
(credential-leak in fetch toasts, "delete-remote dead handler", systemic argv-injection all
refuted; "Merge from… unwired" downgraded to a missing front-door). Trust this list, not raw
agent severities. Evidence: `R2-05-sync.md`, `R2-02-branches.md`, `R2-04-conflicts.md`.

**🔴 Must-fix (verified real, still open — not addressed by any landed track):**
- **`RemoteOps.fetch` argv-injection** (`src/git-core/ops/RemoteOps.ts:100-104`). `fetch` pushes
  the remote name positionally with no `--end-of-options`/leading-dash guard, unlike `pull`/`push`
  (which use `buildGitArgs`). Reachable via a hostile `.git/config` remote name, hit by the
  auto-fetch loop. Fix: route through `buildGitArgs('fetch', flags, [remote])`; add a CI grep gate
  so a positional ref in an ops file fails. **S effort.**

**🟠 High — cheap, high payoff (unwired backends + computed-but-not-rendered):**
- Front-doors missing a command/menu over already-tested backends: Annotate-Previous-Revision,
  top-level "Merge from…" command, tag delete-remote, blame gutter click-through, no-merges filter.
- UX render bugs: branch-focus highlight computed but never applied (`graphClusterBuilder.ts`);
  log column headers never emitted though resize JS exists; command-palette label cleanup
  (redundant `Git:` prefix, missing `…` on dialog-openers).

**🟡 Medium / ⚪ polish:** hunk patch path-escaping (`StagingOps.generateHunkPatch` — unquoted path
breaks `git apply` on odd filenames); SCP-style credential regex gap in `sanitizeGitError`; menu
order/grouping vs git4idea action XML; reset-dialog F5 confirmation outstanding.

**P4 platform rebuilds:** log filter render + ref-aware dropdowns, 3-way merge editor (native),
blame gutter interactivity + background heatmap, file-history graph panel.

> ⚠️ The R2 review predates the A/C/phase-0 merges. Re-run it against the merged tree and confirm
> the fetch fix + UX render fixes there.

---

## 6. Remaining workstreams (component audits)

Each lists current gaps + ordered work + files. Workstreams A and C are in section 4; only their
residuals remain. Reference: `git4idea` (portable git logic) vs `platform` (UI we hand-build).

### B. 3-way Merge view — 🔴 ~35% → native editor
Custom **read-only** webview (`MergeView.ts`): three side-by-side `<pre>` columns, no diff
alignment/syntax/editable result/synced scroll; `git show :1:/:2:/:3:` fetched but never rendered;
"both" order hardcoded current-then-incoming; manual edit falls back to current.
**Work:** route conflicts to `git.openMergeEditor` in `ConflictResolutionService.ts` + `MergeView.show`;
keep `markResolved`→`git add`; gut webview rendering; `intellig.merge.*` become thin wrappers.
**Files:** `src/conflicts/MergeView.ts`, `ConflictResolutionService.ts`, `package.json`.

### C (residuals). Shell / Menus / Sync
Landed: keymap, status-bar popup, view/title toolbar, Incoming tab, Update Project dialog,
notifications. **Remaining:** Pull `--autostash`; log-menu history-rewrite parity
(reword/fixup/squash-into/uncommit/push-up-to-here, `Git.PushUpToCommit`); restore Console surface
(`ConsoleService.showConsole` is a no-op); enable tabbed layout default-on; no `vscode.scm` provider.
**Files:** `package.json`, `src/ui-shell/{KeymapService,ConsoleService}.ts`, `src/sync/PullDialog.ts`,
`src/git-core/gitToolWindow/tabs/*`.

### D. Branches & Tags — 🟡 ~65%
Sectioned popup + branch tree + injection-hardened ops exist. **Gaps:** no incoming/outgoing arrows
(now that 0a `IncomingOutgoingOps` exists, wire them); popup header actions + settings toggles +
`FilteringTree`; tree HEAD root node + favorites + multi-repo grouping + search/multi-select; **no
annotated-tag dialog** (two plain input boxes vs `GitTagDialog`); `deleteRemoteTag`/`getMergedBranches`
ops have **no UI caller**; no worktree create/open; conflict-aware branch-name validation.
**Work (ordered):** (1) i/o arrows (uses 0a). (2) popup header+toggles+align local submenu.
(3) tree HEAD+favorites+multi-repo. (4) New Tag dialog. (5) wire remote-tag-delete + per-remote push.
(6) conflict-aware validation. (7) worktrees. (8) tag submenu Merge-into-Current.
**Files:** `src/branches/*`, `src/git-core/ops/{BranchOps,StashTagHistoryOps}.ts`,
`src/commands/registration/commitHelpers.ts`, `package.json`.

### E. Shelf / Stash / Patches — 🟡 ~70%
Shelf correctly modeled as git-independent patch store; shelve/unshelve/patch flows present.
**Gaps:** no per-file/partial unshelve; no per-file shelve from changelist; no "diff with local
changes" (static patch text only); **no binary support**; no deleted-shelf recycle bin; imported
multi-file patch collapses to one entry; Apply Patch whole-patch only; stash apply always `--index`
(no reinstate toggle).
**Work (ordered):** (1) per-file unshelve. (2) parse imported patches per-file. (3) diff-against-local.
(4) binary. (5) recycle bin. (6) target-changelist routing. (7) per-file Apply Patch tree. (8) stash
apply-index toggle.
**Files:** `src/shelf/{ShelfService,ShelfView,StashView}.ts`, `src/patches/{ApplyPatchDialog,PatchService}.ts`,
`src/git-core/ops/StashTagHistoryOps.ts`.

### F. Blame / History / Diff — 🟡 ~55%
Blame service + inline/gutter providers + file-history tab present. **Gaps:** gutter heatmap is a
fake foreground-alpha fade, not IntelliJ's interpolated background gradient; `blameAnnotationStyle`
enum has no `off` and nothing consumes it; no toggleable aspect columns / author-name-format; no
"show affected paths"; no inline-diff-on-hover; file history has no graph / details pane / get-version,
and line-history isn't line-scoped (fetches whole file); diff has no whitespace/highlight-policy UI.
**Work (ordered):** (1) background heatmap + ORDER/AUTHOR modes. (2) wire `blameAnnotationStyle` + `off`.
(3) aspect columns + name format. (4) affected-paths + history panel. (5) details pane + graph (reuse
`commitGraph.ts`). (6) line-scoped history (`git log -L`) + get-version. (7) diff options. (8) inline-diff-on-hover.
**Files:** `src/blame/*`, `src/git-core/gitToolWindow/tabs/HistoryTab.ts` + `html/historyHtml.ts`,
`src/commands/registration/blameEditorCommands.ts`, `package.json`.

### G. Log & Commit Graph — 🟢 ~75%
Per-row SVG graph (IntelliJ-matching geometry), lane algorithm, ref badges, details panel, filter
bar, jump-to-hash, cherry-pick highlight, ~20-action context menu, multi-select. **Gaps:** branch/
author filters are free-text not ref-aware dropdowns; no regex/case toggles, no parent/first-parent/
range/simplify-merges filters; cherry-pick highlight is upstream-only/always-on (no manual "compare
with branch X"); no GPG signature column; no fixup!/squash! message links; no merged multi-root log;
no incoming/outgoing or push-up-to-commit; no go-to-parent/child nav. Plus the R2 UX render bugs
(section 5: branch-focus highlight not applied, no column headers, no keyboard nav).
**Work (ordered):** (1) ref-aware branch+author dropdowns. (2) match-mode toggles. (3) range/parent/
simplify filters. (4) manual cherry-compare. (5) GPG col. (6) fixup!/squash! links. (7) wire Incoming
tab + push-up-to-commit. (8) merged multi-root log. (9) UX render fixes (section 5). (10) go-to-parent/child.
**Files:** `src/git-core/gitToolWindow/{GitToolWindowProvider,provider/*,tabs/IncomingTab}.ts`,
`src/git-core/GitService.ts`, `src/registration/registerViews.ts`, `package.json`.

### H. Rebase / Cherry-pick / Revert — 🟢 ~80%
Interactive rebase editor (real-todo `GIT_SEQUENCE_EDITOR` shim, preserves label/reset/merge/exec/
update-ref), rebase dialog (`--rebase-merges`/`--update-refs`/`--keep-empty`/`--autosquash` + guards),
paused-rebase recovery, merge dialog near-complete, Reset exceeds git4idea, cherry-pick `--no-commit`/`-x`.
**Gaps:** no inline reword/squash message editing; `--onto <newbase>`/`--root` not surfaced; revert
`--no-edit` only (no `-m` mainline, no multi-commit); cherry-pick no `-m`/`--edit` for merge commits.
**Work (ordered):** (1) inline reword/squash box. (2) surface `--onto`/`--root`. (3) revert/cherry-pick
`-m` + edit-message. (4) "accept non-conflicting from both sides" (shared with B).
**Files:** `src/rebase/{RebaseEditor,RebaseDialog}.ts`, `src/git-core/{rebaseTodo,RebaseService}.ts`,
`src/git-core/ops/CherryPickRevertOps.ts`, `package.json`.
**Fragility:** interactive rebase spawns the Electron binary as node (`ELECTRON_RUN_AS_NODE=1`) — worth a fallback.

---

## 7. Execution order (current)

1. **🔴 `RemoteOps.fetch` argv-injection** + CI grep gate (section 5). Security, S, do first.
2. **UX quick wins** — branch-focus highlight, log column headers, command-palette label cleanup. Hours, big perceived-quality jump.
3. **Unwired front-doors batch** — command+menu over tested backends (annotate-prev, Merge-from, tag delete-remote, blame click-through, no-merges filter).
4. **Remaining workstreams**, parallelizable on disjoint dirs: **B** (native merge editor — highest single win), **D** (branches: wire i/o arrows, tag dialog), **G** (ref-aware filters), **F** (blame heatmap + history graph), **E** (per-file unshelve), **H** (inline reword, `--onto`), **C residuals** (`--autostash`, log-menu rewrite).
5. **F5 dogfood sweep** for unit-locked-but-unconfirmed UI items.
6. **Re-run the R2 review** against the merged tree.

**Effort remaining:** ~1.5–2.5 engineer-years to faithful pure-Git parity (down from ~3 once the
merge view is native). Everything outside B is parallelizable polish on already-working surfaces.
