# Parity review (Round 2) — Commit ops

> **NORTHSTAR tie-back:** workstream **A** (Commit & Changelists) · role: Round-2 deep audit. See `NORTHSTAR.md` section 7 (reference index).

_Round-2 deep tech-lead review for the **Commit ops** component: commit/amend, reset (soft/mixed/hard/keep + Smart Reset + mode persistence), undo last commit (message-preserving), history-rewrite actions (reword/fixup/squash/uncommit), cherry-pick -x, create tag (+force), commit dialog/composer._

**Component owner:** tech-lead-reviewer  
**Review date:** 2026-06-15  
**North-star:** IntelliJ git4idea @ `~/Documents/workspace/intellij-community`  
**Our extension:** intellig @ `/Users/kahochan/Documents/workspace/intellig`

---

## Reference map

### git4idea / platform source reviewed
- `plugins/git4idea/backend/src/reset/GitResetOperation.java` — Smart Reset (stash proposal), SmartResetPolicy
- `plugins/git4idea/backend/src/reset/GitUncommitAction.java` — undo-commit w/ message prefill
- `plugins/git4idea/backend/src/ui/GitResetDialog.java` — mode selection dialog, validation
- `plugins/git4idea/backend/src/ui/GitTagDialog.java` — force checkbox
- `plugins/git4idea/backend/src/rebase/GitRewordAction.kt` — history-rewrite action

### intellig source reviewed
- `src/ui-shell/ResetDialog.ts` — Smart Reset, mode persistence, protected-branch guard
- `src/commits/CommitDialog.ts` — commit dialog, author override, --no-verify
- `src/commits/CommitContextMenuCommands.ts` — log context actions (cherry-pick, squash/fixup, drop, undo)
- `src/commits/CommitToolWindow.ts` — commit composer with message prefill
- `src/git-core/ops/CherryPickRevertOps.ts` — cherry-pick -x implementation
- `src/git-core/ops/StashTagHistoryOps.ts` — createTag with force flag

---

## Gap table

| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **Reword Commit** log action | `GitRewordAction.kt` — single-click "Reword…" opens editor for the clicked commit's message; runs interactive rebase edit-then-reword | **Implemented**: `CommitContextMenuCommands.ts:326 case 'rewordCommit'` handler + menu wiring. Not verified in this review scope (was part of Wave 2.2 rebase ops). | ✅ parity | ⚪ polish | git4idea | `src/commits/CommitContextMenuCommands.ts` lines 326-forward. Separately reviewed as part of rebase ops. |
| **Fixup/Squash into Previous** actions | `GitFixupAction` / `GitSquashAction` — single-commit actions that rebase the selected commit into its parent; distinct from multi-select squash | **Implemented**: `case 'fixupWithPrevious'` / `case 'squashWithPrevious'` at CommitContextMenuCommands.ts:341/338. Interactive rebase under the hood. | ✅ parity | ⚪ polish | git4idea | Handlers present. Full behavior review deferred to rebase ops component. |
| **Uncommit** (Drop Commit action) | `GitResetToCommitAction` — resets current branch to commit's parent, preserving working tree | **Implemented**: `case 'dropCommit'` at line 310. Interactive rebase `drop` for non-HEAD; soft-reset for HEAD. | ✅ parity | ⚪ polish | git4idea | Handler present at CommitContextMenuCommands.ts. |
| **Reset dialog: F5 dogfood confirm** | IntelliJ dialog is modal + synchronous; executes on OK click | **Not dogfooded in this review**: ResetDialog is webview-based (BaseWebviewPanel). Dialog structure reviewed; actual F5 behavior unverified. | 🟡 partial | 🟡 medium | platform | `src/ui-shell/ResetDialog.ts`. Smart Reset tested in unit (5 tests @ 220dd7e); full end-to-end F5 flow needs manual confirm or ext-host test. |
| **Amend commit action** wiring | Menu item "Amend Previous Commit" | **Implemented**: `IGitService.commit(..., {amend:true})` + CommitDialog `amend` mode. Not wired via log context menu — amend is accessed via Commit dialog checkbox or tool window. | ✅ parity | ⚪ polish | git4idea | `src/commits/CommitDialog.ts`, `src/git-core/GitService.ts:1372`. Different UX surface (dialog vs log menu), but functionality present. |
| **Commit author override validation** | IntelliJ validates `Name <email>` format before commit | **Implemented**: `AUTHOR_FORMAT_REGEX` at CommitDialog.ts:189 + `isValidAuthorFormat` guard. Rejects malformed input before `git commit --author`. | ✅ parity | 🟠 high | git4idea | Security guard present. Regex: `/^[^<>]+ <[^<>@\s]+@[^<>\s]+>$/` matches IntelliJ lenient-but-safe pattern. |
| **Commit --no-verify persistence** | IntelliJ persists "Skip hooks" checkbox state across invocations | **Implemented**: `LAST_NO_VERIFY_STATE_KEY` at CommitDialog.ts:24 + gear-menu toggle survives dialog close/reopen via workspaceState. | ✅ parity | ⚪ polish | git4idea | `src/commits/CommitDialog.ts`. Matches IntelliJ per-project persistence. |
| **Reset protected-branch guard** | IntelliJ doesn't have branch-protection at reset level (handles at push/force-push) | **Ours-only**: ResetDialog disables Hard/Keep modes when `currentBranch` in `protectedBranches` config (lines 212, 306). Safety rail not in git4idea. | ➕ ours-only | ⚪ polish | N/A | `src/ui-shell/ResetDialog.ts:212`. Sensible addition; not a parity gap. |
| **Tag delete remote** | `GitDeleteRemoteTagOperation` — push `:refs/tags/<name>` to delete tag on remote | **Implemented + wired**: `intellig.tag.deleteRemote` ("Delete from Remote…") registered at `BranchContextMenuCommands.ts:647` → `_handleDeleteRemoteTag:2464` → `deleteRemoteTag` (StashTagHistoryOps.ts:300, leading-dash guard, `:refs/tags/` empty-src push). | ✅ parity | ⚪ polish | git4idea | Backend + tag-submenu command both present. |
| **Before-commit checks: CRLF / large-file / bad-filename** | `GitCRLFCheckinHandler` (warns on CRLF line-separators), `GitLargeFileCheckinHandler` (warns committing a file over the size threshold), `GitFileNameCheckinHandler` (warns on Windows-reserved / case-colliding names) — all in `GitCheckinHandlerFactory.kt`. | `DEFAULT_CHECKIN_HANDLERS` (CheckinHandlers.ts:212) has 3 (`git.user.name`, `git.unresolved.merge`, `git.detached.root`). The 3 above are unported — the framework accepts them without change (appendix "Ported checks" section 2 lists them as follow-ups). | ❌ missing | 🟡 medium | git4idea | Add three `ICheckinHandler`s. CRLF = check staged blobs for `\r\n`; large-file = `git diff --cached --numstat` byte threshold; bad-filename = reserved-name / case-collision scan. Pure checks, no I/O — fit the existing chain. |
| **Copy Commit Message** action | `Vcs.Log.CopySubjectText` — copies clicked commit's subject (multi-select joins with blank line) | **Implemented**: `case 'copyCommitMessage'` at CommitContextMenuCommands + clipboard handler. | ✅ parity | ⚪ polish | platform | Commit 07e0cd8 (P3). Confirmed present. |
| **Commit message recent-LRU UI** | IntelliJ shows recent messages dropdown in commit dialog | **Implemented**: `RECENT_MESSAGES_STATE_KEY` + `updateRecentMessagesLru` at CommitToolWindow.ts. UI dropdown present in tool window. | ✅ parity | ⚪ polish | platform | `src/commits/CommitToolWindow.ts`. |
| **Smart Reset stash-pop failure handling** | IntelliJ surfaces stash-pop conflicts gracefully | **Reviewed**: `ResetDialog._proposeSmartReset` at lines 521-549. stash → reset → unstash flow. Error path catches + surfaces via toast. Pop-conflicts NOT EXPLICITLY HANDLED as distinct from other unstash errors. | 🟡 partial | 🟡 medium | git4idea | `src/ui-shell/ResetDialog.ts:545`. If stashPop throws on conflict, user sees generic error toast. IntelliJ distinguishes "reset succeeded but unstash conflicted" state. Minor UX gap. |
| **Reset mode Keep (`--keep`)** support | IntelliJ exposes `--keep` mode (reset HEAD, keep index + worktree) | **Implemented**: ResetDialog.ts radio for Keep mode. `GitService.resetToCommit` passes it through. `--keep` argv present in GitService. | ✅ parity | ⚪ polish | git4idea | `src/ui-shell/ResetDialog.ts:340`, `src/git-core/GitService.ts`. Keep mode supported. |

**Status legend:** ✅ parity · 🟡 partial · ❌ missing · ➕ ours-only · 🔁 regression-since-R1  
**Severity legend:** 🔴 blocker/silent-wrong/security · 🟠 high (daily-hit feature) · 🟡 medium · ⚪ polish  
**Source legend:** `git4idea` (portable git logic) · `platform` (UI we hand-build) · `mixed`

---

## Top findings (ranked, this component)

### 1. **Smart Reset stash-pop conflict handling** — 🟡 MEDIUM
**Why it matters:** When Smart Reset's unstash step encounters conflicts (rare but possible), the current error path surfaces a generic "Failed to reset" toast that doesn't distinguish "reset succeeded, unstash conflicted" from "reset failed." IntelliJ treats this as a distinct recoverable state and surfaces the conflicts separately.

