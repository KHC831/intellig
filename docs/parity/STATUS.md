# IntelliJ-parity — status & landing log

_Living tracker: current state, what's landed, and the next step. The analysis/plan (gaps,
heatmap, execution order) lives in **[`NORTHSTAR.md`](./NORTHSTAR.md)**. Updated 2026-06-17._

## Current state

- `main` carries the R1 correctness pass + Phase-0 foundations + workstreams **A**, **C**, **B**,
  **D**, **F**, plus the fetch argv-injection fix + UX label cleanup.
- Merged via PR on 2026-06-15: **#42** (crash fix) → **#43** (workstream C) → **#44** (workstream A)
  → **#45** (fetch argv fix + UX label cleanup + build fix) → **#46** (workstream B, native merge
  editor) → **#47** (workstream D, branches/tags) → **#48** (workstream F, blame heatmap).
- **Correctness/security cluster cleared** (staging quoting + revert-hunk guard 5e6855a, any-scheme
  credential scrub bafee52). **Next:** daily-feature workstreams **G/E/H** + **C residuals** —
  see `NORTHSTAR.md` section 6.
- **Both residual follow-ups landed 2026-06-17**: B's resolved-row auto-flip (index-watcher) and
  F's per-author blame color mode — plus D's branch-popup header actions + settings toggles.

## Landing log

Newest at top. PR# where merged via GitHub; otherwise local squash commit.

