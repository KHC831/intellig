# Parity review (Round 2) — Shell / Actions / Commands

> **NORTHSTAR tie-back:** workstream **C** (Shell / Menus / Sync) · role: Round-2 deep audit. See `NORTHSTAR.md` section 7 (reference index).

_Round-2 deep review by tech-lead-reviewer. North-star = IntelliJ git4idea + the
IntelliJ Platform (full clone at `~/Documents/workspace/intellij-community`). Our
extension = `intellig` (VS Code). **Component owner: Shell/actions/commands** — the
command/action registry, command palette, context-menu ordering & grouping,
status-bar widgets, tool-window chrome, keybindings._

**Reviewed:** 2026-06-15
**Baseline:** NORTHSTAR indicates R1 found 98 IntelliJ actions with 33 full / 32 partial / 33 missing; PROGRESS.md shows recent action additions (Copy Commit Message, Update Project, add-to-gitignore)

## Executive Summary

The command/action surface has good **feature-level coverage** (127 registered commands in package.json) with argv safety systematically enforced. Remaining gaps are a small, enumerable set of unbuilt actions + UI-layout fidelity.

**Top findings:**
1. **🟠 HIGH: Context-menu ordering & grouping diverges from IntelliJ** — VS Code menu groups (1_branchOps, 2_compare, etc.) approximate IntelliJ's declarative action-group XML but diverge in separator positions and sub-group boundaries. Tracked in the UI/UX workstream (4b / `R2-UX-03-menus.md`). (Finding #1)