**Severity:** 🟡 medium (UX polish, not correctness)  
**Source:** git4idea  
**Effort:** S (add conflict detection in the catch block; route to conflict resolution dialog instead of generic error)  
**Files to touch:** `src/ui-shell/ResetDialog.ts:545` — check if error is stash-apply conflict; if so, call `_openResolveConflictsDialog` (pattern exists at CommitContextMenuCommands for post-rebase conflicts).

---

### 2. **Reset dialog F5 dogfood** — 🟡 MEDIUM (process gap, not code)
**Why it matters:** ResetDialog is webview-based. Smart Reset unit tests exist (5 tests at 220dd7e), but the full user flow (open dialog → pick mode → click Reset → Smart Reset proposal → Stash and Reset → success toast → panel refresh) hasn't been manually confirmed in this review. Unit coverage is strong; end-to-end smoke is missing from review scope.

**Severity:** 🟡 medium (confidence gap, not a bug)  
**Source:** platform  
**Effort:** S (manual F5 or ext-host test — not a code fix)  
**Action:** Recommend one F5 pass or ext-host smoke for ResetDialog before declaring full parity. Unit tests cover logic; UX integration is the residual gap.

---

### 3. **Before-commit checks: 3 unported handlers** — 🟡 MEDIUM
**Why it matters:** `DEFAULT_CHECKIN_HANDLERS` has `git.user.name` / `git.unresolved.merge` / `git.detached.root`, but git4idea's `GitCheckinHandlerFactory` also runs **CRLF**, **large-file**, and **bad-filename** checks. Without them, the user can silently commit a 200 MB blob, mixed line-endings, or a Windows-illegal filename and only discover it later.

**Severity:** 🟡 medium (pre-commit safety net gap)  
**Source:** git4idea (`GitCRLFCheckinHandler` / `GitLargeFileCheckinHandler` / `GitFileNameCheckinHandler`)  
**Effort:** S each (pure `ICheckinHandler`s — the chain already accepts them; appendix section 2 lists them as follow-ups).  
**Files to touch:** `src/commits/CheckinHandlers.ts` (add 3 handlers + append to `DEFAULT_CHECKIN_HANDLERS`), tests in `CheckinHandlers.test.ts`.

---

## Security review (this component)

### Argv injection guards — ✅ VERIFIED PRESENT

1. **Reset target commit ref** — `ResetDialog.ts:147 isValidRef(target)` rejects leading `-` / `.` before passing to `resetToCommit`. Matches `GitService.ts` guard.
2. **Tag name** — `StashTagHistoryOps.ts:226-228` rejects leading `-` / `.` via regex before `git tag`. `createTag` docs cite `validateTagName` (extension.ts).
3. **Cherry-pick commits** — `CherryPickRevertOps.ts:61 buildGitArgs('cherry-pick', flags, commits)` splices user-controlled commit hashes via `--end-of-options` boundary. Safe.
4. **Commit author override** — `AUTHOR_FORMAT_REGEX` at CommitDialog.ts:189 validates `Name <email>` format. Rejects angle-bracket injection. `--author` is a single token to git; no shell interpolation risk.
5. **Stash message** — `StashTagHistoryOps.ts:38 args.push('-m', message)` — git receives message as a single argv element (no shell). Safe.

**Credential leakage:** `sanitizeGitError` applied to all commit/reset/tag/cherry-pick error paths. No credential leaks found in surveyed toast surfaces.

**Destructive-op confirms:**
- **Hard/Keep reset** → single modal confirm at ResetDialog.ts:464 (`_confirmDestructive`). Matches IntelliJ-style minimal confirm (feedback_data_loss_confirms.md).
- **Force tag overwrite** → modal confirm before retry with `-f` (per PROGRESS b67e3a7). Correct.
- **Drop commit** → pre-stash modal confirm at CommitContextMenuCommands (shared with squash). Correct.

**CSP:** ResetDialog extends BaseWebviewPanel; CSP enforced via `_buildCsp(nonce)`. Script nonce present. No inline event handlers. ✅

**Verdict:** No security gaps found. Argv guards present, confirms in place, sanitization applied, CSP enforced.

---

## Blockers

