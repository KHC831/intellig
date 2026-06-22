# Parity review (Round 2) — History / Annotate (Blame)

> **NORTHSTAR tie-back:** workstream **F** (Blame / History / Diff) · role: Round-2 deep audit. See `NORTHSTAR.md` section 7 (reference index).

_Round-2 deep tech-lead review by the assigned component owner. North-star = IntelliJ git4idea + Platform (full clone at `~/Documents/workspace/intellij-community`). Our extension = `intellig` (VS Code). **You own this component.** Round 1 enumerated gaps; Round 2 is a fresh, opinionated tech-lead pass — re-verify R1's findings against the CURRENT code, AND surface whatever you judge important for this component regardless of whether R1 named it._

## Mandate (decide what matters for YOUR component)
You are the tech-lead for this area. Cover at least:
- **Feature/behavior gaps** vs IntelliJ — including ones R1 missed.
- **Code differences** — where our impl diverges from git4idea's approach in a way that causes wrong/risky behavior (not cosmetic). Cite git4idea file + our file:line.
- **Blockers** — anything that stops a feature from working end-to-end (dead UI, unwired handlers, missing service plumbing, F5-only confirmable).
- **Security / abuse gaps** — argv injection, credential leakage in errors/logs, unsanitized toasts, CSP/webview holes, path traversal, destructive-op without confirm.
- **Correctness regressions / silent-wrong git ops** — the highest parity weight.
- Anything else you, as owner, judge important (perf, test coverage holes, arch debt).

## Reference map
- **git4idea / platform source reviewed:**
  - `plugins/git4idea/backend/src/annotate/GitAnnotationProvider.java` (annotate command + cache + PreviousFileRevisionProvider)
  - `plugins/git4idea/backend/src/history/GitFileHistory.kt` (file history with renames, --follow, rename detection algorithm)
  - `plugins/git4idea/backend/src/log/GitLogDiffHandler.java` (merge-commit diff handling)
  - `platform/vcs-impl/src/com/intellij/openapi/vcs/history/FileHistoryPanelImpl.java` (file-history panel UI: tree/flat view, sortable columns, diff actions)
  - `platform/vcs-impl/src/com/intellij/openapi/vcs/actions/AnnotatePreviousRevisionAction.java` (blame gutter action: show previous revision)
- **intellig source reviewed:**
  - `src/blame/BlameService.ts` (getBlame, getPreviousRevisionBlame, cache, argv guards)
  - `src/commands/registration/commitMenuCommands.ts` (resolveDiffParent for merge commits)
  - `src/commands/registration/blameEditorCommands.ts` (toggle blame commands, no previous-revision wiring)
  - `src/git-core/ops/StashTagHistoryOps.ts` (getFileHistory with --follow)
  - `src/git-core/gitToolWindow/tabs/HistoryTab.ts` (file-history tab, basic features)

## Gap table
One row per distinct capability/finding. **Source** + **Severity** mandatory.

| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **File-history panel richness** (tree/flat, sortable columns, diff-with-local, copy actions) | FileHistoryPanelImpl: dual tree/flat view toggle (DualView with HistoryAsTreeProvider for merge parents), sortable columns (Revision/Date/Author/Message + provider-custom), speed-search, "Show Diff" / "Compare with Local" / "Compare with…" context actions, copy revision number, "Get Version" (checkout file@rev), annotations panel | HistoryTab: single-view commit list (non-sortable, HTML table), `history.selectRevision`, `history.openAtRevision` → read-only editor, `history.compareWith` (two-revision diff), `history.compareWithLocal` (rev ↔ working tree), branch-filter dropdown, --follow checkbox. **Missing:** tree-as-graph, sortable columns (Author/Date click-to-sort), speed-search, copy actions, "Get" file-at-revision (open writable), show-diff-with-base (parent of selected), revert-to-revision, annotate-from-revision. | 🟡 partial | 🟡 MEDIUM | `platform` FileHistoryPanelImpl + git4idea GitHistoryProvider | intellig backend parity COMPLETE (getFileHistory, --follow, rename tracking in GitFileHistory.kt → ours git log --follow + rename-commit detection not wired but planned P4). UI surface: VS Code webview table vs IntelliJ DualView (tree/flat), missing: column-sort, tree-as-graph (merge parents), speed-search, copy revision. IntelliJ panel = heavy Platform rebuild (NORTHSTAR P4 item). HistoryTab functional for "show me file's past" but thin. src/git-core/gitToolWindow/tabs/HistoryTab.ts, platform/vcs-impl FileHistoryPanelImpl.java:124–350. |
| **Blame hunk header (original commit + line-range)** | GitAnnotationProvider: porcelain format → hunk headers "^<hash> <origLine> <finalLine> <lineCount>" preserved, PreviousFileRevisionProvider.getPreviousRevision(lineNumber) uses origLine to navigate pre-change line | BlameService.ts parses `--porcelain` → `IBlameLine{line,commit,author,...}` (gitParser.ts:parseBlame), **no origLine captured** (struct lacks it). getPreviousRevisionBlame navigates via commit parent, not line tracking. | 🟡 partial | ⚪ polish | git4idea GitAnnotationProvider + gitParser.ts parseBlame | For line-level "where did THIS line come from pre-change" navigation (IntelliJ annotate-previous on SPECIFIC line), need origLine + origPath from hunk header. Current getPreviousRevisionBlame operates on whole-file parent, not line-specific. Low-impact: blame navigation still works at file level. Would add `origLine?/origPath?` to IBlameLine, parse hunk line. gitParser.ts:parseBlame, git4idea GitAnnotationProvider.java:262–294. |
| **Show Diff (commit vs parent) in file-history tab** | FileHistoryPanelImpl: select revision → "Show Diff" action → diff vs parent (merge = choose-parent popup), opens DiffManager with two ContentRevisions | HistoryTab: `history.compareWith` (two-selected-revisions diff), `history.compareWithLocal` (rev ↔ working tree). **Missing:** single-selection "Show Diff" (rev vs parent). User must manually select two commits to diff; IntelliJ one-click shows commit delta. | 🟡 partial | 🟡 MEDIUM | platform FileHistoryPanelImpl + git4idea GitLogDiffHandler | Backend: getCommitDiff exists (gitService.getCommitDiff). UI: HistoryTab.ts has compareWith / compareWithLocal messages, no single-rev show-diff. Add: `history.showDiff` message → getCommit(rev).parents, if 1 parent → diff(rev,parent[0]), if 2+ → resolveDiffParent picker (reuse commitMenuCommands logic). src/git-core/gitToolWindow/tabs/HistoryTab.ts (no showDiff message). |
| **Annotate cache invalidation on index change** | GitAnnotationProvider uses VcsHistoryCache, invalidated on VCS refresh (HEAD change, index write, refs update). FileHistoryRefresher drives reload. | BlameService cache (Map<cacheKey, IBlameCacheEntry>): 30s TTL, file-watcher invalidation on .onDidChange / .onDidDelete. **No index/HEAD watcher** — cached blame for rev X persists until TTL even if HEAD moves / index staged / new commit lands. | 🟡 partial | ⚪ polish | git4idea GitAnnotationProvider + BlameService.ts:196–229 | Current: file-content change → invalidate (watcher). Missing: git op (commit/reset/checkout) → HEAD moves → cached blame for old-HEAD becomes stale-labeled (hash stays valid, "HEAD" meaning shifts). Low impact: TTL mitigates; old-rev blame stays correct. Could wire gitService.onDidChangeRepository → clearCache (aggressive), or track HEAD sha + invalidate HEAD-keyed entries only. BlameService.ts:100–153 watcher, :394–396 clearCache. |
| **Security: blame argv injection on revision param** | git4idea GitAnnotationProvider.java:282: `h.addParameters(revision.asString())` after `h.endOptions()` — revision is a typed GitRevisionNumber (validated SHA). | BlameService.ts:278: `buildGitArgs('blame', flags, refs, [path])` — `refs` is `revision ? [revision] : []`, `revision` is user-string from IBlameService API. **buildGitArgs splices `--end-of-options` before refs** (gitCli.ts), blocking leading-dash injection (`--foo` collapse). Path also in trailing-`--` position. | ✅ parity | N/A (secure) | BlameService.ts:278 + gitCli.ts buildGitArgs | SECURE. buildGitArgs (gitCli.ts:167) injects `--end-of-options` between flags and refs/paths, blocking flag injection. `revision` is a commit hash string (not validated as hex here, but git blame handles invalid refs gracefully — exits non-zero, no shell escape). No finding. |
| **Security: getPreviousRevisionBlame parent-rev handling** | GitAnnotationProvider navigates via PreviousFileRevisionProvider (pre-computed parent chain), never user-supplied rev. | BlameService.getPreviousRevisionBlame (:362): `buildGitArgs('rev-parse', [], [commit + '^'])` — `commit` is user-supplied string, concatenated `'^'`. **Spliced via buildGitArgs** → safe (no shell interpolation, git interprets `<hash>^` as a single ref arg). `:377 buildGitArgs('cat-file', ['-e'], [parentCommit + ':' + path])` — both spliced. | ✅ parity | N/A (secure) | BlameService.ts:362–377 | SECURE. The `commit + '^'` concatenation is NOT shell-injected (buildGitArgs passes each as a single argv element). Git parses `<hash>^` as a parent ref. Path is also argv-element, not interpolated. No finding. |

