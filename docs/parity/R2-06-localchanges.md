# Parity review (Round 2) — Local changes (stash/shelf/changelists/staging)

_Round-2 deep review by tech-lead owner. North-star = IntelliJ git4idea + platform/vcs-impl (full clone at `~/Documents/workspace/intellij-community`)._

**Component scope:** stash (apply/pop --index, create, drop, rename, branch), shelf (patch-file management), changelists (local grouping), staging/unstaging hunks, revert/discard hunk, add-to-gitignore, commit-template support.

## Reference map
- **git4idea / platform source reviewed:**
  - `plugins/git4idea/backend/src/stash/GitStashUtils.kt` (lines 165-424: `reinstateIndex` parameter, `createUnstashHandler`)
  - `plugins/git4idea/backend/src/ignore/actions/GitIgnoreFileActionGroup.kt` (line 10: root-relative pattern generation)
  - `platform/vcs-impl/src/com/intellij/openapi/vcs/changes/shelf/ShelveChangesManager.java` (lines 1-200: shelf vs stash semantics — patch-file storage vs git-stash)
  - `platform/vcs-impl/src/com/intellij/openapi/vcs/changes/ChangeList*.java` (changelist framework — grouping, active changelist tracking)

- **intellig source reviewed:**
  - `src/git-core/ops/StashTagHistoryOps.ts` (lines 80-98: `stashApply`/`stashPop` with `--index` flag)
  - `src/git-core/ops/StagingOps.ts` (lines 48-127: `stageHunk`, `unstageHunk`, `revertHunk` = `git apply -R` without `--cached`)
  - `src/commands/registration/explorerCommands.ts` (lines 61-101, 500-550: `gitignorePatternFor`, `buildGitignoreAppendContent`, `addToGitignore` command)
  - `src/commits/CommitDialog.ts` (lines 496, 884, 1348, 1978: revert-hunk button wiring + dispatch)
  - `src/changelists/ChangelistService.ts` (lines 1-97: v2 storage format with `description` + `activeChangelistId`)
  - `src/shelf/ShelfService.ts`, `src/shelf/ShelfView.ts`, `src/shelf/StashView.ts`
  - `src/test/unit/git-core/stashReinstateIndex.test.ts` (lines 39-48: TDD tests for `--index` on apply/pop)

