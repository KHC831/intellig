# IntelliG Dialogs UX Parity Review (Round 2)

> **NORTHSTAR tie-back:** cross-cutting **UI/UX layout** — dialogs · role: Round-2 UX audit (backs NORTHSTAR section 4b). See `NORTHSTAR.md` section 7 (reference index).

**Date**: 2026-06-15
**Scope**: Visual/UX parity of IntelliG dialogs vs IntelliJ git4idea dialogs
**Review Type**: Layout, field order, labels, defaults, button naming, validation messaging

---

## Reference Mapping (IntelliJ → IntelliG)

| IntelliJ Dialog | IntelliG Dialog | IntelliJ Path | IntelliG Path |
|---|---|---|---|
| (Commit in CheckinEnvironment) | CommitDialog | platform/vcs-impl | src/commits/CommitDialog.ts |
| GitPushDialog | PushDialog | git4idea/backend/src/push/ | src/sync/PushDialog.ts |
| GitPullDialog | PullDialog | git4idea/backend/src/pull/GitPullDialog.kt | src/sync/PullDialog.ts |
| GitRebaseDialog | RebaseDialog | git4idea/backend/src/rebase/GitRebaseDialog.kt | src/rebase/RebaseDialog.ts |
| GitResetDialog | ResetDialog | git4idea/backend/src/ui/GitResetDialog.java | src/ui-shell/ResetDialog.ts |
| GitMergeDialog | MergeDialog | git4idea/backend/src/merge/GitMergeDialog.kt | src/conflicts/MergeDialog.ts |
| GitTagDialog | New Tag flow | git4idea/backend/src/ui/GitTagDialog.java | src/commands/registration/commitHelpers.ts |

---

## Per-Dialog UX Gap Analysis

### 1. Commit Dialog

| Element | IntelliJ | Ours (CommitDialog.ts) | Status | Severity | Notes |
|---|---|---|---|---|
| Dialog structure | Platform CheckinDialog (complex tree view + diff panel + commit panel) | Webview: 2-column (left=message+files, right=diff) | ⚠ Different | 🟡 MEDIUM | IntelliJ uses platform CheckinDialog with ChangesTree; ours is custom webview. Functional parity achieved with different architecture. |
| Message textarea | Top of checkin panel, focus on open | Top-left panel, focus on open | ✅ Match | ⚪ | Both default-focus to message field |
| Author override | N/A (IntelliJ stores author in VCS settings globally) | Below message, labeled "Author (optional):" | ❌ Extra | 🟡 MEDIUM | We added an author override field that IntelliJ doesn't surface in the dialog. Useful feature but breaks parity. |
| Recent messages | "History" button → picker | "∨" button → QuickPick | ⚠ Different | 🟡 MEDIUM | Same concept, different icon. IntelliJ shows a dedicated history icon; ours uses a dropdown glyph. |
| Gear menu | Platform-level commit options button | "⚙" button → QuickPick with --no-verify + stubs | ⚠ Different | 🟡 MEDIUM | We expose --no-verify in the gear menu; IntelliJ has richer commit-options panel (run inspections, reformat, optimize imports). Our stubs are placeholders. |
| --no-verify badge | No visible badge while off | Visible warning badge when ON: "⚠ Git hooks will be skipped..." | ❌ Extra | ⚪ | Our badge is safety-positive; IntelliJ doesn't show equivalent warning. Good defensive UX. |
| File list grouping | "Changes" tree with checkboxes (ChangesTreeList) | "Staged Changes" + "Unstaged Changes" groups | ⚠ Different | 🟡 MEDIUM | IntelliJ's platform tree is more powerful (unversioned, changelists). Ours is git-specific staging split. |
| Amend checkbox | In bottom options toolbar | In footer options-section | ✅ Match | ⚪ | Placement slightly different but equivalent visibility |
| Sign-off checkbox | In bottom options toolbar | In footer options-section | ✅ Match | ⚪ | Same |
| Commit button label | "Commit" (or "Commit and Push" dropdown) | "Commit" or "Commit (Amend)" (+ file count) | ⚠ Different | 🟡 MEDIUM | IntelliJ shows dropdown for Commit+Push; ours shows file count. Different UX priorities. |
| Diff preview controls | Toolbar with hunk stage/unstage buttons | Per-hunk inline "+ Stage Hunk" / "− Unstage Hunk" / "↶ Revert Hunk" buttons | ⚠ Different | 🟡 MEDIUM | IntelliJ shows toolbar actions; ours embeds per-hunk buttons. Different but discoverable. |
| Partial line staging | Checkbox mode with "Stage Selected Lines" | "☐ Line Selection" toggle → checkbox per line → "Stage N Lines" | ⚠ Different | 🟡 MEDIUM | Same concept, different UI. IntelliJ's is modal editor-based; ours is inline checkbox. |