**None.** All P1 silent-wrong ops (#8 Smart Reset, #9 undo message) are closed. History-rewrite actions (reword/fixup/squash/drop) are implemented and wired. Reset dialog is functional (webview-based, not F5-confirmed in this review but unit-tested). Tag operations complete.

**Process blocker (minor):** Reset dialog F5 dogfood missing from review scope — recommend one manual pass or ext-host smoke test before declaring 100% confidence. Not a code blocker.

---

## Summary (exec)

**Component health:** ✅ **STRONG**. No silent-wrong ops. History-rewrite actions (reword/fixup/squash/drop/uncommit) wired. Reset dialog (Smart Reset + Keep mode + persistence) functional. Tag ops incl. remote-tag delete complete. Security guards present. Destructive-op confirms follow IntelliJ-style minimal policy.

**Top 3 findings:**
1. 🟡 **MEDIUM** — Before-commit checks: CRLF / large-file / bad-filename handlers unported (3 pure checks the chain already accepts; appendix section 2 follow-ups).
2. 🟡 **MEDIUM** — Smart Reset stash-pop conflict handling: unstash conflicts surface as generic error instead of routing to conflict resolution dialog (S effort, UX polish).
3. 🟡 **MEDIUM** — Reset dialog F5 dogfood gap: webview flow not manually confirmed in this review; unit tests strong but end-to-end smoke missing (process gap, not code).

**Blockers:** 0. **Security:** clean (argv guards verified, confirms in place, CSP enforced).

**Parity assessment:** Commit ops component is at **functional parity** with IntelliJ git4idea for all daily-hit operations. Residual gaps are the 3 unported before-commit checks + UX polish (stash-pop conflict distinction, F5 smoke). No correctness regressions.

---

_End of Round 2 review for Commit ops component._


---

## Appendix — Before-commit checks contract spec (durable; folded from former `before-commit-checks.md`)

_Layer-3 contract spec (ADR-010), test-pinned. NORTHSTAR tie-back: workstream **A** (Commit & Changelists) — ICheckinHandler parity._

> **NORTHSTAR tie-back:** workstream **A** (Commit & Changelists) · role: contract spec — ICheckinHandler. See `NORTHSTAR.md` section 7 (reference index).

Status: living document (Wave A — Commit/Changelists)

Layer-3 (ADR-010) parity reference for IntelliG's before-commit check
framework (`src/commits/CheckinHandlers.ts` + `CheckinChecks.ts`), porting
git4idea's `ICheckinHandler` / `CheckinHandlerFactory`
(`GitCheckinHandlerFactory.kt:55-516`).

---

## 1. Model

- An `ICheckinHandler` is a **pure** named check: given an `ICheckinContext`
  snapshot it returns zero or more `ICheckinProblem`s (`error` blocks, `warning`
  advises). No I/O inside a handler.
- `ICheckinContext` is gathered once by `gatherCheckinContext`
  (`CheckinChecks.ts`): git `user.name`/`user.email` (via the `gitCli` escape
  hatch, ADR-001), the committed-path working-tree statuses, and a
  detached-HEAD flag.
- `runCheckinHandlers` runs the chain in order and aggregates problems;
  `runBeforeCommitChecks` presents a modal and returns whether the commit may
  proceed.

## 2. Ported checks (this wave)

| Handler                  | git4idea source                          | Severity | Fires when… |
| ------------------------ | ---------------------------------------- | -------- | ----------- |
| `git.user.name`          | `GitUserNameCheckinHandler`              | error    | `user.name` and/or `user.email` is observably unset. **Never** fires when config could not be read (`userIdentityResolved === false`) — indeterminate ≠ missing. |
| `git.unresolved.merge`   | unmerged-path guard                      | error    | a committed file is still `conflicted` (`U`). |
| `git.detached.root`      | `GitDetachedRootCheckinHandler`          | warning  | HEAD is detached (commit lands on no branch). |

Follow-ups (framework already accepts them without change): CRLF, large-file,
bad-filename (`GitCRLFCheckinHandler` / `GitLargeFileCheckinHandler` /
`GitFileNameCheckinHandler`).

## 3. Trigger / bypass

- Checks run automatically before every commit on:
  - the classic `CommitDialog` (`_handleCommit`),
  - the `CommitToolWindow` (`_handleCommit`),
  - `intellig.changelist.commitOnly`.
- The gear menu's **Run before-commit checks** entry previews the checks
  without committing.
- `--no-verify` (the persisted gear toggle, `intellig.commit.lastNoVerify`)
  bypasses BOTH git's own hooks AND these IDE-side checks — the caller simply
  does not invoke `runBeforeCommitChecks`. This keeps "skip the safety nets"
  consistent across hook and IDE checks.
- A blocking (`error`) problem shows a modal whose proceed button is
  "Commit Anyway"; warnings show "Commit". Declining aborts the commit.

## 4. Test coverage

- `changelistCommit.test.ts` — per-handler unit tests + `runCheckinHandlers`
  aggregation/ordering.
- `checkinChecks.test.ts` — `gatherCheckinContext` (config read, status map,
  detached detection, absent-hatch no-false-positive) + `formatCheckinProblems`
  ordering.
- `changelistCommitPlan.property.test.ts` — `runCheckinHandlers` invariants
  (blocking iff an error exists; never blocks on unresolved identity without a
  conflict; a conflict always blocks).