## R1 follow-up (verify each prior finding against current code)
| R1 gap | R1 status | Current status (re-verified) | Commit that closed it (if any) | Notes |
|---|---|---|---|---|
| P1 #1: stash apply/pop drops `--index` — staged work returns unstaged (silent-wrong) | R1: ❌ missing | ✅ **CLOSED** | 075b3d4 (2026-06-14) | `StashTagHistoryOps.ts:84,93` both pass `--index`; IntelliJ parity (`GitStashUtils.kt:415-417` `if (reinstateIndex) h.addParameters("--index")`). TDD tests `stashReinstateIndex.test.ts` verify staged→staged round-trip. |
| P2: revert (discard) working-tree hunk — IntelliJ "Revert Chunk" | R1: 🟡 partial (can unstage, can't discard) | ✅ **CLOSED** | c7e458a (2026-06-14) | `StagingOps.ts:118-127` implements `revertHunk` = `git apply -R` (no `--cached`) matching IntelliJ's working-tree discard. `CommitDialog.ts:1348` button wired on unstaged hunks + modal confirm. TDD tests. |
| P2: Add to .gitignore — IntelliJ GitIgnoreFileActionGroup | R1: ❌ missing | ✅ **CLOSED** | 3d9c3c4 (2026-06-14) | `explorerCommands.ts:70-79` `gitignorePatternFor` generates root-relative `/path` pattern (IntelliJ parity), `buildGitignoreAppendContent` idempotent append, `intellig.explorer.addToGitignore` command. 10 TDD tests. |

## Gap table (Round 2 — fresh)
| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **Stash --index reinstate UI** | `GitUnstashDialog.java` offers "Reinstate index" checkbox (3-state: off/on/disabled-on-branch-stash); user-controlled per-operation | Backend `stashApply`/`stashPop` ALWAYS pass `--index` (no UI control); StashView calls them unconditionally | 🟡 partial | 🟡 medium | `git4idea` + `platform` | Backend correct (P1 #1 closed); missing UI affordance to disable --index. Low-priority (default-on is safer; advanced users can palette if needed). StashView.ts:293,362. |
| **Stash rename** | `GitStashUtils.kt:137-183` 3-step sequence (`rev-parse` → `stash store -m` → `drop stash@{index+1}`) with best-effort rollback on drop failure | Implemented identically at `StashTagHistoryOps.ts:137-183`; same 3-step + rollback + index validation | ✅ parity | ⚪ polish | `git4idea` | Byte-for-byte logic match. No gap. |
| **Stash branch** | `git stash branch <name> stash@{index}` creates branch rooted at stash commit + applies stash | Implemented at `StashTagHistoryOps.ts:113-123`; validates branch name + index | ✅ parity | ⚪ polish | `git4idea` | No gap. |
| **Shelf vs stash semantics** | Shelf = patch-file storage in `<project>/.idea/shelf/*.patch` (VCS-agnostic, survives stash-clear, multi-file selective unshelve); Stash = git-stash stack (VCS-coupled, LIFO, all-or-nothing apply) | `ShelfService.ts` manages patch files in `.git/intellig-shelf/`; `StashView.ts` wraps git-stash. Both exposed in Commit Tool Window shelf/stash tabs | ✅ parity | ⚪ polish | `platform/vcs-impl` | Semantic separation preserved; patch files survive `git stash clear`. Shelf UI on par with IntelliJ. |
| **Commit template support** | `git config commit.template` auto-fills commit message composer | NOT implemented; no check for `commit.template` config when opening CommitDialog | ❌ missing | 🟡 medium | `platform` + `git4idea` | Low daily-hit (teams standardize via hooks/CI, not local templates). Would check `git config --get commit.template` → read file → prefill `CommitDialog._message`. Effort: S (1 config read + 1 fs.readFileSync). |
| **Changelist "description" field** | IntelliJ `ChangeList` has optional multi-line description separate from name | `ChangelistService.ts:87` storage v2 includes `description?: string`; field persisted but NO UI to edit it (neither ChangelistView nor any command surface it) | 🟡 partial | 🟡 medium | `platform/vcs-api` | Backend storage ready (v2 format); missing UI edit affordance. Description would appear in changelist tooltip/details pane. Effort: M (UI form + update command). |
| **Shelf "restore to" changelist picker** | Unshelve dialog lets user pick target changelist (create-new / select-existing) | ShelfView applies to active changelist only; no picker | 🟡 partial | 🟡 medium | `platform/vcs-impl` | Lower priority (active-changelist is the 90% case; power users can switch active first). Effort: M (picker dialog). |
| **Stash partial (file-subset) stash** | `GitStashUtils.kt:441-457` `createStashHandler` accepts `files: Collection<FilePath>`; uses `--pathspec-from-file=-` (git 2.25+) or `--` positional | `StashTagHistoryOps.ts:35-50` `stash()` always operates on full tree (no `files` parameter, no pathspec handling) | 🟡 partial | 🟡 medium | `git4idea` | Effort: M (add `files?: string[]` param + buildGitArgs pathspec tail). Blocked-by: UI to select file subset in StashView. |
| **Hunk patch generation path escaping** | IntelliJ escapes special chars in patch diff headers (`a/path` / `b/path` lines); git's patch format is ambiguous for paths with spaces/tabs/newlines | `StagingOps.ts:172-194` `generateHunkPatch` writes raw `diff --git a/${path} b/${path}` with NO escaping; a file path containing newline would corrupt the patch (silent-wrong: git apply reads up to the first literal newline as the full diff header, then misparses the rest as hunk content) | 🔴 blocker | 🔴 blocker/silent-wrong | `git4idea` | **CRITICAL correctness gap.** Rare in practice (newline in filename), but when hit = silent data corruption (apply stages wrong bytes). Fix: escape path per git patch spec (quote + C-escape if path contains space/tab/newline). `UnifiedDiffWriter.java` reference. Effort: S (1-line helper `escapePatchPath`). Affects `generateHunkPatch` + `generateLinesPatch`. |
| **Revert-hunk patch stdin injection** | `git apply -R` reads patch from stdin (`-`); patch content is user-controlled (diff lines are commit content) | `StagingOps.ts:118-126` `revertHunk` passes `input: patch` where `patch = generateHunkPatch(path, hunk)` and `hunk.lines[].content` is parsed from `git diff` output (untrusted). Git's patch parser is robust (no shell interpolation, no exec), but malformed input could cause git apply to error/misbehave | ✅ safe | ⚪ polish | security | **Reviewed: no injection.** Git patch format is line-based + positional; `git apply` parses binary-safe. `hunk.lines[].content` is raw bytes from diff (no user input path). Stdin bypasses shell. No risk. |
| **Gitignore pattern path-traversal** | IntelliJ writes root-relative pattern anchored with `/` (e.g., `/src/file.ts`); rejects if file is outside repo | `explorerCommands.ts:70-79` `gitignorePatternFor` returns `undefined` if `!fileFsPath.startsWith(repoRoot + '/')` → caller never writes `../` escape pattern | ✅ safe | ⚪ polish | security | **Reviewed: no path-traversal.** Line 74-76 prefix check blocks outside-repo files; pattern is always `/relative-path` (anchored to root). Idempotent check (line 94-95) prevents duplicate append. Pure functions (no fs side-effects in helpers). |
| **Gitignore leading-dash guard** | Git treats `.gitignore` lines starting with `-` as invalid (not a CLI concern, but malformed pattern) | Pattern from `gitignorePatternFor` always starts with `/` → no leading-dash risk | ✅ safe | ⚪ polish | security | No gap; design prevents it. |
| **Staged-state loss on revert-hunk** | IntelliJ's "Revert Chunk" operates only on working-tree (no index touch); if same hunk is staged, the index keeps the old change → on commit, the reverted change reappears (silent-wrong: user thinks they discarded it) | `StagingOps.ts:118` `revertHunk` uses `git apply -R` (no `--cached`) → working-tree only; IF file has staged hunks overlapping the reverted one, commit captures pre-revert state | 🟡 partial | 🟠 high | `git4idea` correctness | **Design gap (not impl bug).** IntelliJ same behavior (revert-chunk is working-tree-only). Mitigation: CommitDialog only shows revert button on UNSTAGED hunks (line 1348 conditional); if hunk is staged, button absent → user can't accidentally revert + leave index stale. Residual risk: user reverts unstaged, THEN stages same file → stale index. Full fix = revert BOTH index + working tree (two-step `git apply -R --cached; git apply -R`). Severity: HIGH (data-loss class — user expects discard, gets ghost-commit). Effort: M (detect staged state + two-step apply; or block revert when file has ANY staged hunks). |

## Top findings (ranked, this component)

1. **🔴 BLOCKER: Hunk patch path escaping missing (newline/tab/space in filename corrupts patch)**
   - **Why it matters:** File path with newline → `generateHunkPatch` emits malformed diff header → `git apply` misparses → stages wrong bytes (silent data corruption). Rare but critical.
   - **Severity:** 🔴 blocker/silent-wrong. **Source:** `git4idea` (UnifiedDiffWriter.java). **Effort:** S (1 helper fn).
   - **Files to touch:** `src/git-core/ops/StagingOps.ts` (lines 172-194 `generateHunkPatch` + 207-288 `generateLinesPatch`). Add `escapePatchPath(path: string): string` per git patch spec (quote + C-escape if contains special chars).

2. **🟠 HIGH: Revert-hunk on file with staged hunks → ghost-commit (staged state survives revert)**
   - **Why it matters:** User reverts working-tree hunk, sees file clean, stages file later → commit captures pre-revert change (silent data-loss surprise). IntelliJ has same gap, BUT we can do better (two-step revert or block when ANY staged hunks present).
   - **Severity:** 🟠 high (correctness/data-loss). **Source:** `git4idea` design + our button placement. **Effort:** M.
   - **Files to touch:** `src/git-core/ops/StagingOps.ts:118-127` (extend `revertHunk` to clear index for the same hunk), OR `src/commits/CommitDialog.ts:1348` (suppress revert button if file has ANY staged hunks, not just the clicked hunk).

3. **🟡 MEDIUM: Commit template support missing**
   - **Why it matters:** Teams using `git config commit.template` (commit msg boilerplate, ticket-ID template) get no prefill in CommitDialog → manual copy-paste every commit. Parity gap.
   - **Severity:** 🟡 medium (daily-hit for affected teams). **Source:** `platform` + `git4idea`. **Effort:** S.
   - **Files to touch:** `src/commits/CommitDialog.ts` constructor — read `git config --get commit.template` → `fs.readFileSync` → prefill `_message` if empty.

## Security review (this component)

**Reviewed surfaces:**
- ✅ `git apply -R` stdin (revertHunk): NO injection — patch content is parsed git diff output (untrusted but binary-safe), stdin bypasses shell, no exec path.
- ✅ Gitignore pattern generation: NO path-traversal — `gitignorePatternFor` rejects outside-repo files (line 74), pattern always `/anchored`.
- ✅ Leading-dash guards: tag/branch name guards (existing) + gitignore design (always `/` prefix) prevent CLI-flag injection.
- ✅ Stash index validation: `_validateStashIndex` (lines 74-78) blocks non-integer/negative → no `stash@{NaN}` malformed refs.

**One finding:**
- 🔴 **BLOCKER (silent-wrong, not security):** Hunk patch path escaping gap (see Top Finding #1). Newline in filename → malformed patch → wrong staging. Fix: quote + C-escape per git patch spec.

**Verdict:** No security holes (argv injection / credential leakage / CSP). One silent-wrong correctness gap (path escaping).

## Blockers

| Blocker | Status | Notes |
|---|---|---|
| P1 #1 stash --index (silent-wrong: staged→unstaged) | ✅ **CLOSED** (075b3d4) | Backend fixed; TDD-covered. |
| P2 revert-hunk (missing feature) | ✅ **CLOSED** (c7e458a) | Implemented + button wired + TDD. |
| P2 add-to-gitignore (missing feature) | ✅ **CLOSED** (3d9c3c4) | Implemented + TDD. |
| 🔴 Hunk patch path escaping (silent-wrong newline case) | ❌ **OPEN — blocks production use for repos with special-char filenames** | Rare but critical; must fix before declaring parity complete. |
| 🟠 Revert-hunk staged-state ghost-commit | 🟡 **PARTIAL-SAFE** | Button only shown on unstaged hunks (line 1348) → user can't click on staged; BUT user can revert unstaged THEN stage same file → residual ghost-commit risk. Recommend: block revert if file has ANY staged hunks. |

## Overall assessment (Round 2)

**Parity health: 🟡 GOOD with 1 CRITICAL and 1 HIGH finding.**

**Strengths (vs R1):**
- P1 #1 (stash --index) CLOSED — backend correct, TDD-verified. IntelliJ byte-for-byte parity on the git argv.
- P2 revert-hunk CLOSED — `git apply -R` without `--cached` is the correct design; button wired + modal confirm; 5 TDD tests.
- P2 add-to-gitignore CLOSED — pattern generation matches IntelliJ (root-relative anchored `/`); idempotent append; 10 TDD tests.
- Shelf/stash semantic separation preserved (patch-file vs git-stash stack).
- Changelist v2 storage format forward-compatible (description field ready, even if UI missing).
- Security audit CLEAN — no argv injection, no path-traversal, no credential leakage.

**Critical gaps:**
1. 🔴 **Hunk patch path escaping** — newline in filename → malformed patch → wrong staging. MUST FIX (S effort).
2. 🟠 **Revert-hunk staged-state ghost-commit** — residual risk even with button placement guard. Should block revert when file has staged hunks (M effort).

**Medium polish gaps:**
- Commit template support (low daily-hit, but easy win — S effort).
- Changelist description UI (storage ready, no edit affordance).
- Stash --index UI toggle (backend always-on is safer, but power users might want control).
- Shelf "restore to changelist" picker (active-changelist-only is 90% case, acceptable).
- Stash partial (file-subset) — backend missing, low priority.

**Recommendation:**
- **Immediate:** Fix #1 (path escaping) — blocker for repos with special-char filenames.
- **High-priority:** Address #2 (staged-state ghost-commit) — choose between two-step revert OR suppress-button-when-file-staged.
- **P3/P4:** Commit template + changelist description UI + stash --index toggle (polish tier, not blockers).

**Test coverage:**
- TDD discipline excellent: P1 #1 (2 tests), P2 revert-hunk (5 tests), P2 gitignore (10 tests) all red-first.
- Property tests cover stash round-trip invariants (`stashRoundTrip.property.test.ts`).
- NO tests for the path-escaping gap (would need fixture with newline-in-filename — rare but necessary).

**Dogfood note:**
Per PROGRESS.md line 26, "live click wants one F5" — revert-hunk button interaction NOT yet F5-confirmed end-to-end. Should verify: click → modal → confirm → working tree reverted → file clean in SCM view. Backend argv unit-locked, but real-git round-trip still needed.