**Commit Dialog Summary**: Functional parity with architectural differences. IntelliJ uses platform CheckinDialog (richer, shared across all VCS); ours is git-specific webview. Author-override field is an **extra** feature (breaks strict parity but valuable).

---

### 2. Push Dialog

| Element | IntelliJ (GitPushDialog.kt) | Ours (PushDialog.ts) | Status | Severity | Notes |
|---|---|---|---|---|
| Repo table columns | [✓ selected] [repo] [branch] [target] [commits] | [✓ selected] [repo] [branch] [target (editable)] [commits] | ✅ Match | ⚪ | Column order matches |
| Target branch editable | Editable dropdown (ComboBoxWithAutoCompletion) | Editable `<input type=text>` | ⚠ Different | 🟡 MEDIUM | IntelliJ shows dropdown with branch suggestions; ours is free-text input. Less discoverable. |
| Commit preview pane | Right-side panel showing commit list for focused row | Right-side commit preview pane | ✅ Planned | 🟠 HIGH | Code comment says "commit preview pane for the focused row" but not implemented. UX gap. |
| Primary button dropdown | Dropdown with "Push" / "Force Push with Lease" / "Force Push" | `<select>` with same 3 options + separate "Push" button | ⚠ Different | 🟡 MEDIUM | IntelliJ uses split-button dropdown; ours has separate select+button. Functionally equivalent but less compact. |
| Default action on divergence | Auto-switches to "Force Push with Lease" when ahead+behind > 0 | Same (coded in `defaultPrimaryAction`) | ✅ Match | ⚪ | Safety logic matches |
| Gear options | Dropdown: --no-verify, --tags / --follow-tags | Inline checkboxes: same | ⚠ Different | 🟡 MEDIUM | IntelliJ hides these in an overflow dropdown; ours shows them inline. Ours is more discoverable but busier. |
| Edit all targets link | "Edit all targets" button → multi-line editor | "Edit all targets" link → focuses+selects all inputs | ⚠ Different | 🟡 MEDIUM | IntelliJ opens a separate multi-line editor; ours just focuses inputs. Ours is less powerful for bulk edits. |
| Per-row error banners | Error below rejected row with "Pull and Retry" / "Fetch and Retry" buttons | Error below rejected row with "Pull and Retry…" / "Force with Lease" | ⚠ Different | 🟡 MEDIUM | IntelliJ shows "Fetch and Retry"; ours shows "Force with Lease" as second button. Different recovery path. |

**Push Dialog Summary**: Strong layout parity but missing **commit preview pane** (🟠 HIGH). Target branch is plain text input instead of dropdown with suggestions (less discoverable). Options placement (inline vs overflow) differs.

---

### 3. Pull Dialog