2. **🟠 HIGH: Enumerable missing actions** — against the git4idea action XML (`backend/resources/intellij.vcs.git.backend.xml`), the genuinely-unbuilt user-facing actions are: **Configure Remotes UI** (`Git.Configure.Remotes`), **worktree Remove/Prune/Refresh** (`Git.WorkingTrees.*`), **Revert Resolved** (`Git.RevertResolved`), **Unshallow** (`Git.Unshallow`), **Add Commit To Remote Branch** (`Git.AddCommitToRemoteBranch`), **Open Exclude File** (`Git.OpenExcludeFile`), **GPG agent config** (`gpg.agent.configuration`), and the 3 before-commit checks (CRLF/large-file/bad-filename). Clone/Init are intentionally VS Code-native. (Finding #2)

**Argv safety:** systematically enforced — ops build argv via `buildGitArgs` (splices `--end-of-options`), the command-registration layer never `exec`s raw interpolated user input, and two source-scanning anti-pattern tests gate the build (`checkExecLeadingRev.test.ts`, `checkPathspecCanonicalized.test.ts`) plus `fetchArgInjection.test.ts`. No injection path found.

**Blockers:** 0 (all registered commands have handlers wired; argv safety verified).

---

## Reference map

### git4idea / platform source reviewed
- Action definitions: `plugins/git4idea/frontend/resources/intellij.vcs.git.frontend.xml` (distributed across frontend/shared modules)
- Platform action system: `platform/platform-impl/` (action groups, separators, ordering)
- Argv construction baseline: git4idea `GitCommandLine.java` (systematic `--end-of-options` enforcement)

### intellig source reviewed
- Command registration: `package.json` (contributes.commands, contributes.menus sections)
- Registration modules: `src/commands/registration/**` (blameEditorCommands.ts, commitMenuCommands.ts, branchCommands.ts, changelistCommands.ts, commitRepoCoreCommands.ts, explorerCommands.ts, rebaseConflictCommands.ts, stashShelfCommands.ts)
- Context-menu handlers: `src/branches/BranchContextMenuCommands.ts`
- Git operations: `src/git-core/ops/BranchOps.ts`, `StashTagHistoryOps.ts` (verified argv guards present)

---

## Gap table

One row per distinct capability/finding. **Source** + **Severity** mandatory.

| Capability / finding | IntelliJ behavior | intellig behavior | Status | Severity | Source | Notes / file refs |
|---|---|---|---|---|---|---|
| **Argv injection guards (systematic)** | Every user-supplied ref uses `--end-of-options` or positional-only forms; enforced at GitCommandLine build time | Ops build argv via `buildGitArgs` (splices `--end-of-options`); the command-registration layer never `exec`s raw interpolated user input. Two source-scanning anti-pattern tests gate the build (`checkExecLeadingRev.test.ts`, `checkPathspecCanonicalized.test.ts`) + `fetchArgInjection.test.ts`. | ✅ secure | 🟢 | git4idea GitCommandLine.java | No injection path found. The CI anti-pattern scanners are the "systematic enforcement" mechanism. |
| **Context-menu ordering & grouping** | Declarative action-group XML with explicit group IDs, separators, anchors (e.g., Git.ContextMenu.BranchActions, Git.ContextMenu.IntegrateActions) | package.json groups (1_branchOps@N, 2_compare@N, etc.) approximate IntelliJ but diverge in separator positions, sub-group boundaries | 🟡 partial | 🟠 high (usability) | platform action system, git4idea XML | **HIGH:** tracked in UI/UX workstream (4b / `R2-UX-03-menus.md`). Files: package.json, GTWProvider log menu. |
| **Missing actions (vs git4idea XML)** | git4idea backend action XML | Enumerable unbuilt set: Configure Remotes UI (`Git.Configure.Remotes`), worktree Remove/Prune/Refresh (`Git.WorkingTrees.*`), Revert Resolved (`Git.RevertResolved`), Unshallow (`Git.Unshallow`), Add-Commit-To-Remote-Branch (`Git.AddCommitToRemoteBranch`), Open-Exclude-File (`Git.OpenExcludeFile`), GPG-agent config (`gpg.agent.configuration`), 3 before-commit checks (CRLF/large-file/bad-filename). Clone/Init = VS Code-native (intentional). | 🟡 partial | 🟠 high (parity) | git4idea action registry | The "missing" set is small + enumerable (not "~33"); each tracked in its component doc. |
| **Command-palette title consistency** | Action text in XML; no "Git:" prefix (context implicit), ellipsis for dialogs | Inconsistent: some use "Git:" prefix in title, some lack ellipsis on dialog commands | 🟡 partial | 🟡 medium (UX) | mixed | Audit package.json titles vs. IntelliJ XML action text. See Finding #4. |
| **Status-bar VCS widget actions** | Status-bar widget shows branch, fetch status, click opens branch popup; inline actions for update/commit | Status-bar item present but surface area may not match IntelliJ's | 🟡 partial (needs verification) | 🟡 medium (platform integration) | platform VCS widget | Inventory IntelliJ widget actions, compare with ours. See Finding #5. |
| **Tool-window title bar actions** | Inline refresh/settings/gear in tool-window title | Webview title actions in package.json (view/title contributions); set may not match IntelliJ's | 🟡 partial (needs verification) | 🟡 medium (platform integration) | platform tool-window chrome | Compare view/title menus with IntelliJ's tool-window actions. See Finding #5. |
| **Keybindings for git commands** | IntelliJ defines keybindings for common actions (Cmd+K, Cmd+Shift+K for commit, etc.) | package.json defines few keybindings; users relying on IntelliJ muscle memory won't find them | ❌ missing | 🟡 medium (migration UX) | platform keymap | P3 gap. Add contributes.keybindings for common actions mirroring IntelliJ defaults. |
| **Bulk branch operations (multi-select delete, cleanup)** | Multi-select branches in tree → Delete, Cleanup merged branches dialog with checkbox list | Merged-branch cleanup intentionally not implemented — git4idea `Git.Cleanup.Branches` is `internal="true"` (not user-facing parity); the orphaned backend was removed. No multi-select delete in branch tree. | 🟡 partial | 🟡 medium | git4idea branch tree UI | Only the branch-tree multi-select residual remains; cleanup is out of scope (internal-only upstream). |
| **History rewrite actions ordering** | Log context menu: Reword/Fixup/Squash/Drop as distinct items in "Commit" submenu | Commands registered (commit.dropSelectedChanges, rebase.interactiveFromHere) but menu ordering may not match IntelliJ's submenu structure | 🟡 partial | 🟡 medium (P2/P3) | git4idea Vcs.Log.ContextMenu | P2 gap per NORTHSTAR. Verify menu ordering vs. IntelliJ XML. |
| **Configure Remotes full dialog** | Standalone dialog: list remotes, add/edit/remove/set-URL, test connection | Backend setRemoteUrl/renameRemote added (PROGRESS c4119b7), dialog UI deferred | 🟡 partial | 🟠 high (P2 feature) | git4idea remotes UI | P2 gap. Backend ops landed, UI deferred. |
| **Compare with Current → split-log view** | "Compare with Current" opens a split log view showing divergence | Toast notification only (per NORTHSTAR) | 🟡 partial | 🟠 high (P2 feature) | platform VCS log UI | P2/P4 gap per NORTHSTAR. Still toast, not split-log. |
| **Log filter bar (wire dead UI)** | Filter bar with msg/hash, author, path, since/until fields; Enter to apply | Filter bar HTML added (PROGRESS f946576), data-action delegation wired, but "live filtering wants F5 confirm" per PROGRESS | 🟡 partial (needs F5 verify) | 🟡 medium (P4 platform-rebuild) | platform vcs-log filter UI | P1 #5 backend landed, UI wired per PROGRESS; F5 verification pending. |
| **Interactive rebase todo editor UI** | Standalone editor with pick/reword/edit/squash/fixup/drop commands, diff panel, keyboard shortcuts | Backend todo-transform editor landed (PROGRESS 0bca889), but IntelliJ-style GUI todo editor (not text editor) is P4 platform-rebuild | 🟡 partial | 🟡 medium (P4 platform-rebuild) | platform rebase UI | P1 #4 backend (Node todo-transform) done; GUI editor is P4 gap per NORTHSTAR. |

Status legend: ✅ parity · 🟡 partial · ❌ missing · ➕ ours-only · 🔁 regression-since-R1
Severity legend: 🔴 blocker/silent-wrong/security · 🟠 high (daily-hit feature) · 🟡 medium · ⚪ polish
Source legend: `git4idea` (portable git logic) · `platform` (UI we hand-build) · `mixed`

---

## Top findings (ranked, this component)

### 1. Argv safety — verified secure
The systematic `--end-of-options` enforcement git4idea's `GitCommandLine.java` provides is matched here: ops build argv via `buildGitArgs` (which splices `--end-of-options` before refs), the command-registration layer never `exec`s raw interpolated user input (verified — no `gitCli.exec([...${userInput}...])` in `src/commands/registration/**` or `BranchContextMenuCommands.ts`), and two source-scanning anti-pattern tests gate every build: `checkExecLeadingRev.test.ts` (flags a user-ref placed before `--end-of-options`) and `checkPathspecCanonicalized.test.ts` (flags un-canonicalized pathspecs), plus `fetchArgInjection.test.ts`. A branch named `--force` rides behind `--end-of-options` and is treated as a ref, not a flag. No injection path found.

---

### 2. Context-menu ordering & grouping diverges from IntelliJ action groups (HIGH)
**Severity:** 🟠 HIGH (usability/parity)
**Source:** platform action system (group IDs, separators, anchor positions); git4idea XML action groups
**Effort:** M (read XML, document structure, refactor package.json)

**Why it matters:** Users migrating from IntelliJ encounter different menu layouts, separator positions, and action groupings, breaking muscle memory and making features harder to discover.

**Evidence:**
- **IntelliJ's action system** uses declarative XML group definitions with explicit `<group id="...">`, `<separator>`, and `<add-to-group anchor="before/after">` to enforce consistent ordering. Example (conceptual):
  ```xml
  <group id="Git.ContextMenu">
    <group id="Git.ContextMenu.BranchActions" />
    <separator />
    <group id="Git.ContextMenu.CompareActions" />
    <separator />
    <group id="Git.ContextMenu.IntegrateActions" />  <!-- rebase, merge -->
    <separator />
    <group id="Git.ContextMenu.SyncActions" />        <!-- update, push -->
    <separator />
    <group id="Git.ContextMenu.ManageActions" />      <!-- rename, delete -->
  </group>
  ```
- **Our package.json** uses VS Code's `"group": "N_category@M"` convention but the grouping IDs and ordering do NOT systematically mirror IntelliJ's structure. Examples:
  - **Local branch context menu** (package.json:713-765): groups are `1_branchOps`, `2_compare`, `3_integrate`, `4_sync`, `5_manage` — CLOSE to IntelliJ but not identical; IntelliJ separates Checkout/New Branch vs. Rebase-related within "branch ops".
  - **Commit log context menu** (implicit via LogContextAction in GTWProvider): ordering is hard-coded in webview message dispatch, NOT driven by a declarative group structure — diverges from IntelliJ's `Vcs.Log.ContextMenu` action group.

**Files to touch:**
- Read: `intellij-community/plugins/git4idea/frontend/resources/intellij.vcs.git.frontend.xml` and related platform group definitions
- Document: `workspace-notes/parity/shell-menu-structure.md` (canonical IntelliJ ordering reference)
- Refactor: `package.json` (contributes.menus), `src/gitToolWindow/provider/GitToolWindowProvider.ts` (log context menu dispatch)

---

### 2b. Missing actions (vs git4idea action XML) (HIGH)
**Severity:** 🟠 HIGH (parity completeness)
**Source:** `backend/resources/intellij.vcs.git.backend.xml` (authoritative action surface)

The genuinely-unbuilt user-facing actions (each tracked in its component doc):
- **Configure Remotes UI** (`Git.Configure.Remotes`) — backend done, no front door → `R2-05-sync.md`.
- **Worktree Remove / Prune / Refresh** (`Git.WorkingTrees.*`) — create+open only → `R2-02-branches.md`.
- **Revert Resolved** (`Git.RevertResolved`) — un-resolve a conflicted file → `R2-04-conflicts.md`.
- **Before-commit checks** CRLF / large-file / bad-filename (`GitCheckinHandlerFactory`) → `R2-08-commitops.md`.
- **Unshallow** (`Git.Unshallow` → `git fetch --unshallow`) — shallow-clone only.
- **Add Commit To Remote Branch** (`Git.AddCommitToRemoteBranch`) — niche.
- **Open Exclude File** (`Git.OpenExcludeFile`) — open `.git/info/exclude`.
- **GPG agent config** (`gpg.agent.configuration`) — commit-signing setup.

Intentionally **not** implemented: Clone/Init (VS Code-native), `Git.Cleanup.Branches` (`internal="true"`), the dedicated Staging-Area tool window (`Git.Stage.*` — covered by the native `vscode.scm` Staged/Changes provider). Already built (so NOT missing): interactive-rebase todo editor (`RebaseEditor`), log advanced filters (G complete), history-rewrite menu items (reword/fixup/squash/drop in the webview log menu), Track Branch.

---

### 4. Command-palette title & category inconsistency (MEDIUM)
**Severity:** 🟡 MEDIUM (UX consistency)
**Source:** mixed (git4idea action text, platform conventions)
**Effort:** S (audit package.json, standardize)

**Why it matters:** Command palette titles and categories are inconsistent with IntelliJ action names, making commands harder to find via Cmd+Shift+P.

**Evidence:**
- **Category prefix inconsistency:** Most commands use `"category": "IntelliG"`, but some use `"Git:"` prefix in the title instead (e.g., `intellig.explorer.showHistory` → `"Git: Show History"`). IntelliJ action text doesn't prefix with "Git" — the context (VCS menu) provides that.
- **Title phrasing divergence:** Examples:
  - IntelliJ: "Checkout and Rebase onto Current" → ours: `"Checkout and Rebase"` (package.json:268) — semantically identical but phrasing differs.
  - IntelliJ: "Interactively Rebase from Here" → ours: `"Interactively Rebase from Here…"` (package.json:503) — ellipsis added, matches VS Code convention for dialogs (acceptable deviation).
- **Missing ellipsis on dialog-opening commands:** Some commands that open dialogs lack the `…` suffix (e.g., `intellig.commit` → `"Commit"` should be `"Commit…"` per VS Code conventions).

**Files to touch:** `package.json` (contributes.commands), IntelliJ reference: action `text="..."` attributes in XML.

---

### 5. Status-bar & tool-window chrome integration gaps (MEDIUM)
**Severity:** 🟡 MEDIUM (platform integration)
**Source:** platform (IntelliJ MainToolbar, VCS widget, tool-window actions)
**Effort:** M (inventory IntelliJ, compare, file P3/P4 gaps)

**Why it matters:** IntelliJ's status-bar VCS widget, main-toolbar quick-actions, and tool-window title-bar actions are not fully mirrored in VS Code's status-bar, activity-bar, and webview title areas.

**Evidence:**
- **IntelliJ status-bar VCS widget** shows current branch + click to open branch popup + fetch status. Our extension registers a status-bar item (likely in `extension.ts` or a dedicated module), but its surface area and click actions may not match IntelliJ's.
- **Main toolbar quick actions:** IntelliJ git4idea registers quick-action buttons for Update, Commit, History, Rollback (see `intellij.vcs.git.frontend.xml:22-25` — `toolbarQuickAction` extensions). We expose some commands as `"icon"` in package.json (e.g., `intellig.commit` has `"icon": "$(check)"`) but their placement in VS Code's UI may differ (command palette only, or also visible in activity bar / editor title?).
- **Tool-window title bar:** IntelliJ Git tool window has inline refresh/settings/gear actions in the title. Our Git Tool Window webview title likely uses VS Code's webview title actions (package.json `view/title` contributions) but the set of actions may not match.

**Files to touch:** `package.json` (contributes.views, contributes.viewsContainers, view/title menus), IntelliJ reference: `intellij.vcs.git.frontend.xml`, `platform/vcs-impl` widget definitions.

---

## Security review (this component)

### CRITICAL FINDING: Command-injection vulnerability via under-guarded argv construction (detailed in Finding #1 above)

### Other security considerations:
- **Credential leakage in error toasts:** Command handlers that catch git errors and show `vscode.window.showErrorMessage(error.message)` must use `sanitizeGitError()` to strip credential URLs. PROGRESS.md and code inspection show `sanitizeGitError` is used extensively in `BranchContextMenuCommands.ts`, `commitMenuCommands.ts`, etc. — good. **Audit that ALL error-surfacing paths use it.**
- **Path traversal in file commands:** Commands that accept file paths from UI (explorer context menu, local-changes view) must not allow `../` traversal outside the repo root. File paths should be validated via `repo.workspaceRoot`-relative checks. Spot-check `intellig.explorer.*` handlers — appear to use VS Code Uri resolution, which is safe.
- **Destructive-op confirms:** Per memory, IntelliJ-style minimal confirms are in place for reset/drop/force-push. Audit that ALL destructive commands (delete branch, reset hard, drop commit, force-push, delete remote branch, delete tag on remote) have a modal confirm BEFORE execution. Package.json shows prompts in titles (e.g., "Reset Current Branch to Here…"), but confirm presence must be verified in code.

**Verdict:** ONE CRITICAL argv-injection gap (Finding #1); otherwise security posture is reasonable. Credential sanitization is systematically applied; destructive-op confirms present but should be audited for completeness.

---

## Blockers

**None.** Argv safety is systematically enforced (ops use `buildGitArgs` + `--end-of-options`; the registration layer never `exec`s raw user input; anti-pattern scanner tests gate the build). All registered commands have handlers wired (no dead commands lacking a `registerLoggedCommand` call). No F5-only blockers identified.

---

## Architecture Recommendations

1. **Argv anti-pattern scanners (in place):** `checkExecLeadingRev.test.ts` + `checkPathspecCanonicalized.test.ts` scan the source tree for unsafe user-input interpolation into git argv and gate the build. Keep them green; extend the patterns if new argv shapes appear.

2. **Declarative Menu Structure:** Extract context-menu ordering and grouping into a centralized config (e.g., JSON or TypeScript const) that mirrors IntelliJ's action-group XML. Package.json menu contributions should be mechanically derived from this structure to ensure consistency.

3. **Action-ID Reconciliation Document:** Create `R2-shell-action-inventory.md` with the full 98-action cross-reference (IntelliJ ID, intellig command ID, status full/partial/missing, gap description). Use it to drive P2/P3 feature work.

4. **Command Title Linter:** Add a test that validates command titles against conventions (ellipsis for dialogs, no "Git:" prefix in title when category is "IntelliG", etc.).

---

## Edge Cases & Risks

- **Keybinding conflicts:** VS Code has default git keybindings (`Cmd+Shift+G`, etc.) that may conflict with IntelliJ-equivalent commands. Our package.json doesn't define many `contributes.keybindings` entries — users relying on IntelliJ muscle-memory keybindings will not find them. This is a P3 gap (not blocking but impacts migration UX).

- **Multi-repo commands:** Several commands (Update Project, bulk branch cleanup) are designed for multi-repo workspaces. Our implementation of multi-repo picker flows may not match IntelliJ's "Choose repositories" dialog. Verify consistency in multi-repo scenarios.

- **Command-palette-only commands:** Some IntelliJ actions are only accessible via menu, not the "Find Action" (Cmd+Shift+A) dialog. Our command-palette-all-visible approach is a VS Code convention, not a divergence, but means some rarely-used commands are more discoverable than in IntelliJ. Document this as an acceptable platform difference.

---

## Follow-Up Actions for Coder

1. **IMMEDIATE (Finding #1):** Audit all command handlers in `src/commands/registration/**` and `src/branches/BranchContextMenuCommands.ts` for argv construction using user input. Add `--end-of-options` guards where missing. Add a CI audit script that fails on unsafe argv patterns.

2. **HIGH PRIORITY (Finding #2):** Read IntelliJ action-group XML from `intellij-community/plugins/git4idea/frontend/resources/intellij.vcs.git.frontend.xml`, document canonical menu structure in `workspace-notes/parity/shell-menu-structure.md`, refactor `package.json` menu contributions to align.

3. **HIGH PRIORITY (Finding #3):** Create `workspace-notes/parity/R2-shell-action-inventory.md` with full 98-action cross-reference (IntelliJ ID, intellig command ID, status full/partial/missing, gap description). Use to drive P2/P3 feature work.

4. **MEDIUM PRIORITY (Finding #4):** Audit `package.json` command titles, standardize category usage, add ellipsis to dialog commands, align phrasing with IntelliJ action text.

5. **MEDIUM PRIORITY (Finding #5):** Inventory IntelliJ status-bar widget and tool-window title actions, compare with our `view/title` contributions, file gaps as P3/P4 parity items.