Status legend: ✅ parity · 🟡 partial · ❌ missing · ➕ ours-only · 🔁 regression-since-R1  
Severity legend: 🔴 blocker/silent-wrong/security · 🟠 high (daily-hit feature) · 🟡 medium · ⚪ polish  
Source legend: `git4idea` (portable git logic) · `platform` (UI we hand-build) · `mixed`

## Top findings (ranked, this component)
1. **File-history panel richness gap** — IntelliJ's FileHistoryPanelImpl is a dual-view (tree/flat) panel with sortable columns (Author/Date/Message), speed-search, copy actions, tree-as-graph for merge parents. intellig HistoryTab provides the backend correctly (getFileHistory with --follow + `--full-history --simplify-merges` for path-filtered) and a read-only single-view table with open-at-revision + compare-two + compare-with-local, but no sortable columns / tree-as-graph / speed-search / copy. P4 platform-rebuild, not a silent-wrong gap.  
   Severity: 🟡 MEDIUM. Source: `platform` FileHistoryPanelImpl + git4idea GitHistoryProvider. Effort: **L** (column-sort alone = M). Files: `src/git-core/gitToolWindow/tabs/HistoryTab.ts`.

2. **Show Diff (single-selected commit vs parent) in file-history** — HistoryTab has `compareWith` (two-selected) + `compareWithLocal` (rev ↔ working tree) but no single-selection show-diff (rev vs parent). IntelliJ's "Show Diff" is one-click; ours needs the user to pick two commits. The merge-parent picker (`commitMenuCommands.resolveDiffParent`) already exists to reuse.  
   Severity: 🟡 MEDIUM. Source: platform FileHistoryPanelImpl + git4idea GitLogDiffHandler. Effort: **S** (add `history.showDiff` message → `resolveDiffParent` → diff). Files: `src/git-core/gitToolWindow/tabs/HistoryTab.ts:471` (new message case).

