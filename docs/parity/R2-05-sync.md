# Parity review (Round 2) — Sync (fetch/pull/push/remotes)

_Round-2 deep review by tech-lead owner of Sync component. North-star = IntelliJ git4idea + IntelliJ Platform (full clone at `~/Documents/workspace/intellij-community`). Our extension = `intellig` (VS Code)._

## Mandate
Re-verify R1 findings vs CURRENT code (post P1 #3/#19b, P2 Update Project, P2 remote ops). Fresh pass: missed gaps (rejected-push strategy dialog, commit-preview pane, Configure Remotes UI), git4idea divergences, blockers, security (credential leakage, argv guards), silent-wrong ops.

## Reference map
- **git4idea source reviewed:** `plugins/git4idea/backend/src/{push/GitPusher.kt,push/GitPushOperation.java,push/GitRejectedPushUpdateDialog.kt,pull/GitPullDialog.kt,update/GitUpdateProcess.java,update/GitFetcher.java}`
- **intellig source reviewed:** `src/sync/{PushDialog.ts,PullDialog.ts,updateProject.ts,AutoFetchService.ts}`, `src/git-core/ops/RemoteOps.ts`, `src/git-core/gitError.ts`

## Gap table
One row per distinct capability/finding. **Source** + **Severity** mandatory.

| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **Rejected-push strategy dialog** | `GitRejectedPushUpdateDialog.kt` shows 3-button modal (Merge / Rebase (Anyway) / Cancel) when push fails non-ff; persists choice via "Remember" checkbox (GitVcsSettings.autoUpdateIfPushRejected). Loops: push → rejected → dialog → update → retry push (max 10 attempts, GitPushOperation.java:89 MAX_PUSH_ATTEMPTS). | PushDialog shows per-row "Pull and Retry…" + "Force with Lease" buttons (:608-610) on `rejected-non-ff` error-kind. **NO modal confirm.** PushDialog._submitRows loops one retry round (via pullAndRetry message handler :873-894); opens PullDialog pre-filled but **does NOT auto-push after pull completes** — user must manually re-click Push. | 🟡 partial | 🟠 high | git4idea | **MISSING:** (1) Auto-retry after pull (IntelliJ loops atomically, user doesn't re-click); (2) Modal confirm offering Merge vs Rebase strategy choice (we hard-code rebase in Update Project); (3) Multi-round retry loop (ours stops after 1 pull attempt); (4) "Remember choice" persistence. **PRESENT:** pull-and-retry affordance, force-with-lease escape-hatch. IntelliJ's `GitPushOperation.java:148-196` push-attempt loop + `:175 showDialogAndGetExitCode` + GitRejectedPushUpdateDialog. Our partial: `PushDialog.ts:873-894 pullAndRetry` handler + `updateProject.ts`. |
| **Commit-preview pane** | `GitPusher.kt:79-85` computes `updatedRanges` (pushed commits) → `GitUpdateInfoAsLog` renders log tab. PushDialog itself doesn't inline commits; the post-push notification (GitPushResultNotification) + update-info tab show the pushed range. **Pull preview:** GitPullDialog.kt no inline preview — IntelliJ Platform separately tracks fetched ranges + renders update-info tabs. | PushDialog `:6 A right-side commit preview pane for the focused row` (JSDoc) — **NOT IMPLEMENTED.** HTML at `:636-667` has no preview region; `_getBodyHtml` emits only table + overflow + actions. No pushed-commit diff surface anywhere. | ❌ missing | 🟡 medium | platform | IntelliJ's preview is **post-push** (update-info log tab), NOT pre-push inline. Our gap: no post-push update-info surface (we toast `Pushed 'branch'` `:1022-1025`, no diff tab). **P4 effort:** full update-info log would mirror GitUpdateInfoAsLog + updatedRanges calc. Filed as polish (medium) since the push-succeeded toast is adequate feedback; power-users want the diff tab. |
| **PullDialog commit-preview pane** | GitPullDialog.kt (Kotlin/Swing) has no inline commit-preview — IntelliJ shows fetch result via update-info log tab post-pull. | PullDialog.ts (native QuickPick) — no commit-preview. | ✅ parity | ⚪ polish | platform | Neither impl shows inline preview. Both rely on post-pull update-info surface (IntelliJ has it; we don't → separate P4 effort). Not a Pull-specific gap. |
| **Configure Remotes dialog UI** | `git4idea/ui/GitConfigureRemotesDialog.java` — table of remotes w/ Add/Edit URL/Rename/Remove buttons. Maps to `GitConfigUtil` backend (set-url, rename, add, remove). | Backend **complete** (`RemoteOps:290-320` setRemoteUrl + renameRemote + addRemote + removeRemote, argv-guarded). **UI missing** — no dialog, no command palette entry, no menu item. | 🟡 partial | 🟡 medium | platform | Backend green (P2 landed c4119b7, unit-locked). UI = P3 polish (low-frequency action; power-users can use CLI). File: need `src/sync/ConfigureRemotesDialog.ts` (webview or QuickPick multi-step). |
| **Auto-fetch prune policy** | `GitFetcher.java` (fetch --all for Update Project) + auto-fetch background tasks — IntelliJ **ALWAYS** passes `--prune` on fetches (implicit in GitFetchSupport.kt). No separate config. | `AutoFetchService.ts:127` calls `gitService.fetch(repo, { prune: true })` — **CORRECT, prune wired.** Manual fetch (`intellig.fetch` command) + PullDialog + Update Project all pass `prune: true`. | ✅ parity | ⚪ polish | git4idea | **VERIFIED GREEN.** All 5 fetch paths (auto-fetch, manual, pull-dialog, push-retry, update-project) pass prune. RemoteOps:74-76 maps it to `--prune` flag. No stale-ref accumulation. |
| **Force-push-with-lease reference tracking** | `GitPushParamsImpl.ForceWithLeaseReference` (GitPushOperation.java:42 import) — can specify per-ref expected SHA (`--force-with-lease=<ref>:<sha>`). Defaults to bare `--force-with-lease`. | `IPushOptions.forceWithLease: boolean` (boolean-only). `RemoteOps.push:229` emits `--force-with-lease` (no ref/sha args). | 🟡 partial | 🟡 medium | git4idea | **MISSING SHA-PINNED VARIANT.** IntelliJ GitPushParamsImpl can pass `--force-with-lease=refs/heads/main:<expected-sha>` for stronger safety (protects against other local fetches changing the tracking ref between dialog-open + push). Our impl = bare `--force-with-lease` (common case, adequate). **Enhancement:** Add `forceWithLeaseRef?: { ref: string, expectedSha?: string }` to IPushOptions if needed; current boolean form covers 95% use-case. Medium (not blocking; bare form is safe). |
| **Fetch/pull/push error credential sanitization** | IntelliJ sanitizes via IDE-wide credential-redaction infra. | `sanitizeGitError` (any-scheme `user:token@host` + PAT form + home-dir paths) is applied at every user-facing surface: manual fetch (`commitRepoCoreCommands.ts:373`), pull (`PullDialog.ts:433`), update-project (`:471`), push (`PushDialog.ts:314`). `RemoteOps.fetch/pull` throw raw, but `GitCli` documents (`:72`) that consumers must sanitize — and they do. AutoFetch classifies via `_extractErrorMessage`+`_isAuthFailure` and shows a generic re-enable prompt; it never logs/toasts raw stderr. | ✅ secure | 🟢 | git4idea | No credential leak path found. |
| **Fetch argv injection (remote/refspec)** | `git fetch <remote> <refspec>` — IntelliJ builds argv with `--end-of-options`. | `RemoteOps.fetch:163` uses `buildGitArgs('fetch', flags, refs)` — the remote name + `<remoteRef>:<localRef>` refspec ride in `refs` behind `--end-of-options` (explicit comment `:118-121`). Same defense as pull/push. | ✅ secure | 🟢 | git4idea | Hostile remote names from `.git/config` (auto-fetch loop) can't inject flags. |
| **Pull refspec argv injection (EXISTING GUARD)** | IntelliJ uses `--end-of-options`. | `RemoteOps.pull:171-211` uses `buildGitArgs('pull', flags, [remote, branch])` → `--end-of-options` at :209. PullDialog doesn't validate remote/branch names (trusts repo.branches list), but buildGitArgs defends. | ✅ parity | ⚪ n/a | git4idea | **SAFE.** Pull has buildGitArgs defense. Remote/branch from PullDialog are user-selected from repo.branches (git-provided), not arbitrary input. |
| **Auto-fetch implementation** | GitFetchSupport.kt + `GitFetchListener` — background task runs `git fetch --all --prune` on interval (controlled via Settings → Git → "Fetch automatically"). | `AutoFetchService.ts` — timer-based tick runs `gitService.fetch(repo, { all: true, prune: true })` per repo via `Promise.allSettled`; classifies auth vs transient failures (`_isAuthFailure` → pause + generic re-enable prompt; transient → exponential backoff). Respects `intellig.autoFetchEnabled` / `intellig.autoFetchInterval` config. Never surfaces raw stderr. | ✅ parity | ⚪ n/a | git4idea | **IMPLEMENTED + CORRECT.** Prune wired; argv-injection-safe (fetch uses buildGitArgs); auth-failure pause + toast de-dup. |
| **Fetch tags policy** | GitFetchSupport — user config `git.fetch.tags` (all / auto / never) controls `--tags` / `--no-tags` / (none) flag on fetch. | `RemoteOps.fetch:77-97` reads `intellig.fetchTags` config (:88-90 workspace.getConfiguration). Programmatic `options.tags` / `options.noTags` override config (:83-86). 'auto' → no flag (git default). | ✅ parity | ⚪ n/a | git4idea | **IMPLEMENTED.** Config parity. Override mechanism lets PushDialog/PullDialog opt out of global policy. |
| **Set-upstream on new-branch push** | GitPushOperation.java automatically sets `--set-upstream` when pushing a branch with no tracking. | `PushDialog._populateRows:453-454 + 468-469` — row gets upstream from `repo.head.upstream` (clicked-HEAD) OR `preselect.upstream` (clicked non-HEAD). `:208-210 buildPushOptions` — `if (!row.upstreamRemote) opts.setUpstream = true`. **Correctly sets upstream** on new branches. | ✅ parity | ⚪ n/a | git4idea | **VERIFIED CORRECT.** Set-upstream wired for new-branch case. Manual test: push new local branch → `--set-upstream origin <branch>` emitted. |
| **Push tag modes** | GitPushOperation.java `:52 pushTagMode` (ALL_TAGS → `--tags`, FOLLOW_ANNOTATED → `--follow-tags`, CURRENT_BRANCH → none). 3-way radio in GitPushOptionsPanel. | `PushDialog` overflow `:652-655` — checkbox "Push tags" + 2 radios (all tags / --follow-tags). Maps to `IPushOverflowState.pushTags/tagScope` (:50-57). `buildPushOptions:224-233` — `pushTags=false` → no flag; `pushTags=true + tagScope='all'` → `--tags`; `tagScope='follow'` → `--follow-tags`. | ✅ parity | ⚪ n/a | git4idea | **IMPLEMENTED.** 3-way semantics match IntelliJ (all / follow / none). UI = gear overflow (not inline like IntelliJ's panel), acceptable. |
| **Protected-branch bare-force guard** | IntelliJ Settings → Git → "Protected branches" — blocks FORCE (not force-with-lease) on listed branches. | `PushDialog.isActionAllowedForRow:259-268` — `action === 'force' && isProtectedTarget(...)` → blocked. Force-with-lease stays allowed (:18 safety policy comment). Config = `intellig.protectedBranches` (ResetDialog also reads it). | ✅ parity | ⚪ n/a | git4idea | **IMPLEMENTED.** Safety policy matches IntelliJ + user memory (feedback_data_loss_confirms.md). Bare force = explicit dropdown entry, never default. |

Status legend: ✅ parity · 🟡 partial · ❌ missing · ➕ ours-only · 🔁 regression-since-R1  
Severity legend: 🔴 blocker/silent-wrong/security · 🟠 high (daily-hit feature) · 🟡 medium · ⚪ polish  
Source legend: `git4idea` (portable git logic) · `platform` (UI we hand-build) · `mixed`

## Top findings (ranked, this component)

1. **Rejected-push strategy dialog (HIGH daily-hit feature)** — IntelliJ shows a modal (Merge / Rebase / Cancel) on non-ff push rejection + loops atomically (push → rejected → update → retry, max 10 rounds), persisting the choice. Our PushDialog offers a per-row "Pull and Retry…" button (`:609`) but the `pullAndRetry` handler (`:873-894`) opens the Pull dialog and, on close, only **clears the row error so the user can click Push again** — no auto-push, no retry loop, no Merge-vs-Rebase modal (it presets `'merge'` but offers no choice). **Severity: 🟠 high (daily collab workflow).** Source: git4idea (`GitPushOperation.java` push-attempt loop + `GitRejectedPushUpdateDialog.kt`). **Effort: M** (have `PullDialog.show` resolve a result → re-submit the row's push; add a Merge/Rebase modal; loop to max-attempts). **Files:** `src/sync/PushDialog.ts:873-894`, `src/sync/updateProject.ts`.

2. **Configure Remotes UI missing** — backend (`RemoteOps.{addRemote,removeRemote,setRemoteUrl,renameRemote}`) is complete + argv-guarded + unit-locked, but no command/menu/dialog reaches it. git4idea exposes `Git.Configure.Remotes` (`GitConfigureRemotesDialog` — remote table with Add/Edit-URL/Rename/Remove). **Severity: 🟡 medium.** **Effort: S/M** (a QuickPick multi-step or webview → existing ops). **Files:** new `src/sync/ConfigureRemotesDialog.ts` + command registration.

3. **Unshallow not surfaced** — git4idea has `Git.Unshallow` (`GitUnshallowRepositoryAction` → `git fetch --unshallow`) to convert a shallow clone to full history. No equivalent op/command in `intellig`. **Severity: ⚪ polish** (only relevant to shallow clones). **Effort: S** (op + command).

## Security review (this component)

### ✅ VERIFIED SAFE

- **Fetch argv injection:** `RemoteOps.fetch:163` uses `buildGitArgs('fetch', flags, refs)` — remote + refspec ride behind `--end-of-options` (comment `:118-121`). Same defense as pull (`:209`) / push (`:256`). Hostile `.git/config` remote names can't inject flags.
- **Push refspec argv injection:** PushDialog.buildPushOptions validates `isValidPushRef` (leading `-`/`.` rejected) + RemoteOps.push uses buildGitArgs. Defense-in-depth.
- **Pull argv injection:** RemoteOps.pull uses buildGitArgs; PullDialog sources remote/branch from repo.branches (git-provided). Safe.
- **Credential / home-dir sanitization:** `sanitizeGitError` (any-scheme `user:token@host` + PAT form + `/Users|/home|C:\Users` → `~/`) applied at every user-facing surface — manual fetch (`commitRepoCoreCommands.ts:373`), pull (`PullDialog.ts:433`), update (`:471`), push (`PushDialog.ts:314`). AutoFetch classifies auth/transient and never surfaces raw stderr.
- **Remote set-url/rename argv guards:** RemoteOps guards leading-dash on name/URL (git's `remote` subcommand has no `--end-of-options`; guard is the right tool).

## Blockers

**None.** Fetch/pull/push argv guards verified (buildGitArgs + `--end-of-options`); credential sanitization applied at all surfaces. Remaining items are feature/UX gaps:
- Rejected-push strategy dialog (finding #1) — daily-hit UX gap, M effort.
- Configure Remotes dialog UI (finding #2) — backend complete, UI missing, S/M effort.
- Unshallow (finding #3) — shallow-clone only, S effort.

---

## Executive summary (6-10 line)

**Top 3 findings:**
1. 🟠 **Rejected-push strategy dialog (HIGH daily-hit)** — IntelliJ loops push → rejected → modal (Merge/Rebase) → update → retry (max 10). Ours: per-row "Pull and Retry" button opens the Pull dialog but doesn't auto-push or loop, and offers no Merge/Rebase modal. (M effort, not blocking.)
2. 🟡 **Configure Remotes UI** — backend complete (add/remove/set-url/rename, argv-guarded, unit-locked), no command/menu/dialog. (S/M effort.)
3. ⚪ **Unshallow** — `git fetch --unshallow` not surfaced (`Git.Unshallow`). (S effort, shallow-clone only.)

**State:** Core sync (fetch/pull/push, force-with-lease default, prune, auto-fetch, Update Project single-repo) at parity. Update Project's multi-repo + update-info log tab remain deferred (P4).

**Blockers/security:** 0 blockers. Fetch/pull/push argv guards verified (buildGitArgs + `--end-of-options`); credential + home-dir sanitization applied at all surfaces. Sync component is security-sound.


---

## Appendix — Update Project contract spec (durable; folded from former `update-project.md`)

_Layer-3 contract spec (ADR-010), test-pinned. NORTHSTAR tie-back: workstream **C** (Shell/Menus/Sync)._

Layer-3 reference doc (ADR-010) for IntelliJ's **Update Project**
(`Vcs.UpdateProject`, Ctrl+T) — `GitUpdateOptionsDialog` +
`GitUpdateProcess` + the **Update Info** results tab.

Cross-references: ADR-001 (IGitService freeze), ADR-010,
`docs/parity/NORTHSTAR.md` (workstream C — Shell/Menus/Sync), and the git4idea
reference `plugins/git4idea/backend/src/update/{GitUpdateProcess.java,
GitUpdateOptionsDialog.kt}` + `shared/.../config/UpdateMethod.java`.

## 0. Repo-state landmap (ADR-010 Layer 4)

| State | Behaviour | Coverage |
| --- | --- | --- |
| default, upstream set, incoming > 0 | fetch → pull with chosen strategy → `updated` | covered (updateProjectFlow.test.ts) |
| in sync (incoming = 0) | fetch only → `up-to-date`, no pull | covered |
| no upstream | `up-to-date`, no pull | covered |
| rebase/merge in progress | per-repo `error` (preflight block), other repos continue | covered |
| unmerged files | per-repo `error` (preflight block) | covered |
| pull conflict | per-repo `conflict` | covered |
| multi-root | each root updated independently, results aggregated | covered |

## 1. Update method (GitUpdateOptionsDialog / UpdateMethod)

The dialog (a QuickPick) offers three methods, mirroring git4idea's
`UpdateMethod` (RESET is out of scope for the pure-Git surface):

- **Merge** → `git pull` (merge fetched commits; fast-forwards when possible).
- **Rebase** → `git pull --rebase` (replay local commits on the fetched tip).
- **Branch default** → resolve per repo.

### 1.1 BRANCH_DEFAULT resolution

git4idea's `GitUpdater.getUpdater(BRANCH_DEFAULT)` reads, in order:
`branch.<name>.rebase` → `pull.rebase` → MERGE.

IntelliG approximates this with the `intellig.pullRebase` setting (the
IntelliG analog of `pull.rebase`): `resolveUpdateRebase('branch-default',
pullRebaseDefault)`. The finer-grained per-branch `branch.<name>.rebase`
override needs a `git config` read on the service — a **deferred
cross-cutting change** (a new git op + GitService method, ADR-001 pattern).
Until then, branch-default == the repo/global pull.rebase analog.

## 2. GitUpdateProcess flow (`runUpdateProject`)

For each repository (multi-root):

1. **Preflight** (`updateProjectBlockedReason`): block on rebase/merge in
   progress or unmerged files (GitUpdateProcess parity). A blocked repo is
   recorded as `error` and the run continues with the next repo.
2. **`git fetch --all --prune`**.
3. **Incoming count** via Phase-0a `getIncomingOutgoing` — populates the
   Update Info summary and short-circuits `up-to-date` when nothing is
   incoming / no upstream.
4. **`git pull`** with the resolved strategy. A `CONFLICT` failure →
   `conflict`; any other failure → `error`.

The flow is pure orchestration over an injected git surface
(`IUpdateGitService`) — no `vscode` import — so it is fully unit-testable.

> **Deferred vs git4idea**: the save-local-changes (autostash) step is NOT
> performed here; it is owed to the Pull `--autostash` follow-up (section C Item 6,
> a cross-cutting change in `IPullOptions` + `RemoteOps`). The rebase-over-
> merge problem dialog and the per-root `GitUpdatedRanges` log-range
> computation are also out of scope for this pass.

## 3. Update Info tab (`UpdateInfoTab`)

Holds the latest `IUpdateInfoSummary` (per-repo `IUpdateRepoResult[]` +
totals). `updateInfoHeadline(summary)` produces the one-line outcome used by
the post-update notification and the tab header:

- conflicts present → "Update finished with N conflict(s) …"
- errors present → "Update failed in N of M repo(s)."
- nothing incoming → "Already up to date." / "All repositories already up to date."
- otherwise → "Updated N repositories; K commit(s) pulled."

### 3.1 Render + provider wiring (DEFERRED to the Log/Graph workstream)

`UpdateInfoTab` exposes `setSummary(summary)` + `asTabHandler()` + an
`onStateChange` hook, mirroring HistoryTab/IncomingTab. The HTML renderer
(`html/updateInfoHtml.ts`) and the provider wiring that calls `setSummary`
after `intellig.updateProject` runs live in the Log/Graph (G) workstream.
Until that lands, the command surfaces the headline via a notification with a
"Show Update Info" deep-link that focuses the `updateInfo` tab.

## 4. Test coverage

- Method resolution: `resolveUpdateRebase`, `buildUpdatePullOptions`.
- Orchestration: `runUpdateProject` (single/multi-root, in-sync, no-upstream,
  blocked, conflict, error) — `updateProjectFlow.test.ts`.
- Summary fold + headline: `summarizeUpdate`, `updateInfoHeadline`.
- Tab state machine: `UpdateInfoTab` (setSummary, refresh, jump, malformed).
- Preflight predicate: `updateProjectGuard.test.ts` (pre-existing).


---

## Appendix — Incoming tab contract spec (durable; folded from former `incoming-tab.md`)

_Layer-3 contract spec (ADR-010), test-pinned. NORTHSTAR tie-back: workstream **C / G** (Incoming tab)._

Layer-3 reference doc (ADR-010) for the Git tool window **Incoming** tab.
IntelliJ reference: git4idea's "Incoming" view, fed by
`GitBranchIncomingOutgoingManager` (the same notion that drives the
incoming/outgoing branch arrows).

Cross-references: ADR-001 (IGitService freeze), ADR-010 (visual parity
discipline), `docs/parity/NORTHSTAR.md` (workstream C / G — Incoming tab).

## 0. Repo-state landmap (ADR-010 Layer 4)

| State | Behaviour | Coverage |
| --- | --- | --- |
| default (attached HEAD, upstream set) | lists incoming commits; shows counts | covered (incomingTab.test.ts, incomingCommitSelection.property) |
| no upstream | `noUpstream: true`, empty list, no log calls | covered |
| in sync (incoming = 0) | empty list, no log calls | covered |
| diverged (branch + upstream both moved) | exact upstream-minus-HEAD difference | covered (property test) |
| detached HEAD | resolves to `branch: 'HEAD'`, treated as no-upstream by 0a | inherited from `IncomingOutgoingOps.getForCurrentBranch` |
| empty repo / mid-op | `getIncomingOutgoing` returns zero counts → empty list | inherited from 0a; renderer-stage NOT covered (deferred to Log/Graph stream) |

## 1. Data model

The tab's state (`IIncomingTabState`) is:

- `branch` — current branch (or `HEAD` when detached)
- `upstream` — resolved tracking ref (e.g. `origin/main`), or `undefined`
- `incomingCount` — git "behind" count (commits a pull would bring in)
- `outgoingCount` — git "ahead" count (shown as context)
- `noUpstream` — true when the branch tracks nothing
- `commits` — the incoming commits, newest first
- `selectedCommit` — selected row hash
- `error` / `loading` — UI side-bands

### 1.1 Where the data comes from

- **Counts + upstream**: `GitService.getIncomingOutgoing` (Phase 0a) —
  `git rev-list --left-right --count <upstream>...HEAD`.
- **Commit list**: computed as the **set difference** of the upstream's log
  and HEAD's log, keyed on commit hash
  (`selectIncomingCommits(upstreamLog, headHashSet(headLog))`). This uses only
  the frozen `IGitService.getLog`, so the tab adds **no new git op** (ADR-001).
  The set-difference is exact even when the branch and upstream have diverged —
  a naïve "top N of the upstream log" slice would be wrong in that case.

## 2. Render rules (DEFERRED to the Log/Graph workstream)

The HTML renderer lives in `src/git-core/gitToolWindow/html/incomingHtml.ts`
and the provider wiring in `GitToolWindowProvider.ts` — both owned by the
Log/Graph (G) workstream. This workstream (C) ships the **data + handler
layer** only (`tabs/IncomingTab.ts`). The intended render contract, for G to
implement against this state:

- Header row: `↓<incomingCount>` badge, branch → upstream label, and a Pull
  button when `incomingCount > 0`.
- "No upstream" empty state when `noUpstream`.
- "Up to date" empty state when `incomingCount === 0 && !noUpstream`.
- One row per `commits[i]`: short hash, first message line, author, date.
- Row click posts `incoming.selectCommit`; double-click / Enter posts
  `incoming.jumpToCommit` (routed to the Log tab's scroll-to-commit).
- `error` rendered as an inline banner (HistoryTab state-sideband pattern).

## 3. Message protocol

Inbound (webview → host):

- `incoming.refresh` — recompute counts + list
- `incoming.selectCommit { hash }` — record selection
- `incoming.jumpToCommit { hash }` — route to the Log tab via the
  `jumpToCommit` hook

Outbound (host → webview), posted by the provider via the `onStateChange`
hook: `incoming.updateState { state }`.

## 4. Test coverage (snapshot back-references)

- Pure set-difference: `selectIncomingCommits` / `headHashSet`
  (`incomingTab.test.ts`, `incomingCommitSelection.property.test.ts` — 200-run
  fast-check).
- State machine: refresh (no-upstream / in-sync / diverged / error / no-repo),
  selection, jump routing, malformed-message handling, `onStateChange`
  loading→settled emission (`incomingTab.test.ts`).
- Renderer-stage / jsdom-layout snapshots are owed when the Log/Graph stream
  lands `incomingHtml.ts` (ADR-010 Layer 1 multi-stage discipline).