| When | Item | Ref | Notes |
|---|---|---|---|
| 2026-06-17 | Workstream D (slice 2) — branch tree HEAD root node (current branch pinned top) + starrable favorites (Memento-persisted `IFavoritesStore`, Favorites section, favorite-by-icon so the full branch menu is preserved); section order HEAD→Favorites→Local→Remote→Tags; multi-repo grouping deferred | 8189cc5 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream F (slice 2) — toggleable blame aspect columns (Author/Date/Revision show-hide) + author-name format (full/firstname/lastname/initials/email), faithful port of IntelliJ `LineAnnotationAspect` + `ShortNameType`; honored in gutter + inline providers | f83283a | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream E (slice 1) — per-file / partial unshelve: `ShelfService.unshelve` accepts a files[] subset, applies only those, keeps unselected + conflicted files shelved (mirrors IntelliJ `remainingPatches`); ShelfView "Unshelve Files…" multi-select picker | 7bbb84b | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream C (residual) — pull `--autostash`: dialog checkbox + op flag (spliced before `--end-of-options`) so a dirty tree no longer dead-ends pull; post-pull porcelain check surfaces an exit-0 autostash-pop conflict as a CONFLICT routed to Resolve Conflicts (mirrors rebase `--autostash`) | 5eef53b | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream D (slice 1) — branch popup header actions (New Branch / Fetch / Settings gear) + gear toggle menu (Group by Directory / Show Recent / Show Tags), defaulting all toggles true so the existing layout is unchanged; mirrors git4idea `GitBranchesTreePopup` | db7d883 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream F (slice 1) — AUTHOR blame color mode alongside ORDER: stable per-author tint over the file's sorted-distinct authors (`palette[i % size]`), faithful port of IntelliJ `AnnotateToggleAction.computeBgColors` + `AnnotationsSettings`; gutter + inline providers honor `intellig.blame.colorMode` | 7a57340 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream B — post-native-editor resolved-row auto-flip: `ConflictResolutionService` reconciles the open `ResolveConflictsDialog` against the unmerged set on the existing git-index watch, flipping externally-resolved rows + enabling Continue; mirrors IntelliJ `MultipleFileMergeDialog` | fcddad4 | local cherry-pick (1 commit) |
| 2026-06-17 | Rebase reword fix — a blank inline reword override no longer writes an empty `-F` message file (which aborts `commit --amend` mid-rebase); `hasRewordOverride` requires non-blank, else falls back to classic interactive reword | fc16950 | local fast-forward (1 commit) |
| 2026-06-16 | Security — `sanitizeGitError` now scrubs the `user:password@` authority of ANY URL scheme (`CREDENTIAL_URL_REGEX` generalized from `https?` to the RFC-3986 scheme grammar `[A-Za-z][A-Za-z0-9+.-]*`), closing a credential leak through every toast/log for `ssh://`/`git://`/`ftp://`/compound-scheme URLs; SCP-form `user@host:path` (no URL password) left untouched | bafee52 | local fast-forward of dev/sanitize-credential-scheme (1 commit) |
| 2026-06-16 | Staging/patch correctness — `generateHunkPatch`/`generateLinesPatch` now C-style quote the `diff --git`/`---`/`+++` header paths (`escapePatchPath`, byte-wise port of git's `quote_c_style`) with a tab-delimiter fallback for unquoted names containing a space, so `git apply` stages the correct bytes on tab/newline/space filenames (real `git apply` round-trip test); `revertHunk` now refuses when the file has staged changes (working-tree-only `-R` would leave the discarded hunk in the index) | 5e6855a | local squash-merge of dev/staging-patch-correctness (2 commits) |
| 2026-06-16 | Front-doors batch — wire tested backends: top-level `intellig.mergeFrom` "Merge…" command (shared Merge Dialog); blame hover click-through rewired to registered `intellig.editor.showCommit`/`copyCommitHash` (dead-link fix); log "No Merges" filter (`--no-merges` + filter-bar checkbox); `…` on "New Branch from Here". Annotate Previous Revision was already wired. | d8ac1da | local squash-merge of dev/front-doors (4 commits) |
| 2026-06-15 | Workstream D — Branches & Tags: incoming/outgoing ↑N/↓N arrows (popup + tree, via `IncomingOutgoingOps`); New Tag dialog editable commit/ref (full `GitTagDialog` parity); `deleteRemoteTag` context-menu front-door | #47 | merged |
| 2026-06-15 | Workstream F — Blame heatmap: interpolated background recency gradient (ORDER mode) replacing fake foreground-alpha fade; `blameAnnotationStyle` wired incl. new `off` value | #48 | merged |
| 2026-06-15 | Workstream B — 3-way merge → VS Code native editor (`git.openMergeEditor`); custom webview removed; `MergeView` now a thin adapter, keeps `markResolved`→`git add` | #46 | merged |
| 2026-06-15 | UX label cleanup — drop redundant `Git:` prefix from 9 explorer/editor command titles | #45 | merged |
| 2026-06-15 | 🔴 fetch argv-injection — route `fetch` through `buildGitArgs` (`--end-of-options` ahead of the remote name) + `check:remote-ops-eoo` CI guard | #45 | merged |
| 2026-06-15 | Build fix — `IChangelist.isActive` on the unversioned pseudo-node + 5 fixtures, README/schema config drift (left broken by #44) | #45 | merged |
| 2026-06-15 | Workstream A — commit/changelists (changelist-driven commit, before-commit checks, Add-to-VCS fix, Local Changes grouping + Unversioned node, diff-preview, tool-window default-on, AA/DD detection) | #44 | merged |
| 2026-06-15 | Workstream C — shell/menus/sync (keymap fixes, status-bar branch popup, view/title toolbar, Incoming tab, Update Project dialog, structured notifications) | #43 | merged |
| 2026-06-15 | Crash fix — cap git output capture at 64 MiB (stops extension-host RangeError on multi-GB repos) | #42 | merged |
| 2026-06-15 | Phase-0 foundations — IncomingOutgoingOps, IChangelist.isActive, KeymapService de-drift | 267d718 | base for A/C/D/G |
| 2026-06-14 | R1 P3 — reset-mode persistence, rebase-options persistence, Copy Commit Message, deleteRemoteTag op | 43b09c5…e1c1e75 | local squash |
| 2026-06-14 | R1 P2 — rebase options, rebase-in-progress guard, revert-hunk, add-to-gitignore, remote set-url/rename, getMergedBranches, tag force, cherry-pick -x, merge options, Update Project (backend) | fd15118…2eedae9 | local squash |
| 2026-06-14 | R1 P1 — all 9 silent-wrong ops + #5 filter-bar UI + #4 rebase-todo preservation | 075b3d4…0bca889 | local squash |

## Review/evidence artifacts

- `NORTHSTAR.md` — high-level plan (heatmap, component gaps, R2 findings, execution order).
- `R2-01-log` … `R2-09-shell`, `R2-UX-01` … `R2-UX-04` — per-area review detail with file:line refs.
- `full-parity-audit` content is folded into `NORTHSTAR.md` (the standalone file was removed in the
  2026-06-15 doc consolidation).
- Reference/design docs: `accessibility.md`, `changed-files-tree.md`, `git-log-graph.md`,
  `repo-states.md`; track design notes `before-commit-checks.md`, `commit-tool-window-changes.md`,
  `incoming-tab.md`, `update-project.md`.

## Open risk carried forward
- R2 review predates the A/C/phase-0 merges — re-verify findings against the merged tree.
- Two R2 UX quick wins (branch-focus highlight, log column headers) were re-checked against the
  merged tree and found **already fixed** — only the `Git:` label cleanup remained, now done.