| Element | IntelliJ (GitPullDialog.kt) | Ours (PullDialog.ts) | Status | Severity | Notes |
|---|---|---|---|---|
| Dialog type | Modal webview with fields | Two-step native QuickPick (source → options) | ❌ Different | 🟠 HIGH | Completely different UX paradigm. IntelliJ shows a single-dialog form; ours is wizard-style QuickPick. |
| Repo field | Dropdown at top | Omitted (picked before flow or auto-selected) | ⚠ Different | 🟡 MEDIUM | IntelliJ shows repo dropdown; ours picks repo first in multi-repo workspaces. |
| Remote field | Dropdown of remotes | QuickPick sectioned by remote (step 1) | ⚠ Different | 🟡 MEDIUM | IntelliJ is form-based; ours shows sectioned list. |
| Branch field | Dropdown with autocompletion | QuickPick sectioned by remote (step 1) | ⚠ Different | 🟡 MEDIUM | Same data, different UI. |
| Upstream indicator | "(upstream)" description on tracked branch | "(upstream)" description on tracked branch | ✅ Match | ⚪ | Both highlight tracked upstream |
| Options checkboxes | Inline checkboxes: --rebase / --ff-only / --no-ff / --squash / --no-commit / --no-verify | Step 2 multi-select QuickPick with same flags | ⚠ Different | 🟠 HIGH | IntelliJ shows all options at once; ours hides them in step 2. Less discoverable. |
| Strategy flag mutex | Radio-like behavior (selecting one clears others) | Same (enforced in `resolveFlagMutex`) | ✅ Match | ⚪ | Mutex logic matches |
| Confirm action | "Pull" button | "▶ Pull" terminal item in step 2 picker | ⚠ Different | 🟠 HIGH | IntelliJ has clear primary button; ours requires explicit picker selection of a "▶ Pull" item. Non-standard and confusing. |
| Options default | `intellig.pullRebase` config pre-fills --rebase | Same (`defaultPullFlags`) | ✅ Match | ⚪ | Logic matches |

**Pull Dialog Summary**: **Major UX paradigm difference** (🟠 HIGH). IntelliJ shows a single modal form with all fields visible; ours is a two-step QuickPick wizard. Options are less discoverable (step 2 only). The "▶ Pull" terminal item to confirm is non-standard and violates VS Code conventions (Enter should submit, not require picking a fake list item).

---

### 4. Rebase Dialog

| Element | IntelliJ (GitRebaseDialog.kt) | Ours (RebaseDialog.ts) | Status | Severity | Notes |
|---|---|---|---|---|
| Branch field | Read-only label (current branch) | Read-only label "Branch: <name> (current)" | ✅ Match | ⚪ | Both show current branch as read-only |
| Onto field | Dropdown with branches + tags | `<select>` with branches (+ hash if preselected) | ⚠ Different | 🟡 MEDIUM | IntelliJ populates tags dynamically; ours pre-populates branches + clicked hash only. Tags missing from dropdown. |
| Interactive checkbox | Top-level checkbox | Top-level checkbox | ✅ Match | ⚪ | Placement matches |
| Options fieldset | Below Interactive checkbox, inside collapsible "Options" section | Below Interactive checkbox, inside `<fieldset class="rebase-options">` | ✅ Match | ⚪ | Both group options together |
| Options disabled when Interactive | Options are disabled (grayed) when Interactive is checked | Same (`disabled` attribute + `.disabled` class) | ✅ Match | ⚪ | Logic matches |
| Options order | --rebase-merges, --update-refs, --keep-empty, --autosquash | Same (coded in `REBASE_OPTION_CHECKBOXES`) | ✅ Match | ⚪ | Order matches git4idea's `GitRebaseOption` enum |
| Options descriptions | Each checkbox has a short description | Each checkbox has title + description | ✅ Match | ⚪ | Both show explanatory text |
| Options persistence | Saved to GitRebaseSettings (per-project) | Saved to globalState (`REBASE_OPTIONS_STATE_KEY`) | ⚠ Different | 🟡 MEDIUM | IntelliJ persists per-project; ours persists globally. Different scope. |
| Button labels | "Start Rebase" | "Rebase" | ⚠ Different | 🟡 MEDIUM | IntelliJ's label is more explicit about the action starting a new rebase. |

**Rebase Dialog Summary**: Strong parity. Options order matches. Missing: tags in the Onto dropdown (🟡 MEDIUM). Button label less explicit. Persistence scope differs (global vs per-project).

---

### 5. Reset Dialog

