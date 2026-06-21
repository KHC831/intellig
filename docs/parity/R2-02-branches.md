# Parity review (Round 2) — Branches

> **NORTHSTAR tie-back:** workstream **D** (Branches & Tags) · role: Round-2 deep audit. See `NORTHSTAR.md` section 7 (reference index).

_Round-2 deep tech-lead review by the assigned Branches component owner. North-star = IntelliJ git4idea (full clone at `~/Documents/workspace/intellij-community/plugins/git4idea`). Our extension = `intellig` (VS Code). This review covers: branch list/popup, create/checkout/delete/rename branch, compare branches, cherry-pick from a branch, merged-branch cleanup, branch context menus, multi-select/bulk branch ops, the branch front-door widget._

**Review date:** 2026-06-15 (re-audited 2026-06-21 against current source — 2 findings resolved, worktree-teardown gap added)
**Reviewer:** tech-lead-reviewer (Branches component owner)
**Code state:** main @ 0bca889 (post-P1 autonomous run, P2 partial)

## Mandate (decide what matters for YOUR component)
This review covers:
- **Feature/behavior gaps** vs IntelliJ — including ones NORTHSTAR missed
- **Code differences** — where our impl diverges from git4idea's approach causing wrong/risky behavior
- **Blockers** — anything that stops a feature from working end-to-end
- **Security / abuse gaps** — argv injection, credential leakage, unsanitized surfaces
- **Correctness regressions / silent-wrong git ops** — the highest parity weight
- Architectural debt that will compound into maintenance pain

## Reference map
- **git4idea source reviewed:**
  - `plugins/git4idea/backend/src/branch/GitBranchWorker.java` (operations orchestrator)
  - `plugins/git4idea/backend/src/branch/GitDeleteBranchOperation.java` (unmerged detection + restore)
  - `plugins/git4idea/backend/src/branch/GitBrancherImpl.java` (multi-repo coordinator)
  - `plugins/git4idea/shared/src/com/intellij/vcs/git/branch/popup/GitBranchesPopupBase.kt` (popup UI)
  - `plugins/git4idea/shared/src/com/intellij/vcs/git/branch/tree/GitBranchesTreeModel.kt` (tree widget)
- **intellig source reviewed:**
  - `src/git-core/ops/BranchOps.ts` (git command layer, 656 lines)
  - `src/branches/BranchContextMenuCommands.ts` (context menu handlers)
  - `src/branches/BranchPopup.ts` (sectioned QuickPick selector)
  - `src/branches/BranchComparisonView.ts` (compare-with-current UI)
  - `src/branches/NewBranchDialog.ts` (create branch flow)
  - `src/branches/BranchTreeProvider.ts` (tree widget data provider)

## R1 follow-up (verify each prior finding against current code)
| R1 gap | R1 status | Current status (re-verified) | Commit that closed it (if any) | Notes |
|---|---|---|---|---|
| P1 #7: Branch cherry-pick pulls from global log, not clicked branch | ❌ missing | ✅ parity | cf88c99 (2026-06-14) | `ILogOptions.ref` scopes cherry-pick dialog to selected branch |
| P2: Compare with Current → split log view | 🟡 partial (toast only) | 🟡 partial | — | BranchComparisonView exists but renders as flat QuickPick, not IntelliJ's split-log panel (P4 platform-rebuild) |
| P2: Find merged branches / bulk cleanup | ❌ missing | ❌ not implemented | — | Intentionally not implemented — git4idea `Git.Cleanup.Branches` is `internal="true"` (not user-facing parity); the orphaned backend was removed |
| P3: Branch context menu ordering | 🟡 partial | 🟡 partial | — | Most actions registered but order doesn't match IntelliJ's grouping (Checkout/New Branch/Merge/Rebase/Compare → Delete/Rename) |

## Gap table (Round 2 — fresh)
One row per distinct capability/finding. **Source** + **Severity** mandatory.

| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **Delete branch safety: unmerged-commit detection + restore** | `GitDeleteBranchOperation:104-139` detects `BRANCH_NOT_FULLY_MERGED` event, force-deletes, surfaces unmerged commits in notification with **Restore** action (recreates branch at deleted tip) + **View Commits** link | `BranchContextMenuCommands._handleDelete:789` calls `deleteBranch` (always force via `-D`), no unmerged detection, no restore affordance | ❌ missing | 🟠 high | git4idea | **Silent data-loss risk.** User deletes a branch with unique commits → no warning, no undo. IntelliJ stores `myDeletedBranchTips` and offers one-click restore. We'd need pre-delete `git branch --contains` check + tip-hash capture + create-from-SHA restore. Files: BranchOps.ts:247-259, BranchContextMenuCommands.ts:789-828 |
| **Delete remote branch** | `GitDeleteRemoteBranchOperation` runs `git push <remote> :refs/tags/<name>` (empty-src push syntax), multi-repo + rollback support | `BranchContextMenuCommands._handleDeleteRemote:2086` confirms (modal), parses `<remote>/<branch>`, runs `push({remote, branch: ':<branchName>'})` (empty-src delete), reloads + refreshes, errors via `sanitizeGitError` | ✅ parity | — | git4idea | **RESOLVED (re-verified 2026-06-21).** The earlier "dead handler / Not implemented" finding is stale — the handler now fully implements remote-branch deletion. Single-repo (git4idea's multi-repo orchestrator is richer, but out of single-repo scope). Files: BranchContextMenuCommands.ts:2086-2125 |
| **Track Remote Branch (set-upstream)** | `GitBranchWorker` (no dedicated file; implicit in checkout/pull ops) — when checking out a non-existent local from a remote ref, creates local + sets upstream atomically | `_handleCheckoutAsLocal:1892` calls `checkout(branchName, {forceCreate:true, track})` — creates/​resets the local to the remote tip **and sets upstream atomically** (plus an ahead-commit data-loss guard with Stash-and-reset). `_handleTrackRemote` handles the existing-local cases. | ✅ parity | — | git4idea | **RESOLVED (re-verified 2026-06-21).** The earlier "orphan local / no upstream" finding is stale — checkout-as-local now passes `track`, so upstream is set in one step. Files: BranchContextMenuCommands.ts:1892-1936 |
| **Branch not fully merged dialog** | `GitBranchIsNotFullyMergedDialog.java` shows unmerged-commit list + branches the local IS merged to ("safe to delete from X, Y") + Force/Cancel | Confirm uses generic `showWarningMessage` with OK/Cancel (BranchContextMenuCommands:809), no commit list, no merged-to hints | 🟡 partial | 🟡 medium | platform | **Polish + UX.** Our confirm works but IntelliJ's richer dialog reduces accidental force-deletes. Not a blocker (user CAN cancel), but daily-use polish. |
| **Branch popup: favorites section** | `GitBranchesPopupBase` top section = starred/favorited branches (persisted, user toggles ⭐) | `BranchPopup.ts:48-157` has `FAVORITE_BRANCHES_STATE_KEY` + `updateFavoritesList` + render logic → EXISTS but **no UI affordance to add/remove favorites** (context menu missing "Add to Favorites" / "Remove from Favorites") | 🟡 partial | 🟡 medium | git4idea | **Wired but incomplete.** Backend ready, UI missing. Would need branch context-menu additions + popup action buttons. Files: BranchPopup.ts:48-157, BranchContextMenuCommands (no favorite commands registered) |
| **Branch bulk operations (multi-select delete)** | `GitBranchesTreeActionsForSelectionTest` tests multi-select delete; UI supports Shift/Cmd-click → Delete Selected (N) | `BranchTreeProvider` is a TreeDataProvider (VS Code's single-select model); context menu acts on one `BranchTreeItem` | ❌ missing | 🟡 medium | platform | **Platform limitation + workaround gap.** VS Code TreeView doesn't natively support multi-select (2024 API). Workaround = shift TreeView to QuickPick with `canPickMany:true` OR add "Delete Multiple Branches…" palette command with checkbox picker. NORTHSTAR flagged this (P2). Not a blocker but daily-hit for cleanup workflows. |
| **Branch popup: in-popup fetch button** | `GitBranchPopupFetchAction` (header action) triggers fetch-all within the open popup, refreshes tree in place | `BranchPopup` (QuickPick-based) has no header actions; fetch is separate command (`intellig.fetch`) | ❌ missing | 🟡 medium | platform | **UX gap.** User must close popup → run Fetch → reopen popup. IntelliJ's one-click in-popup fetch is smoother. QuickPick API has `buttons` but they're item-level, not header-level. Would need custom webview or external fetch-then-reopen flow. |
| **Branch rename: unset upstream option** | `GitBranchWorker.renameBranchAndUnsetUpstream:171-176` optionally unsets tracking on rename (checkbox in dialog) | `BranchOps.renameBranch:289-305` runs `git branch -m oldName newName` only; upstream survives rename (git default). `NewBranchDialog` has no unset-upstream option | 🟡 partial | ⚪ polish | git4idea | **Minor UX.** Renamed branch keeps old upstream (often stale). IntelliJ offers "Unset tracked branch" checkbox. Workaround = manual unset after rename. Low priority (edge case). |
| **Branch comparison: split-log panel UI** | `GitCompareWithBranchPopup` + `GitLogUiImpl` renders two side-by-side commit lists (ahead/behind) in a resizable panel with live diff preview | `BranchComparisonView.ts` renders flat QuickPick item list (commits + files mixed) with no split layout | 🟡 partial | 🟡 medium | platform | **P4 platform-rebuild per NORTHSTAR.** Functional gap = low (data is correct, QuickPick shows it), but UX gap = medium (IntelliJ's split panel is clearer for large divergences). Files: BranchComparisonView.ts:1-end (QuickPick-based). Flagged in NORTHSTAR P4. |
| **Branch popup: auto-indent prefix grouping** | `GitBranchesClippedNamesCache` + tree renderer indent branches sharing `/` prefix (feature/, bugfix/) with 2-space indent when ≥3 siblings | `BranchPopup.detectIndentablePrefixes:164-181` + `formatBranchLabel:187-203` IMPLEMENTS THIS CORRECTLY | ✅ parity | — | git4idea | **No gap.** Verified correct: detects `/`-prefix groups ≥3, applies 2-space cosmetic indent, preserves raw name for filtering. Files: BranchPopup.ts:164-203 |
| **Branch rename validation** | `GitNewBranchNameValidator.java` checks ref-format rules (no `..`, `/` restrictions, control chars, `@{`, etc.) via `git check-ref-format --branch` | Extension.ts `_validateBranchName:1767-1796` hand-rolls regex `/^(?![-./])(?!.*[\\s~^:?*\\[]).+(?<![/.])$/` (rejects leading `-./`, trailing `/.`, whitespace/specials) but NEVER calls `git check-ref-format` | 🟡 partial | 🟡 medium | git4idea | **Validation drift risk.** Our regex is reasonable but git's rules are subtle (e.g. `..`, `@{`, lock-file collisions). IntelliJ delegates to git. If user bypasses UI (palette command with direct input), our BranchOps guards (`:93-94`, `:253-254`) only reject leading `-`/`.` → other invalid refs can reach git and error opaquely. **Recommendation:** Add `git check-ref-format --branch <name>` validation helper, use in both UI + Ops guards. Files: extension.ts:1767-1796, BranchOps.ts:93-94/253-254 |
| **Cherry-pick from branch: commit selector** | Right-click branch → "Cherry-Pick Commits…" opens commit-selection dialog (multi-select, range support, visual diff preview) scoped to that branch's log | `BranchContextMenuCommands._handleCherryPickCommits:898` calls `vscode.commands.executeCommand('intellig.log.cherryPick', { repo, ref: item.branch.name })` which opens log view pre-filtered to that branch (via `ILogOptions.ref`, landed in cf88c99) | ✅ parity | — | git4idea | **P1 gap CLOSED** per PROGRESS.md. Log view correctly scopes to clicked branch ref. Files: BranchContextMenuCommands.ts:898-910 (verified ref-passing) |
| **Branch context menu: ordering/grouping** | IntelliJ groups: [Checkout/New Branch from] / [Merge into Current/Rebase Current onto] / [Compare with Current/Show Diff] / [Update(pull)/Push] / [Rename/Delete] with separators | Our `package.json` command order matches registration order (alphabetical by ID within `intellig.branch.*` / `intellig.remoteBranch.*` namespace), no explicit separators | 🟡 partial | ⚪ polish | platform | **UX polish.** VS Code context menus respect registration order but have no separator API (2024). Workaround = careful ID naming to control sort (e.g. `intellig.branch.01checkout`, `intellig.branch.02newBranch`) but heavy-handed. Low priority (functional completeness matters more). NORTHSTAR flagged (P3). |
| **Checkout conflict: smart-checkout (stash/force/cancel)** | `GitCheckoutOperation` + `GitSmartOperationDialog` detects local changes that conflict with checkout target → modal "Stash and Checkout / Force Checkout / Cancel" (P1 #8 parity for reset, same pattern for checkout) | `BranchContextMenuCommands._handleCheckout:599-611` calls `checkout(ref, {force:false})` directly with no pre-check → git errors "Please commit or stash them" (error surfaced to user but no structured smart-checkout prompt) | 🟡 partial | 🟡 medium | git4idea | **UX gap** (same pattern as P1 #8 Smart Reset, already landed for reset 220dd7e). Checkout CAN fail-safe (git rejects, no data loss), but IntelliJ's structured prompt is smoother. Would extend Smart Reset pattern to checkout (pre-check dirty files, intersect with target diff, offer Stash/Force/Cancel). Files: BranchContextMenuCommands.ts:599-611. Lower priority than reset (checkout conflicts less frequent). |
| **Checkout-and-rebase: rebase leg autostash** | "Checkout and Rebase" (remote branch context menu) checks out local copy THEN rebases onto tracking remote; rebase leg uses `--autostash` (mirrors P1 #9 fix for plain rebase) | `BranchContextMenuCommands._handleCheckoutAndRebase:965` calls `checkout` then `rebaseBranch(repo, branch, options)` with `options=undefined` → **rebase leg DOES use `--autostash`** (BranchOps.rebaseBranch:401 unconditionally includes it) | ✅ parity | — | git4idea | **P1 #9 autostash applies to all rebase call-sites.** No gap. Files: BranchContextMenuCommands.ts:965-1039, BranchOps.ts:401 (flags = ['--autostash', ...]) |
| **Update (pull-with-rebase) on non-current branch** | `GitBranchPopupActions` "Update" action on non-HEAD branch: checks out → pulls → returns to original branch (3-step flow with smart-checkout on each leg) | `BranchContextMenuCommands._handleUpdate:1115` checks `if (repo.head?.name !== branch)` → `showErrorMessage("Checkout first")`, no auto-checkout | ❌ missing | 🟡 medium | git4idea | **Behavior gap.** User must manually checkout → update → checkout-back. IntelliJ does it atomically. Not a blocker (workaround exists) but daily-hit UX gap for updating feature branches. Files: BranchContextMenuCommands.ts:1115-1168 (error at :1123) |
| **Worktree lifecycle: remove / prune / refresh** | `Git.WorkingTrees.Remove` (`git worktree remove [--force]`), `Git.WorkingTrees.Prune` (`git worktree prune`), `Git.WorkingTrees.Refresh` — full teardown from the Working-Trees toolwindow | `WorktreeOps.ts` (`:170` `listWorktrees`, `:199` `addWorktree`) implements **create + list only**; `intellig.branch.{newWorktree,openWorktree}` are the only commands. No remove/prune/refresh op, command, or menu. | ❌ missing | 🟡 medium | git4idea | **Feature gap (2026-06-21 re-audit).** Create+open landed but teardown is unbuilt — user must drop worktrees via CLI. Add `WorktreeOps.{removeWorktree,pruneWorktrees}` (argv-guard the path) + commands + Working-Trees-tab/branch-tree menu. Files: WorktreeOps.ts:170-199 |

## Top findings (ranked, this component)

### 1. **Delete branch: no unmerged-commit detection + no restore** — _silent data-loss risk_
Parity weight: **correctness (high-value daily op) > missing feature**. Severity: 🟠 high. Source: git4idea. Effort: M.

**Why it matters:** IntelliJ's `GitDeleteBranchOperation` detects when a branch has commits not merged to its base (via `BRANCH_NOT_FULLY_MERGED` event listener on `git branch -d`), force-deletes with `-D`, stores the deleted tip hash, and surfaces a notification with **Restore** and **View Commits** actions. Our `_handleDelete` always uses `-D` (force) without pre-checking merge status, and we never capture the tip → **user accidentally deletes a feature branch with unique work, no undo, no warning beyond generic confirm.**

**Files to touch:**
- `BranchOps.ts:247-259` — `deleteBranch` signature grows `options?: { captureDeletedTip?: boolean }`, returns `Promise<{ deletedTip?: string }>`. Pre-delete: run `git branch --contains <name>` scoped to current branch to detect unmerged; if unmerged, capture `git rev-parse <name>` before delete.
- `BranchContextMenuCommands.ts:789-828` — `_handleDelete` calls new signature, shows richer confirm if unmerged ("Branch X has N unmerged commits. Force delete?"), on success offers "Undo Delete" button that calls `createBranch(deletedName, deletedTip)`.

IntelliJ reference: `GitDeleteBranchOperation.java:104-139` (unmerged detection), `:82-95` (tip capture), `:143-167` (restore notification action).

### 2. **Delete remote branch** — _RESOLVED (re-verified 2026-06-21)_
The earlier "dead handler / Not implemented" finding is **stale**. `_handleDeleteRemote`
(`BranchContextMenuCommands.ts:2086-2125`) now confirms (modal), parses `<remote>/<branch>`, runs
`push({remote, branch: ':<branchName>'})` (empty-src delete), reloads + refreshes the tree, and
sanitizes errors. No action needed; single-repo scope is intentional (git4idea's multi-repo
orchestrator is out of scope).

IntelliJ reference: `GitDeleteRemoteBranchOperation.java` (multi-repo orchestrator; our single-repo call is simpler).

### 3. **Branch validation: regex-only, never calls `git check-ref-format`** — _drift risk_
Parity weight: **correctness (validation bypass → opaque git errors)**. Severity: 🟡 medium. Source: git4idea. Effort: S.

**Why it matters:** Our `_validateBranchName` hand-rolls a reasonable but incomplete regex (rejects leading `-./`, trailing `/.`, whitespace). Git's ref rules are subtle: `..` (parent shorthand collision), `@{` (reflog syntax), lock-file clashes, etc. IntelliJ delegates to `git check-ref-format --branch <name>` (exit 0 = valid). If a user bypasses UI validation (e.g. palette command with direct input), our BranchOps guards only reject leading `-`/`.` → invalid refs like `foo..bar` or `baz@{1}` reach git and produce opaque errors.

**Files to touch:**
- `git-core/ops/BranchOps.ts` or new `git-core/refValidation.ts` — add `async validateRefFormat(repo, name): Promise<{ valid: boolean; error?: string }>` → runs `git check-ref-format --branch <name>` (exit 0 = valid, stderr = reason if invalid).
- `extension.ts:1767-1796` — `_validateBranchName` calls validator, returns git's error message if invalid.
- `BranchOps.ts:93-94, :253-254` — strengthen guards to call validator OR keep leading-`-`/`.` as a fast-path guard (argv injection) + rely on UI-side validation for the rest (git will still reject at exec time, just less friendly).

IntelliJ reference: `GitNewBranchNameValidator.java` → `check-ref-format --branch` call.

## Security review (this component)

**Argv injection — COMPREHENSIVE COVERAGE (no findings):**
- `BranchOps.ts` systematically uses `buildGitArgs(cmd, flags, refs)` to splice `--end-of-options` between flags and user-controlled refs (branch names, SHAs). Verified all 9 operations:
  - `createBranch:93-94` — leading `-`/`.` guard on name, `--end-of-options` before startPoint (:119, :135)
  - `checkout:202` — plain path uses buildGitArgs; `-b`/`-B` paths keep name adjacent (positional contract) + startpoint guard (:173)
  - `deleteBranch:253-254` — leading guard + buildGitArgs(:256)
  - `setBranchUpstream:278-282` — guards on both localName and upstreamRef, buildGitArgs(:284)
  - `renameBranch:295-299` — guards on both old and new, buildGitArgs(:301)
  - `mergeBranch:338` — buildGitArgs for branch ref
  - `rebaseBranch:405` — buildGitArgs for onto ref (with `--root` special-case empty-refs)
  - `compareBranches:587, :608, :621, :634` — buildGitArgs for all 4 ref combinations (count, ahead log, behind log, diff)

**Pattern is strong and consistent.** Only residual risk = the `-b`/`-B` positional-adjacency special-case (checkout:114, :176) where `--end-of-options` can't separate the flag from the name without breaking git's parser → mitigated by upstream `validateBranchName` (but see Finding #3 above re: incomplete regex).

**Credential leakage — CLEAN:**
- BranchOps returns only success/failure booleans, conflict file arrays, ahead/behind counts, commit objects (hashes + messages). No raw git stderr containing credential fragments.
- Error paths use `sanitizeGitError` (BranchOps.ts:378, :451) which strips `remote:` lines and URLs.

**Unsanitized toast surfaces — CLEAN:**
- BranchContextMenuCommands surfaces user-controlled branch names in toasts but VS Code's `showInformationMessage` / `showWarningMessage` API auto-escapes (no HTML interpretation). Example: `Switched to branch '${branchName}'` (:639) — safe.

**No CSP/webview holes in this component** (branch UI is TreeView + QuickPick, not webview).

## Blockers
**None (re-verified 2026-06-21).** The prior delete-remote blocker is resolved — `_handleDeleteRemote:2086`
implements the empty-src push delete end-to-end. Most context menu commands are wired end-to-end (verified
via test grep: `branchContextMenu.test.ts` exercises 18 handlers). Remaining items are UX gaps + the
worktree-teardown feature gap (table row), not blockers (workarounds exist).

## Test-seam architecture (TDD lens)

**Strong unit coverage observed:**
- `BranchOps.ts` — constructor takes `IGitOpsContext` (DI-friendly), no hard-coded cli/fs. All 9 operations have dedicated unit tests (GitServiceBranch.test.ts suite).
- `BranchContextMenuCommands.ts` — constructor takes services via params (DI). Test suite `branchContextMenu.test.ts` + 10 property tests (branchContextMenu*.property.test.ts) exercise handlers with mock services.
- **Test pyramid health — GOOD:** 20+ unit tests for branch ops (argv construction, merge/rebase result shapes), 10+ property tests (menu exclusion rules, label fidelity, error paths), 3 ext-host tests (activation + command registration). Minimal e2e reliance (branch ops are pure CLI, testable at unit tier).

**No test-seam gaps flagged.** Interfaces are clean; BranchOps is stateless; context-menu commands use injected services.

## Architectural debt / follow-ups

1. **Branch popup as QuickPick vs. IntelliJ's resizable tree widget** — P4 platform-rebuild per NORTHSTAR. Current QuickPick is functional but doesn't scale to 100+ branches (no scroll-position memory, no collapse/expand, no resizable width). IntelliJ's `GitBranchesTreeModel` is a platform JTree with state. VS Code equivalent = custom TreeView (but single-select limitation) OR custom webview (heavy). **Defer to P4.**

2. **Compare-with-current split-log UI** — P4 per NORTHSTAR. Current `BranchComparisonView` renders ahead/behind commits + files as a flat QuickPick list. IntelliJ's split panel (two side-by-side scrollable commit lists) is clearer. **Defer to P4.**

3. **Branch rename: upstream survives** — Minor UX (Finding #7 above). IntelliJ offers "Unset tracked branch" checkbox. Low priority (edge case, manual workaround exists).

4. **Smart-checkout prompt** — Same pattern as P1 #8 Smart Reset (landed 220dd7e). Checkout conflicts are less frequent than reset (user usually checks out clean branches), so lower priority. **Defer or backlog.**

5. **Validation drift** — Finding #3 above. Add `git check-ref-format --branch` validation helper. **Recommend next wave** (S effort, reduces opaque errors).

## Summary (exec brief for user)

**Branch component parity status: 🟢 GOOD — core ops solid, 0 blockers (both prior blockers resolved), residual UX polish**

**Top findings (2026-06-21 re-audit):**
1. 🟠 **Delete branch: no unmerged detection + no restore** (Finding #1) — silent data-loss risk. IntelliJ force-deletes WITH warning + undo; we force-delete blind. **M effort,** high daily-use value. _Still open._
2. ✅ **Delete remote branch** (Finding #2) — **RESOLVED**: `_handleDeleteRemote:2086` implements it (empty-src push delete + confirm + sanitize). Was stale.
3. 🟡 **Validation: regex-only, never calls `git check-ref-format`** (Finding #3) — drift risk, opaque errors on bypass. **S effort,** improves error UX.
4. ✅ **Track / checkout-as-local upstream** — **RESOLVED**: `_handleCheckoutAsLocal:1892` now passes `track`, setting upstream atomically. Was stale.

**R1 closed vs. open:**
- **CLOSED:** P1 #7 cherry-pick scoped to branch (cf88c99); delete-remote handler; checkout-as-local upstream
- **NOT IMPLEMENTED (intentional):** merged-branch cleanup — git4idea `Git.Cleanup.Branches` is `internal="true"`, so it is not a user-facing parity requirement; the orphaned `getMergedBranches` backend was removed
- **OPEN/PARTIAL:** delete-branch unmerged-restore safety (Finding #1), `check-ref-format` validation (Finding #3), Compare-with-current split UI (P4), bulk ops (P4), in-popup fetch (P4), menu ordering (P3)

**🔴 Blockers:** 0 (both prior blockers re-verified resolved in current source)
**Security:** CLEAN — argv injection systematically guarded, no credential leakage, no unsanitized surfaces

**Recommendation:** Queue Finding #1 (delete-branch unmerged safety) + Finding #3 (validation) for the next branch-focused wave (M+S combined = ~1 day). P4 UI rebuilds (popup tree, split-log) are multi-week efforts; defer per NORTHSTAR.
