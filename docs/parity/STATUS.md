# IntelliJ-parity — status & landing log

_Living tracker: current state, what's landed, and the next step. The analysis/plan (gaps,
heatmap, execution order) lives in **[`NORTHSTAR.md`](./NORTHSTAR.md)**. Updated 2026-06-18._

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
- **Batch 5 landed 2026-06-18** (4 slices, combined gate green — 4444 unit + 746 property,
  `check:vsix-clean` OK): **E-4** binary shelve/unshelve, **F-5** file-history details pane +
  commit-graph column, **C-4** reword-pushed-commit history-rewrite guard, **D-5** worktree
  create/open. D-5's worktree-add argv was caught and fixed in review (a usage-rejected form the
  array-only test had missed) before landing.
- **Batch 6 landed 2026-06-18** (4 slices, combined gate green — 4469 unit + 746 property,
  config-coherence + `check:vsix-clean` OK): **E-5** shelf recycle bin, **C-5** tabbed tool-window
  layout default-on, **D-6** per-remote push (choose target remote), **F-6** diff whitespace
  ignore-policy.
- **Batch 7 landed 2026-06-18** (4 slices, combined gate green — 4489 unit + 746 property,
  config-coherence + `check:vsix-clean` OK): **E-6** stash reinstate-index toggle, **D-7** tag
  Merge-into-Current, **F-7** get-version at revision, **H-1** inline reword/squash message editing.
- **Batch 8 landed 2026-06-18** (4 slices, combined gate green — 4518 unit + 746 property,
  config-coherence + remote-ops-eoo + `check:vsix-clean` OK): **E-7** per-file apply-patch tree,
  **E-8** unshelve target-changelist, **D-8** align-local update-selected (FF without checkout),
  **H-2** rebase `--onto`/`--root`.
- **Batch 9 landed 2026-06-18** (4 slices, combined gate green — 4554 unit + 746 property,
  config-coherence + `check:vsix-clean` OK): **A-1** commit-and-push, **B-1** accept non-conflicting
  from both sides, **H-3** revert/cherry-pick `-m` mainline, **A-2** live changed-line gutter tracker.
  A-1 also fixed a latent unconditional-push bug; F-8 inline-diff-on-hover was investigated, found to
  need a line-status tracker first, and rescoped → A-2 (the tracker); the hover popup (F-8b) is deferred.
- **Batch 10 landed 2026-06-18** (2 features + an R2 re-audit pass, combined gate green — 4585 unit +
  746 property, config-coherence + `check:vsix-clean` OK): **F-8b** line-status hover popup, **A-3**
  rollback dialog, **R2 re-audit** of merged main (`reviewer-r2`) + its **fix set**. The audit's one
  HIGH (autosquash "no-op") was verified a FALSE POSITIVE on git 2.50.1; 6 real findings fixed +
  a real-git autosquash test added. **Parity is now ~90%+ across every workstream** (G 100%; B/C/D/E/H
  ~92-100%; A ~90%, F ~95%). Remaining: polish (menu order, palette titles, reset-dialog F5 confirm) +
  an F5 dogfood sweep.

## Landing log

Newest at top. PR# where merged via GitHub; otherwise local squash commit.