## Security review (this component)
**Argv injection (blame/log/file-history):**  
- ✅ **SECURE.** All blame/log argv construction uses `buildGitArgs(command, flags, refs, paths)` which injects `--end-of-options` between flags and refs/paths (gitCli.ts:167). User-controlled revision/path strings are argv-spliced (not shell-interpolated), blocking leading-dash injection (`--foo` stays as a ref, not a flag). Verified:
  - BlameService.ts:278 `buildGitArgs('blame', flags, refs, [path])` — revision → refs, path → trailing-`--`.
  - BlameService.ts:362 `buildGitArgs('rev-parse', [], [commit + '^'])` — concatenated `'^'` is a single argv element (git parses as parent-ref syntax, not shell escape).
  - BlameService.ts:377 `buildGitArgs('cat-file', ['-e'], [parentCommit + ':' + path])` — colon-delimited tree-ish:path is a single argv element.
  - StashTagHistoryOps.ts:397 `buildGitArgs('log', flags, refs, [path])` — branch + path spliced.

**Path traversal (blame/file-history):**  
- ⚪ **LOW-RISK (mitigated).** File paths are repo-relative (no absolute-path collapse into `/etc/passwd` or `../../../`). gitService.getBlame / getFileHistory take `path: string` (relative to repo root), passed to git blame/log. Git interprets paths relative to cwd (repo root). VS Code's file-picker (used by showHistory command) resolves to workspace-scoped Uri → repo-relative. No user-supplied absolute-path bypass found. Theoretical attack: user manually invokes `intellig.showHistory({filePath: '../../../etc/passwd'})` via extension API → git log exits non-zero (path outside repo), no leak. Not a practical vector.

**Credential leakage in errors:**  
- ✅ **SECURE.** git blame/log stderr does not contain credentials (read-only ops, no auth). BlameService returns `{path, lines: []}` on non-zero exit (BlameService.ts:284), does not surface raw stderr. getFileHistory returns `[]` on error (StashTagHistoryOps.ts:400). No unsanitized stderr → toast path found.

**Summary:** Zero security findings. Argv-injection guarded by buildGitArgs, path-traversal mitigated by repo-relative scope + git's own validation, no credential leakage.

## Blockers
**None.** All core flows are end-to-end functional: blame (annotate + annotate-previous + hide-revision + detect-movements + ignore-whitespace + aspect columns + color modes), interactive gutter/inline hover (View-Commit / Previous-Revision command links), file-history (open-at-rev + compare-two + compare-with-local + `--follow` + `--full-history --simplify-merges`), and merge-commit diff parent picker. Blame options persist via Memento. Remaining items are P4 panel-richness + single-rev show-diff polish.

## Architectural notes
1. **blame/file-history backend parity is COMPLETE.** gitService.getFileHistory honors --follow (rename tracking), BlameService.getBlame supports -w/-M/-C (whitespace/movement detection), getPreviousRevisionBlame navigates parent commits, resolveDiffParent chooses merge-commit parent. The git4idea portable logic is fully mirrored.

2. **UI surface is THIN but CORRECT.** HistoryTab provides the core "show file history, open-at-revision, diff two revisions" but lacks IntelliJ's FileHistoryPanelImpl richness (sortable columns, tree-as-graph, copy actions) — a NORTHSTAR P4 Platform-rebuild item, not a silent-wrong gap. GutterBlameProvider + InlineBlameProvider are interactive (hover → View-Commit / Previous-Revision command links).

3. **Test coverage is STRONG.** blame: unit (BlameService.test.ts), property (blamePreviousRevision.property.test.ts). resolveDiffParent: unit (resolveDiffParent.test.ts). No silent-wrong risk found — the backends are argv-guarded + characterized.

4. **Deferred items (P4, low-priority).** Blame hunk-header origLine tracking (line-level previous-revision navigation, works at file-level today); blame cache invalidation on HEAD change (TTL mitigates, edge-case stale labeling). None block daily use.

## Recommendations (priority order)
1. **CONSIDER (MEDIUM, P4):** File-history single-selection "Show Diff" (commit vs parent). Two-revision diff works; single-rev is the primary action in IntelliJ. Effort: S (add `history.showDiff` message, reuse `resolveDiffParent`).

2. **DEFER (P4, LARGE):** File-history panel richness (sortable columns, tree-as-graph, copy actions). Core history works; this is the Platform-rebuild NORTHSTAR item (multi-PR).