| Element | IntelliJ (GitResetDialog.java) | Ours (ResetDialog.ts) | Status | Severity | Notes |
|---|---|---|---|---|
| Target commit display | "Commit" text field (editable, shows last entered ref) | Read-only banner: "<hash> <subject>" | ❌ Different | 🟠 HIGH | IntelliJ lets user edit the commit ref in the dialog; ours shows the clicked commit as read-only. Ours removes flexibility. |
| Validate button | "Validate" button next to commit field | N/A (no editable field) | ❌ Different | 🟡 MEDIUM | IntelliJ has a "Validate" button to check the ref; ours doesn't need it because field is read-only. |
| Mode selection | Dropdown with "Soft" / "Mixed" / "Hard" | Radio buttons with "Soft" / "Mixed" / "Hard" / "Keep" | ⚠ Different | 🟡 MEDIUM | IntelliJ uses dropdown (compact); ours uses radio buttons (more visible). IntelliJ's dropdown has only 3 modes; ours adds "Keep". |
| Mode order | Mixed, Soft, Hard | Soft, Mixed, Hard, Keep | ⚠ Different | 🟡 MEDIUM | IntelliJ lists Mixed first (the default); ours lists Soft first but defaults to Mixed. Layout order ≠ default. |
| Mode descriptions | Tooltips only (no inline desc) | Inline descriptions under each radio label | ❌ Extra | ⚪ | Ours is more discoverable (no need to hover for explanation). Good UX improvement. |
| Default mode | Mixed | Mixed (loaded from `loadPreferredResetMode`, falls back to Mixed) | ✅ Match | ⚪ | Both default to Mixed |
| Protected-branch guard | No visual indication in dialog | Hard/Keep radios disabled with title tooltip on protected branches | ❌ Extra | ⚪ | Our safety feature; IntelliJ doesn't have protected-branches concept in git4idea. |
| Commit field label | "Commit:" | (No equivalent; target is read-only) | ⚠ Different | 🟡 MEDIUM | IntelliJ labels the editable commit field; ours shows commit as a banner. |