| When | Item | Ref | Notes |
|---|---|---|---|
| 2026-06-18 | UX layout polish (round 1) — webview log-menu reorder so the destructive trio (Reset→Revert→Drop) LEADS the history block per git4idea `Git.Log.ContextMenu` (test-locked ordering); command-palette ellipsis pass (dialog-opening titles end with `…`); reset-dialog destructive confirm verified already present. Mapped the per-surface UX heatmap + prioritized gap table (ux-analyst pass) — now folded into `NORTHSTAR.md` section 4b + `R2-UX-03-menus.md` | 64c5a20, 05515e5 | local cherry-pick + UX gap map |
| 2026-06-18 | R2 re-audit fixes — RemoteOps.addRemote leading-dash guard; rebaseTodo first-entry squash/fixup pre-flight throw + full-hash message-file key (8-char collision); `_isCommitPushed` hex-guard; line-status LCS now capped by `m*n` cells (not just per-side) to protect the ext host; + a real-git autosquash round-trip test (locks the verified behavior, closes the argv-shape-only gap); comment-hygiene tidies | 836f47c, 2b69b00 | local cherry-pick + lead fixes |
| 2026-06-18 | Workstream A (slice 3) — rollback / revert-local-changes dialog: modal IntelliJ-style confirm listing affected files (explicit untracked-delete warning), status-aware revert (modified/deleted → `checkout HEAD -- <paths>`, added → `rm --cached -- <paths>`, untracked → delete) with all paths positional behind `--`; recursive untracked delete is guarded by a path-containment check (rejects empty/`.`/`..`/outside-repo); mirrors `RollbackChangesDialog`/`RollbackWorker` | 2d41856 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream F (slice 8b) — line-status hover popup: hovering a changed line shows the old (HEAD) content + "Revert this change"/"Copy old content" via scoped-`isTrusted` command links (args `encodeURIComponent(JSON.stringify([uri,line]))`, content HTML-escaped in a fence-length-safe code block); revert is an in-memory `WorkspaceEdit` (working-tree-safe); reuses the A-2 range model; mirrors `LineStatusMarkerPopupActions` | 76ea5e4 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream A (slice 2) — live changed-line gutter tracker: pure `computeLineStatusRanges` (in-memory LCS line diff of buffer vs `git show HEAD:<path>` → added/modified/deleted ranges, capped at `MAX_TRACKED_LINES=10000` to protect the ext host) + `LineStatusTracker` gutter/overview-ruler decorations, debounced live updates; mirrors `LineStatusTracker.java`. (Hover popup F-8b deferred) | 0af6b06 | local cherry-pick (squashed) |
| 2026-06-18 | Workstream H (slice 3) — revert/cherry-pick `-m <mainline>` for merge commits: `-m` is added only when a (validated positive-integer) mainline is supplied so non-merge commits never get the invalid flag; hashes positional behind `--end-of-options`; mirrors git4idea revert/cherry-pick merge handling | 693044f | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream B (slice 1) — "accept non-conflicting changes from both sides": reads the index merge stages (`:1:/:2:/:3:`) and delegates the 3-way merge to `git merge-file -p` (auto-applies one-sided hunks, re-emits markers for two-sided), stages only when fully merged, skips modify/delete; no diff3 reinvention; mirrors `ApplyNonConflictsAction`/`applyNonConflictedChanges` | 541eefe | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream A (slice 1) — commit-and-push in one action: pure `commitThenPush` pushes only when the commit reports `committed:true` (cancelled / no-result / thrown commit skip the push — also fixed a latent unconditional-push bug), chaining the existing `intellig.commit` + `intellig.push`; mirrors `GitCommitAndPushExecutor` | e2c135f | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream D (slice 8) — align-local "Update Selected": fast-forwards a local branch to its tracked remote WITHOUT checkout via a `<remoteRef>:<localRef>` fetch refspec (no leading `+` ⇒ FF-only, git refuses non-FF), skipping checked-out/diverged(outgoing>0)/up-to-date branches with a report; refspec rides behind `--end-of-options`; mirrors `GitBranchPopupActions` update-selected | 27e8e91 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream H (slice 2) — surface rebase `--onto <newbase>` / `--root`: `BranchOps` builds `rebase --autostash [--root] [--onto <newbase>] --end-of-options [<upstream>]` (newbase rejects `-`/`.`-leading, root↔upstream mutually exclusive via `refs = root ? [] : [onto]`); mirrors git4idea `GitRebaseDialog` Onto field / `GitRebaseProcess` | aa2baa0 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream E (slice 8) — unshelve into a target changelist: optional `targetChangelist` routes cleanly-applied files via `IChangelistService.moveToChangelist` after the apply loop (conflicted files never reassigned, no target = active changelist unchanged); ShelfView changelist picker; mirrors `ShelveChangesManager.unshelveChangeList` | cd7c429 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream E (slice 7) — per-file Apply-Patch selection: `filterPatchByFiles` reuses `splitPatchByFile` to keep only the selected files' verbatim blocks (round-trips through `git apply`), multi-select pre-checked picker when >1 file; select-all = unchanged behavior; mirrors `ApplyPatchDifferentiatedDialog.getIncludedChanges` | 8d25435 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream F (slice 7) — "get version" at a selected file-history revision: `DiffOps.getFileAtRevision` fetches `git show <rev>:<path>` as one positional token behind `--end-of-options` (a hostile rev can't become a flag) and opens it read-only via `openTextDocument`; optional façade method guarded in HistoryTab; mirrors git4idea file-history Get/Show-revision | b8bc3b7 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream D (slice 7) — tag "Merge into Current": routes the selected tag through the existing merge surface (MergeDialog when wired with `sourceBranch: tag`, else direct `mergeBranch` with the same conflict→Resolve-Conflicts routing as branch merge); context-menu + popup; mirrors `GitBranchPopupActions.TagActions`. Align-local submenu deferred | 68c1bab | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream H (slice 1) — inline reword/squash message editing in the rebase planner: extends `hasRewordOverride` with `hasSquashOverride` (both require a non-blank message, so a blank inline message never writes an empty `-F` file that aborts the amend); squash applies via `fixup` + `exec git commit --amend -F <msgfile>` (no interactive pause), mirroring git4idea's converter | 4c4fa95 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream E (slice 6) — stash apply/pop "reinstate index" toggle: `--index` is added only when reinstateIndex is chosen (default true preserves the staged split; false = working-tree-only apply), QuickPick on the apply/pop actions; mirrors git4idea `GitUnstashDialog` reinstate-index checkbox / `GitStashUtils.createUnstashHandler` | b72f21f | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream F (slice 6) — diff whitespace ignore-policy (`intellig.diff.ignorePolicy`): pure `diffIgnorePolicyFlags` maps the 4 IntelliJ `IgnorePolicy` levels onto git flags (trim→`--ignore-space-at-eol`, ignore→`--ignore-all-space`, +empty-lines→`+--ignore-blank-lines`, default→none), `DiffOps.whitespaceFlags()` applies it at all 3 diff sites; default preserves behavior, fixed-literal flags (injection-safe); mirrors `platform/diff-impl/.../IgnorePolicy.java` | 6aaed4a | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream C (slice 5) — tabbed Git tool-window layout default-on (`intellig.useTabbedGitToolWindow` false→true; provider already honored the flag every render, so a pure default flip + config.ts fallbacks + README/mock); matches IntelliJ's tabbed Git tool window (`ChangesViewContentManager`) | fe897e8 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream D (slice 6) — per-remote push: `_chooseTargetRemote` QuickPick when >1 remote (default = tracked remote / origin / first, preselected; ≤1 remote no-prompt fast path), sets upstream when redirected to a non-tracked remote, routes the chosen remote into push/pushTag (already eoo-safe via `buildGitArgs`); mirrors `GitPushTarget.getRemoteToPush` / `GitUtil.getDefaultOrFirstRemote` | f95b3f7 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream E (slice 5) — shelf recycle bin: `deleteShelfItem` stamps a `deletedAt` marker (Recently-Deleted) instead of splicing; `getRecycledShelfItems` + `restoreFromRecycleBin` + `deleteShelfItemPermanently`; the fully-applied-unshelve cleanup still PURGES (not recycles) via `purgeShelfItem`; additive store field, no version bump; mirrors `ShelveChangesManager.markChangeListAsDeleted`/`restoreList` | 16940e2 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream D (slice 5) — git worktree create/open: `WorktreeOps.addWorktree` (`git worktree add [-b <newBranch>] -- <path> <ref>`, single `--` guarding both positionals so a hostile path/ref cannot become a flag) + `parseWorktreeList` (`--porcelain` records: main/linked/detached/bare/locked, trailing-record flush) + "New Worktree…"/"Open Worktree…" branch context-menu commands (QuickPick → `vscode.openFolder`); mirrors git4idea `GitWorktreeListParser`. Includes a real-git round-trip test (caught a usage-rejected argv the array-only test had missed) | 6e0ffb9 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream C (slice 4) — history-rewrite safety on the log/commit menu: warn (modal, fail-closed) before rewording an already-pushed commit, hoisted to cover BOTH the HEAD-amend and non-HEAD-rebase reword paths (reword + push-up-to-here + squash/fixup/drop already existed on main); mirrors git4idea `GitCommitEditingActionBase.checkCommitsCanBeEdited` | cbc55c9 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream F (slice 4) — file-history details pane (full message/author+email/authored+committed dates/full hash with copy/parents; committer line only when committer ≠ author) + mini commit-graph column reusing `commitGraph.ts` lane/edge layout; read-only, single HTML-escape boundary, stale-fetch-unaffected; mirrors `CommitPresentationUtil` + `FileHistoryPanel` | fb3b635 | local cherry-pick (1 commit) |
| 2026-06-18 | Workstream E (slice 4) — binary-file shelve/unshelve: detect binaries via `git diff --numstat` (`-\t-`), capture raw working-tree bytes (base64) instead of a text patch so NUL/non-UTF-8 round-trips byte-for-byte, classify added/modified/deleted, restore via `fs` (write bytes or delete); diff view shows "binary file"; mirrors IntelliJ `ShelvedBinaryFile` | cc060c0 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream E (slice 3) — shelf "diff with local changes": reconstruct the shelved file version (base `git show HEAD:<path>` + stored patch via pure `applyTextPatch`) and open a real `vscode.diff` against the live working-tree file (was static patch text); mirrors IntelliJ `DiffShelvedChangesWithLocalActionProvider` | a99cf9c | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream C (residual) — native `vscode.scm` SourceControl provider "IntelliG Git": Staged/Changes resource groups from the existing git status model, refreshed on repo-change, click-to-diff (working↔HEAD); per-repo SourceControl, programmatic (no `contributes`) | 3c04ab9 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream F (slice) — line-scoped file history via `git log -L<start>,<end>:<file>` (additive `getLineHistory` op, injection-safe argv splicing, validated range, whole-file fallback); mirrors IntelliJ "Show History for Selection" | 71e2b69 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream D (slice) — multi-repo branch-tree grouping: per-repository root nodes when >1 repo (each owns HEAD/Favorites/Local/Remote/Tags), single-repo flat layout unchanged; mirrors `GitBranchesTreeMultiRepoModel` | 95ec00e | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream D (slice 3) — conflict-aware branch-name validation in NewBranchDialog: pure `check-ref-format` validator (forbidden chars/sequences, leading/trailing rules) + conflict detection (existing local / current / remote / both-direction directory clash), live inline error + Create disable + server-side re-validation; overwrite bypasses only local/current (mirrors `GitRefNameValidator`/`GitBranchValidator`) | c310b69 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream F (slice 3) — file-history "show affected paths": on revision select, fetch the commit's changed files via existing `getCommitDiff` and render a read-only M/A/D/R/C-badged pane (stale-fetch guarded, HTML-escaped); mirrors IntelliJ `VcsLogChangesBrowser` | 8be3fb8 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream C (residual) — restore git Console surface: `ConsoleService` now owns a lazy "IntelliG Git Console" OutputChannel fed by the GitCli command feed (timestamped command line + output/errors), `showConsole()`/`intellig.showGitConsole` reveal it; mirrors `GitVcsConsoleWriter` | 7bb2e79 | local cherry-pick (1 commit) |
| 2026-06-17 | Workstream E (slice 2) — split an imported multi-file patch into one shelf file per changed file (`splitPatchByFile` on `diff --git` boundaries, verbatim blocks so `git apply` round-trips); mirrors IntelliJ `PatchReader.readTextPatches` | 987d37f | local cherry-pick (1 commit) |
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
- Contract specs that survived consolidation are folded into the `R2-05`/`R2-06`/`R2-08` appendices
  (Changed-files-tree / Local-Changes / Before-commit-checks / Update-Project / Incoming-tab). The
  jargon-heavy reference docs (`accessibility`, `git-log-graph`, `repo-states`) were removed — their
  contracts live in the property/snapshot tests + ADR-013 they pointed to. See `NORTHSTAR.md` section 7.

## Open risk carried forward
- R2 review predates the A/C/phase-0 merges — re-verify findings against the merged tree.
- Two R2 UX quick wins (branch-focus highlight, log column headers) were re-checked against the
  merged tree and found **already fixed** — only the `Git:` label cleanup remained, now done.