**Reset Dialog Summary**: **Major UX difference** (🟠 HIGH). IntelliJ lets user edit the commit ref in the dialog; ours shows the clicked commit as read-only. Ours removes flexibility (can't reset to a different commit without re-invoking). Mode presentation differs (dropdown vs radio). Our inline descriptions are better UX than IntelliJ's tooltips.

---

### 6. Merge Dialog

| Element | IntelliJ (GitMergeDialog.kt) | Ours (MergeDialog.ts) | Status | Severity | Notes |
|---|---|---|---|---|
| Source branch | Dropdown (editable with autocompletion) | Read-only label in summary banner | ❌ Different | 🟠 HIGH | IntelliJ lets user pick a different source branch in the dialog; ours shows the clicked branch as read-only. Ours removes flexibility. |
| Target branch | Read-only label (current branch) | Read-only label "Target: <current>" | ✅ Match | ⚪ | Both show target as read-only |
| Strategy flags | Checkboxes: --ff-only / --no-ff / --squash | Same | ✅ Match | ⚪ | Order matches |
| Modifier flags | Checkboxes: --no-commit | Same | ✅ Match | ⚪ | Matches |
| --no-verify checkbox | Shown only if `NO_VERIFY_SUPPORTED.existsIn(gitVersion)` | Always shown (flag checked at git layer) | ⚠ Different | 🟡 MEDIUM | IntelliJ hides the checkbox on old git versions; ours always shows it. |
| --allow-unrelated-histories | Not in IntelliJ's GitMergeDialog | Present in ours | ❌ Extra | 🟡 MEDIUM | We added this flag; IntelliJ doesn't expose it in the dialog. Useful but breaks strict parity. |
| Commit message field | Multi-line textarea labeled "Commit message (optional):" | Multi-line textarea labeled "Merge commit message (optional, maps to `-m`):" | ⚠ Different | ⚪ | Same field, slightly different label. Ours is more explicit about the `-m` mapping. |
| Flag descriptions | Inline descriptions under each checkbox | Same | ✅ Match | ⚪ | Both show explanatory text |
| Button labels | "Merge" | "Merge" | ✅ Match | ⚪ | Labels match |

**Merge Dialog Summary**: **Source branch is read-only** (🟠 HIGH) — IntelliJ lets user pick a different branch; ours shows the clicked branch as fixed. Ours removes flexibility. We added `--allow-unrelated-histories` checkbox (extra feature, breaks strict parity).

---

### 7. Tag Creation

| Element | IntelliJ (GitTagDialog.java) | Ours (New Tag flow in commitHelpers.ts) | Status | Severity | Notes |
|---|---|---|---|---|
| Dialog type | Modal form (GitTagDialog.java) | Two-step InputBox flow (name → message) | ❌ Different | 🟠 HIGH | IntelliJ shows a single-dialog form with all fields; ours is a two-step wizard. |
| Repo field | Dropdown at top | Picked before flow (via `pickRepositoryForTag`) | ⚠ Different | 🟡 MEDIUM | IntelliJ shows repo dropdown; ours picks repo first or auto-selects. |
| Current branch | Read-only label | Not shown | ❌ Missing | 🟡 MEDIUM | IntelliJ shows current branch as context; ours omits it. |
| Tag name field | Text input with inline validation | InputBox with `validateInput` callback | ⚠ Different | 🟡 MEDIUM | IntelliJ validates inline; ours validates on every keystroke via InputBox callback. Same logic, different UI. |
| Force checkbox | Checkbox (disabled until tag exists) | Not shown; offered in confirm-overwrite modal on collision | ⚠ Different | 🟡 MEDIUM | IntelliJ pre-shows the Force checkbox (disabled); ours shows it only when needed as a confirm modal. Ours is safer (no accidental force). |
| Message field | Multi-line textarea (4 rows) | Second InputBox prompt (single-line input) | ⚠ Different | 🟠 HIGH | IntelliJ allows multi-line annotation messages in a textarea; ours is single-line InputBox (less capable for long messages). |
| Commit field | Text input with "Validate" button | `targetRef` parameter (passed programmatically, not editable in UI) | ❌ Different | 🟠 HIGH | IntelliJ lets user specify a commit ref in the dialog; ours passes it as a parameter (not user-editable). Ours removes flexibility. |
| Validate button | "Validate" button next to commit field | N/A (commit ref not editable) | ❌ Missing | 🟡 MEDIUM | IntelliJ has a "Validate" button; ours doesn't need it because commit ref is a fixed parameter. |

**Tag Dialog Summary**: **Major UX paradigm difference** (🟠 HIGH). IntelliJ shows a single-dialog form with all fields visible; ours is a two-step InputBox wizard. Message field is single-line InputBox (less capable than IntelliJ's multi-line textarea). Commit ref is not user-editable (passed programmatically). Force checkbox is shown reactively instead of pre-emptively.

---

## Top UX Findings (Ranked)

### 🔴 Critical (Misleading Defaults / Broken Core Flows)
None. All dialogs function correctly and have safe defaults.

### 🟠 High Priority (Significant Parity Breaks / Poor Discoverability)

1. **Pull Dialog: Two-step QuickPick instead of single form** (PullDialog.ts)
   - **Impact**: IntelliJ users expect a single modal form with all fields visible. Our wizard hides options in step 2 (less discoverable). The "▶ Pull" terminal item to confirm violates VS Code conventions (Enter should submit).
   - **Recommendation**: Consider replacing with a webview modal form (BaseWebviewPanel) matching IntelliJ's layout: remote dropdown, branch dropdown, inline checkboxes for flags, "Pull" button. Or improve the QuickPick UX by making Enter submit the flag selection instead of requiring explicit "▶ Pull" item selection.
   - **File**: `src/sync/PullDialog.ts`

2. **Push Dialog: Missing commit preview pane** (PushDialog.ts:8)
   - **Impact**: IntelliJ shows a commit list for the focused row on the right side. Ours shows nothing (code comment says "commit preview pane" but not implemented). Users can't see what they're about to push.
   - **Recommendation**: Implement the right-side commit preview pane. Fetch commits for focused row via `gitService.getLog` and render in a scrollable list.
   - **File**: `src/sync/PushDialog.ts` lines 8, 41

3. **Reset Dialog: Commit ref is read-only** (ResetDialog.ts)
   - **Impact**: IntelliJ lets user edit the commit ref in the dialog (e.g., change from "HEAD~1" to "HEAD~3"). Ours shows the clicked commit as a read-only banner. Removes flexibility — user must cancel and re-invoke to reset to a different commit.
   - **Recommendation**: Add an editable commit field (text input with validation + "Validate" button, matching IntelliJ). Seed it with the clicked commit but allow editing.
   - **File**: `src/ui-shell/ResetDialog.ts` lines 66-71, 224-233

4. **Merge Dialog: Source branch is read-only** (MergeDialog.ts)
   - **Impact**: IntelliJ lets user pick a different source branch in the dialog. Ours shows the clicked branch as a read-only label. Removes flexibility — user must cancel and re-invoke to merge a different branch.
   - **Recommendation**: Add a source-branch dropdown (seeded with clicked branch, editable). Fetch branches via `gitService.getBranches` and populate a ComboBoxWithAutoCompletion equivalent.
   - **File**: `src/conflicts/MergeDialog.ts` lines 118-131, 212-216

5. **Tag Dialog: Two-step InputBox instead of single form** (commitHelpers.ts)
   - **Impact**: IntelliJ shows a single modal form with all fields (repo, branch, tag name, message, commit, force). Ours is a two-step InputBox wizard (name → message). Message field is single-line (less capable for long annotations). Commit ref is not user-editable.
   - **Recommendation**: Replace with a webview modal form (BaseWebviewPanel) matching IntelliJ's layout: repo dropdown, current-branch label, tag-name input, message textarea, commit input + Validate button, force checkbox.
   - **File**: `src/commands/registration/commitHelpers.ts` lines 161-220

6. **Tag Dialog: Message field is single-line InputBox** (commitHelpers.ts:176-184)
   - **Impact**: IntelliJ allows multi-line annotation messages in a 4-row textarea. Ours is a single-line InputBox (VS Code native). Multi-line messages must be entered with escaped newlines.
   - **Recommendation**: Part of the webview-form recommendation above. A textarea in the form would match IntelliJ.
   - **File**: `src/commands/registration/commitHelpers.ts` lines 176-184

### 🟡 Medium (Layout / Labeling Differences, Reduced Discoverability)

7. **Commit Dialog: Author override field is extra** (CommitDialog.ts:85-95, 1083-1106)
   - **Impact**: IntelliJ doesn't surface an author override in the commit dialog (author is set globally in VCS settings). We added an "Author (optional):" field below the message. Useful feature but breaks strict parity.
   - **Recommendation**: Keep it (useful), but document as intentional deviation from IntelliJ. Consider hiding it behind a config flag if strict parity is required.
   - **File**: `src/commits/CommitDialog.ts` lines 85-95, 1083-1106

8. **Commit Dialog: Gear menu is incomplete** (CommitDialog.ts:609-625, 2211-2231)
   - **Impact**: IntelliJ's commit-options panel has "Run inspections" / "Reformat" / "Optimize Imports" / etc. Ours has a stub "Run before-commit checks" (disabled, "Coming soon") + functional `--no-verify` toggle.
   - **Recommendation**: Implement the missing gear-menu entries (reformat, optimize imports, etc.) or remove the stub entirely to avoid misleading users.
   - **File**: `src/commits/CommitDialog.ts` lines 609-625, 2211-2231

9. **Push Dialog: Target branch is plain text input** (PushDialog.ts:618-621)
   - **Impact**: IntelliJ shows a dropdown with branch suggestions (ComboBoxWithAutoCompletion). Ours is a plain `<input type=text>`. Less discoverable (user must know branch names).
   - **Recommendation**: Offer a dropdown with branch suggestions (fetch via `gitService.getBranches`, filter by remote). Fall back to free-text if user types a non-existent branch.
   - **File**: `src/sync/PushDialog.ts` lines 618-621

10. **Push Dialog: Options are inline instead of in overflow** (PushDialog.ts:649-656)
    - **Impact**: IntelliJ hides --no-verify / --tags / --follow-tags in an overflow dropdown. Ours shows them inline. Ours is more discoverable but busier.
    - **Recommendation**: No change needed (tradeoff). Consider moving to an overflow dropdown if the dialog feels cluttered.
    - **File**: `src/sync/PushDialog.ts` lines 649-656

11. **Rebase Dialog: Tags missing from Onto dropdown** (RebaseDialog.ts:88-97, 192-194)
    - **Impact**: IntelliJ populates the Onto dropdown with branches + tags (loaded dynamically via `loadTagsInBackground`). Ours pre-populates branches + the clicked hash only. Users can't rebase onto a tag without invoking from a tag context.
    - **Recommendation**: Load tags asynchronously (`gitService.getTags`) and add them to the Onto dropdown. Match IntelliJ's lazy-loading approach.
    - **File**: `src/rebase/RebaseDialog.ts` lines 88-97, 192-194

12. **Reset Dialog: Mode order (Soft first) differs from IntelliJ (Mixed first)** (ResetDialog.ts:336-341)
    - **Impact**: IntelliJ's dropdown lists modes as "Mixed / Soft / Hard" (Mixed first, matching the default). Ours lists "Soft / Mixed / Hard / Keep" (Soft first, but Mixed is still the default). Visual order ≠ default.
    - **Recommendation**: Reorder to "Mixed / Soft / Hard / Keep" to match IntelliJ and highlight the default first.
    - **File**: `src/ui-shell/ResetDialog.ts` lines 336-341

13. **Merge Dialog: --allow-unrelated-histories is extra** (MergeDialog.ts:254-260)
    - **Impact**: IntelliJ's GitMergeDialog doesn't expose `--allow-unrelated-histories`. We added it. Useful feature but breaks strict parity.
    - **Recommendation**: Keep it (useful for merging unrelated repos), but document as intentional deviation. Or hide behind a config flag.
    - **File**: `src/conflicts/MergeDialog.ts` lines 254-260

14. **Tag Dialog: Current branch not shown** (commitHelpers.ts)
    - **Impact**: IntelliJ shows the current branch as a read-only label (context). Ours omits it. Users don't know which branch the tag will be on.
    - **Recommendation**: Add a "Current branch: <name>" label to the tag dialog (if converted to a webview form). Or show it in the InputBox title: "Create Tag on branch '<name>'".
    - **File**: `src/commands/registration/commitHelpers.ts` (no current-branch display)

### ⚪ Low / Polish (Minor Labeling / Cosmetic Differences)

15. **Commit Dialog: Recent-messages button icon (∨ vs History icon)** (CommitDialog.ts:1052-1060)
    - **Impact**: IntelliJ shows a dedicated history icon. Ours uses a dropdown glyph "∨". Same function, different icon.
    - **Recommendation**: No change needed (acceptable divergence). Consider using a history icon if one is available in VS Code's icon set.
    - **File**: `src/commits/CommitDialog.ts` lines 1052-1060

16. **Commit Dialog: --no-verify badge is extra** (CommitDialog.ts:1112-1121)
    - **Impact**: IntelliJ doesn't show a visible warning when --no-verify is on. Ours shows "⚠ Git hooks will be skipped...". Good defensive UX (not a gap, an improvement).
    - **Recommendation**: Keep it. Positive deviation.
    - **File**: `src/commits/CommitDialog.ts` lines 1112-1121

17. **Rebase Dialog: Button label ("Rebase" vs "Start Rebase")** (RebaseDialog.ts:330)
    - **Impact**: IntelliJ's button says "Start Rebase". Ours says "Rebase". IntelliJ's is more explicit about starting a new rebase.
    - **Recommendation**: Change to "Start Rebase" to match IntelliJ.
    - **File**: `src/rebase/RebaseDialog.ts` line 330

18. **Rebase Dialog: Options persistence scope (global vs per-project)** (RebaseDialog.ts:151-171)
    - **Impact**: IntelliJ persists rebase options per-project (GitRebaseSettings). Ours persists globally (ExtensionContext.globalState). Different scope.
    - **Recommendation**: Consider switching to workspace-scoped persistence (ExtensionContext.workspaceState) to match IntelliJ's per-project behavior.
    - **File**: `src/rebase/RebaseDialog.ts` lines 151-171

---

## Positive Notes (Well-Matched or Improved UX)

- **Reset Dialog inline descriptions**: Our radio buttons have inline descriptions under each mode. IntelliJ only has tooltips. Ours is more discoverable.
- **Reset Dialog protected-branch guard**: Our Hard/Keep radios are disabled with a tooltip on protected branches. IntelliJ doesn't have this concept. Good safety feature.
- **Commit Dialog --no-verify badge**: Our visible warning badge when --no-verify is on is better UX than IntelliJ's silent state. Prevents accidental hook-skipping.
- **Commit Dialog author-override field**: Useful for pair programming / co-authoring. IntelliJ requires changing global VCS settings.
- **Merge Dialog --allow-unrelated-histories**: Useful for merging independent repos. IntelliJ doesn't expose it.
- **Keyboard shortcuts (Cmd+Enter / Esc)**: All dialogs implement consistent keyboard shortcuts (spec 5.1). Matches IntelliJ.
- **Commit Dialog partial staging**: Full hunk+line staging with inline controls. Parity achieved with different UI (inline buttons vs toolbar).
- **Push Dialog primary-action auto-flip on divergence**: Matches IntelliJ's safety logic (defaults to force-with-lease when ahead+behind).
- **Push Dialog per-row error banners**: "Pull and Retry" / "Force with Lease" recovery affordances match IntelliJ's pattern.

---

## Recommendations Summary (Priority Order)

1. 🟠 **Pull Dialog**: Replace two-step QuickPick with single webview form (or fix "▶ Pull" item UX).
2. 🟠 **Push Dialog**: Implement missing commit preview pane on the right side.
3. 🟠 **Reset Dialog**: Make commit ref editable (add input + Validate button).
4. 🟠 **Merge Dialog**: Make source branch editable (add dropdown).
5. 🟠 **Tag Dialog**: Replace two-step InputBox with single webview form (multi-line message, editable commit ref).
6. 🟡 **Push Dialog**: Add branch-suggestion dropdown for target field (vs plain text input).
7. 🟡 **Rebase Dialog**: Load tags asynchronously and add to Onto dropdown.
8. 🟡 **Reset Dialog**: Reorder modes to "Mixed / Soft / Hard / Keep" (Mixed first).
9. 🟡 **Commit Dialog**: Implement gear-menu entries (reformat, optimize imports) or remove stub.
10. ⚪ **Rebase Dialog**: Change button label to "Start Rebase".

---

## Verdict

**Status**: CONCERNS (6 🟠 HIGH findings, 8 🟡 MEDIUM findings)

**Overall Assessment**: Strong layout parity for Push, Rebase, Reset, and Merge dialogs. **Major UX paradigm differences** for Pull and Tag dialogs (two-step wizards vs single forms) reduce discoverability and break IntelliJ user expectations. Missing commit preview pane in Push Dialog (code comment indicates it's planned but not implemented). Reset and Merge dialogs show clicked items as read-only (removes flexibility vs IntelliJ's editable fields).

**Recommended Actions**:
1. **Pull Dialog**: Replace with webview form or improve QuickPick UX (remove "▶ Pull" item requirement).
2. **Push Dialog**: Implement commit preview pane (right side, shows commits for focused row).
3. **Reset Dialog**: Add editable commit field with validation.
4. **Merge Dialog**: Add source-branch dropdown (editable).
5. **Tag Dialog**: Replace with webview form (multi-line message, editable commit, force checkbox).
6. **Push Dialog**: Add branch-suggestion dropdown for target field.
7. **Rebase Dialog**: Load tags and add to Onto dropdown.
8. **Reset Dialog**: Reorder modes to Mixed-first.

The dialogs are **functionally correct** and have **safe defaults**, but the UX divergences (especially Pull and Tag wizards) will confuse IntelliJ users migrating to IntelliG. The missing commit preview pane in Push Dialog is a **HIGH** parity gap.
