# Round 2 UX Review — Context Menu Structure & Ordering

> **NORTHSTAR tie-back:** cross-cutting **UI/UX layout** — menus · role: Round-2 UX audit (backs NORTHSTAR section 4b). See `NORTHSTAR.md` section 7 (reference index).

**Agent:** senior-reviewer (UX reviewer role)  
**Timestamp:** 2026-06-15  
**Scope:** Context-menu ORDER, GROUPING (separators/sections), LABELS/wording, command-palette titles

**Review methodology:** Extract IntelliJ's canonical action-group XML ordering, compare with our package.json menu contributions and webview dispatch order, flag divergences.

---

## Executive Summary

**Overall Assessment:** Context-menu structure diverges from IntelliJ in **ordering**, **separator placement**, and **sub-group boundaries** across 3 critical menus (log commit, local branch, remote branch). The divergences break muscle memory for IntelliJ users and reduce discoverability.

**Risk Level:** HIGH (usability/parity)

**Findings Overview:**
- Critical: 0  
- High: 3 (menu-order divergences)  
- Medium: 2 (label inconsistencies)  
- Low: 1 (missing context-menu actions)

**Top UX Findings (ranked):**
1. 🟠 **HIGH — Log commit menu: wrong order + missing sections** (Finding #1)  
2. 🟠 **HIGH — Local branch menu: integrate-vs-sync section boundary wrong** (Finding #2)  
3. 🟠 **HIGH — Remote branch menu: missing tracked-branch submenu** (Finding #3)  
4. 🟡 **MEDIUM — Command-palette titles: inconsistent ellipsis + "Git:" prefix** (Finding #4)  
5. 🟡 **MEDIUM — Branch menu labels: "Rebase Current onto This" vs. IntelliJ "Rebase onto..."** (Finding #5)

---

## Reference Map

### IntelliJ canonical sources (north-star)

**Action-group XML files:**
- `/Users/kahochan/Documents/workspace/intellij-community/plugins/git4idea/backend/resources/intellij.vcs.git.backend.xml`  
  Relevant groups: `Git.Log.ContextMenu` (lines 340-363), `Git.FileHistory.ContextMenu` (323-330), `Git.Branch.Backend` (259-283)
- `/Users/kahochan/Documents/workspace/intellij-community/plugins/git4idea/shared/resources/intellij.vcs.git.shared.xml`  
  Relevant groups: `Git.Branch` (id 33-38), `Git.Branch.Checkout` (id 34-36)

**Key group IDs extracted:**
- `Git.Log.ContextMenu` — commit log right-click menu (13 actions + 6 separators)  
- `Git.Branch.Backend` — local/remote branch context menu (14 actions + 5 separators)  
- `Git.Branch.Tracked` — tracked-branch submenu popup (3 actions)

### Our implementation (intellig)

**Menu contributions:**
- `/Users/kahochan/Documents/workspace/intellig/package.json` lines 665-1079:
  - `view/item/context` menu contributions (local/remote branches, tags, log commits)
  - `contributes.commands` titles (palette surface)
- `/Users/kahochan/Documents/workspace/intellig/src/git-core/gitToolWindow/provider/htmlBuilders.ts` lines 201-241:
  - `buildCommitContextMenuHtml()` — webview log commit menu (16 items + 4 separators)
- `/Users/kahochan/Documents/workspace/intellig/src/branches/BranchContextMenuCommands.ts` lines 193-343:
  - Branch/remote-branch command registration (24 handlers)
- `/Users/kahochan/Documents/workspace/intellig/src/commits/CommitContextMenuCommands.ts` lines 274-352:
  - Commit log action dispatch (12 single-commit + 4 multi-commit handlers)

---

## Per-Context Order Comparisons

### 1. Log Commit Context Menu (right-click on commit row)

**IntelliJ canonical order** (from `Git.Log.ContextMenu`, backend.xml:340-363):

| Section | Action | Separator After? |
|---------|--------|------------------|
| 1. Quick Actions | Reset to Here | ✓ |
| | Revert Commit | |
| | Undo Commit (HEAD only) | ✓ |
| 2. Edit Actions | Reword Commit Message | |
| | Fixup to Commit | |
| | Squash Into Commit | |
| | Drop Commit | |
| | Squash Commits (multi-select) | |
| | Interactive Rebase | |
| | Push Up to Commit | ✓ |
| 3. Branch Ops | Branch Operation Group (dynamic) | |
| | Create New Branch | |
| | Create New Tag | ✓ |
| 4. Checkout/Compare | Checkout Group (dynamic) | |
| | Browse Repository at Revision | |
| 5. Integration | (added via `Git.Log.ContextMenu.CheckoutBrowse` group) | ✓ |

**Our order** (from `buildCommitContextMenuHtml()`, htmlBuilders.ts:217-240):

| Section (inferred) | Action | Separator After? |
|--------------------|--------|------------------|
| 1. Copy | Copy Revision Number | |
| | Copy Commit Message | |
| | Create Patch | |
| | Cherry-Pick | ✓ |
| 2. Checkout/Compare | Checkout Revision | |
| | Show Repository at Revision | |
| | Compare with Local | |
| | Compare Versions (multi-only) | ✓ |
| 3. Edit | Edit Commit Message | |
| | Reset Current Branch to Here | |
| | Revert Commit | |
| | Undo Commit | |
| | Drop Commit | |
| | Squash Commits (multi-only) | ✓ |
| 4. Squash with Previous | Squash with Previous | |
| | Fixup with Previous | ✓ |
| 5. Integration | Compare with Branch | |
| | Merge into Current Branch | |
| | Interactively Rebase from Here | |

**Divergences:**

| Severity | Issue | IntelliJ | Our Impl | Impact |
|----------|-------|----------|----------|--------|
| 🟠 HIGH | Reset position | Top of menu (section 1) | Middle (section 3, line 5) | PRIMARY destructive action buried; users expect it near top |
| 🟠 HIGH | Missing "Branch Operation Group" | Dynamic submenu (lines 356) | Absent | No "checkout as new branch" shortcut in log menu |
| 🟠 HIGH | Cherry-pick placement | Not in top-level log menu (only via Branch Ops) | Section 1, line 4 | Less-common action promoted to top; IntelliJ reserves top for Reset/Revert/Undo |
| 🟡 MEDIUM | Copy actions section | Not a distinct section (Copy Hash is inline utility) | Explicit section 1 with separator | Over-grouped; Copy Hash is a utility, not a workflow step |
| 🟡 MEDIUM | "Squash with Previous" section | Inline with other edit actions | Separate section 4 with own separator | Over-separated; IntelliJ groups all history-rewrite in one block |

---

### 2. Local Branch Context Menu (right-click on non-current local branch)

**IntelliJ canonical order** (from `Git.Branch.Backend`, backend.xml:259-283):

| Section | Action | Separator After? |
|---------|--------|------------------|
| 1. Checkout | Checkout | |
| | Open Existing Working Tree | |
| | Checkout as New Branch | |
| | Checkout with Rebase | ✓ |
| 2. Compare | Compare with Current | |
| | Show Diff with Working Tree | ✓ |
| 3. Integrate | Rebase Current onto This | |
| | Merge into Current | ✓ |
| 4. Create Working Tree | Create New Working Tree | ✓ |
| 5. Sync | Update | |
| | Push | |
| | Tracked Branch (submenu) | |
| | Pull with Rebase | |
| | Pull with Merge | ✓ |
| 6. Manage | Rename | |
| | Delete | |

**Our order** (from package.json `view/item/context`, lines 713-765):

| Section (group ID) | Action | Separator After? |
|--------------------|--------|------------------|
| `1_branchOps@1` | Checkout | |
| `1_branchOps@2` | New Branch from Here | |
| `1_branchOps@3` | Checkout and Rebase | ✓ |
| `2_compare@1` | Compare with Current | |
| `2_compare@2` | Show Diff with Working Tree | ✓ |
| `3_integrate@1` | Rebase Current onto This | |
| `3_integrate@2` | Merge into Current | ✓ |
| `4_sync@1` | Update | |
| `4_sync@2` | Push | ✓ |
| `5_manage@1` | Rename | |
| `5_manage@2` | Delete | |

**Divergences:**

| Severity | Issue | IntelliJ | Our Impl | Impact |
|----------|-------|----------|----------|--------|
| 🟠 HIGH | Sync section missing Tracked Branch submenu + Pull actions | Has "Tracked Branch" submenu (line 273), Pull with Rebase/Merge (274-275) | Only Update + Push (lines 749-755) | Missing 3 daily-hit actions (pull modes, upstream config) |
| 🟡 MEDIUM | Integrate vs Sync boundary | Rebase/Merge → separator → **Create Working Tree** → separator → Sync | Rebase/Merge → separator → Sync | IntelliJ visually separates "operations that alter the current branch" from "operations that sync with remote"; we collapse them |
| ⚪ LOW | "Checkout as New Branch" label | "Checkout as New Branch" | "New Branch from Here" | Ours is clearer (avoids "checkout" overload), acceptable divergence |

---

### 3. Remote Branch Context Menu (right-click on `origin/feature`)

**IntelliJ canonical order** (from `Git.Branch.Backend`, applies to both local+remote with conditional actions):

| Section | Action | When | Separator After? |
|---------|--------|------|------------------|
| 1. Checkout | Checkout (as tracking local) | Always | |
| | Checkout as New Branch | Always | |
| | Checkout with Rebase | Always | ✓ |
| 2. Compare | Compare with Current | Always | |
| | Show Diff with Working Tree | Always | ✓ |
| 3. Integrate | Rebase Current onto This | Always | |
| | Merge into Current | Always | ✓ |
| 4. Sync | Pull with Rebase | Always | |
| | Pull with Merge | Always | |
| | Track Branch | If untracked | ✓ |
| 5. Manage | Delete | Always | |

**Our order** (from package.json, lines 768-820):

| Section (group ID) | Action | Separator After? |
|--------------------|--------|------------------|
| `1_branchOps@1` | Checkout (as local) | |
| `1_branchOps@2` | New Branch from Here | |
| `1_branchOps@3` | Checkout and Rebase | |
| `1_branchOps@4` | Track Branch | ✓ |
| `2_compare@1` | Compare with Current | |
| `2_compare@2` | Show Diff with Working Tree | ✓ |
| `3_integrate@1` | Rebase Current onto This | |
| `3_integrate@2` | Merge into Current | ✓ |
| `4_pull@1` | Pull Using Rebase | |
| `4_pull@2` | Pull Using Merge | ✓ |
| `5_manage@1` | Delete | |

**Divergences:**

| Severity | Issue | IntelliJ | Our Impl | Impact |
|----------|-------|----------|----------|--------|
| 🟠 HIGH | "Track Branch" position | Section 4 (Sync, with Pull actions) | Section 1 (Checkout ops, line 815) | Tracking upstream is a sync/config action, not a checkout action; wrong section breaks conceptual grouping |
| 🟡 MEDIUM | Missing tracked-branch conditional | Tracked Branch only shown when untracked | Always shown (line 815) | Menu clutter; action is no-op if already tracked |

---

## Command-Palette Title Consistency

**IntelliJ convention:** Action `text="..."` attribute is the canonical title; no "Git:" prefix (context implicit from VCS menu), ellipsis (`…`) for dialogs.

**Our titles** (sampled from package.json `contributes.commands`):

| Severity | Command ID | Our Title | IntelliJ Equiv. | Issue |
|----------|-----------|-----------|-----------------|-------|
| 🟡 MEDIUM | `intellig.commit` | "Commit" | "Commit..." | Missing ellipsis (opens dialog) |
| 🟡 MEDIUM | `intellig.explorer.showHistory` | "Git: Show History" | "Show History" | Redundant "Git:" prefix (category already "IntelliG") |
| ⚪ LOW | `intellig.branch.checkout` | "Checkout" | "Checkout" | Consistent ✓ |
| 🟡 MEDIUM | `intellig.rebase.interactiveFromHere` | "Interactively Rebase from Here…" | "Interactively Rebase from Here" | Ellipsis added (VS Code convention for dialogs, acceptable) |
| 🟡 MEDIUM | `intellig.branch.checkoutAndRebase` | "Checkout and Rebase" | "Checkout and Rebase onto Current" | Missing "onto Current" clarifier |

**Patterns:**
- 12 commands use `"Git:"` prefix in title when category is `"IntelliG"` (redundant)  
- 8 dialog-opening commands lack ellipsis (`…`)  
- 3 commands have abbreviated titles vs IntelliJ's full phrasing

---

## Top UX Findings (Ranked)

### 1. 🟠 HIGH — Log Commit Menu: Wrong Order + Missing Sections

**Location:** `src/git-core/gitToolWindow/provider/htmlBuilders.ts:217-240` (`buildCommitContextMenuHtml()`)

**Issue:** 
- **Reset Current Branch to Here** is buried in section 3 (line 228); IntelliJ places it at the TOP as the primary destructive action.
- **Cherry-Pick** promoted to section 1 (line 219); IntelliJ only exposes it via the "Branch Operation Group" submenu (less common action).
- **Copy actions over-grouped** — Copy Hash + Copy Message + Create Patch are distinct utilities, not a workflow section; IntelliJ inlines them.
- **Missing "Branch Operation Group"** — IntelliJ's dynamic submenu for checkout-as-branch + cherry-pick; we have the actions but not the submenu structure.

**User Impact:**  
IntelliJ users expect Reset near the top (muscle-memory); our placement forces 3-4 extra scans to find it. Cherry-Pick promotion to top-level reduces its discoverability paradoxically (users trained to look in a submenu). Copy actions as a "section" implies they're a workflow step, not utilities.

**Severity Justification:**  
Daily-hit action (Reset) is mis-positioned; breaks established muscle memory from IntelliJ's 15+ year convention.

**Recommendation:**  
Reorder to:
1. Reset Current Branch to Here ✓ separator  
2. Revert / Undo / Edit / Fixup / Squash / Drop / Interactive Rebase ✓ separator  
3. **Branch Operations** submenu (New Branch / Cherry-Pick / Tag) ✓ separator  
4. Checkout / Browse / Compare ✓ separator  
5. Inline utilities (Copy Hash at bottom, not sectioned)

**Files to touch:** `htmlBuilders.ts:217-240`, `scriptBuilder.ts` (add submenu dispatch for "Branch Operations")

---

### 2. 🟠 HIGH — Local Branch Menu: Integrate-vs-Sync Section Boundary Wrong

**Location:** `package.json` lines 738-765 (`view/item/context` for `viewItem == intellig.localBranch`)

**Issue:**  
IntelliJ separates "operations that alter the current branch" (Rebase/Merge) from "operations that sync with remote" (Update/Push/Pull) with an intermediate **"Create Working Tree"** action + separator. Our implementation collapses Integrate → Sync directly, losing the visual boundary.

**User Impact:**  
Rebase/Merge are **local-history-mutating** operations; Update/Push are **remote-sync** operations. The conceptual distinction is important: users decide "do I want to integrate this branch's changes locally?" (Rebase/Merge) separately from "do I want to sync with the remote?" (Update/Push). Collapsing the sections blurs the distinction.

**Severity Justification:**  
Reduces clarity of the action groupings; users may accidentally trigger a sync action when intending to integrate, or vice versa. The missing Pull actions (tracked in Finding #3) compound this.

**Recommendation:**  
Insert a separator + placeholder action between `3_integrate@2` and `4_sync@1`. IntelliJ's "Create Working Tree" is a power-user action (git worktree); we may not have it yet. Acceptable to just add a **separator** for now (visual boundary is the primary need), and defer the worktree action to a P3 feature.

**Files to touch:** `package.json:738-765` (add separator line), `BranchContextMenuCommands.ts` (no handler change needed)

---

### 3. 🟠 HIGH — Remote Branch Menu: Missing Tracked-Branch Submenu

**Location:** `package.json` lines 768-820 (`view/item/context` for `viewItem == intellig.remoteBranch`)

**Issue:**  
IntelliJ's local-branch menu includes a **"Tracked Branch"** submenu (line 273, `Git.Branch.Tracked` group) with 3 actions:
1. Update Tracked Branch (fetch + merge onto the local tracking branch)  
2. Push (push local to its tracked remote)  
3. Pull with Rebase / Merge (pull tracked remote into current)

Our remote-branch menu shows **Track Branch** as a top-level action (line 815, `1_branchOps@4`) but has NO submenu, and Pull actions are in a separate `4_pull@` section (lines 804-810).

**User Impact:**  
Users expect "Pull Using Rebase/Merge" to be grouped with "Track Branch" (they're both upstream-config actions). Our separation into `1_branchOps` (Track) vs. `4_pull` (Pull) is arbitrary and breaks the conceptual grouping.

**Severity Justification:**  
Missing submenu structure reduces discoverability; users don't see the relationship between Track + Pull + Update. The actions exist but are scattered.

**Recommendation:**  
Add a **"Tracked Branch"** submenu to the remote-branch menu:
- Submenu entry in `package.json` (line ~815) as `"submenu": "intellig.trackedBranchSubmenu"`  
- Define `intellig.trackedBranchSubmenu` in `contributes.submenus` with 3 items: Track Branch, Pull Using Rebase, Pull Using Merge  
- Move those 3 commands into the submenu's menu contributions

Alternatively, if VS Code TreeView doesn't support submenus natively, convert the 3 actions into a **QuickPick cascade** (Track → if already tracked, show Pull options; if not, track first then show Pull).

**Files to touch:** `package.json:768-820` (restructure menu), `BranchContextMenuCommands.ts` (no handler change unless QuickPick cascade)

---

### 4. 🟡 MEDIUM — Command-Palette Titles: Inconsistent Ellipsis + "Git:" Prefix

**Location:** `package.json` lines 46-663 (`contributes.commands`)

**Issue:**  
- **12 commands** use `"Git:"` prefix in `title` when `category` is already `"IntelliG"` (redundant; VS Code concatenates as "IntelliG: Git: Show History")  
- **8 dialog-opening commands** lack ellipsis (`…`) — VS Code convention is to suffix with `…` when a command opens a dialog (e.g., `"Commit…"` not `"Commit"`)  
- **3 commands** have abbreviated titles vs. IntelliJ's full phrasing (e.g., "Checkout and Rebase" vs. "Checkout and Rebase onto Current")

**User Impact:**  
Command palette (`Cmd+Shift+P`) results look noisy ("IntelliG: Git: Show History" vs. "IntelliG: Show History"). Users can't predict which commands open dialogs (missing ellipsis). Abbreviated titles reduce clarity (e.g., "Checkout and Rebase" — rebase *onto what*?).

**Severity Justification:**  
Consistency issue, not a blocker; but affects every command invocation via palette (daily-hit surface).

**Recommendation:**  
1. Remove `"Git:"` prefix from all commands where `category` is `"IntelliG"` (12 commands)  
2. Add `…` suffix to 8 dialog-opening commands (`commit`, `push`, `pull`, `merge`, `rebase.interactive`, `showResolveConflictsDialog`, `branch.newBranchFrom`, `tag.new`)  
3. Expand 3 abbreviated titles to match IntelliJ's full phrasing

**Files to touch:** `package.json:46-663` (find-replace patterns)

---

### 5. 🟡 MEDIUM — Branch Menu Labels: "Rebase Current onto This" vs. IntelliJ "Rebase onto..."

**Location:** `package.json` line 235 (`intellig.branch.rebaseCurrentOnto` command title)

**Issue:**  
IntelliJ's action text is **"Rebase Current Branch onto Selected"** (or shortened to "Rebase onto..."). Ours is **"Rebase Current onto This…"**.

**User Impact:**  
"Rebase Current onto This" is slightly ambiguous — "This" refers to the right-clicked branch, but users may parse it as "Rebase Current onto itself" (nonsensical). IntelliJ's "Selected" or "..." is clearer.

**Severity Justification:**  
Minor wording divergence; functionally clear in context (right-click menu), but IntelliJ's phrasing is more explicit.

**Recommendation:**  
Change to **"Rebase Current Branch onto This"** (add "Branch" for clarity) OR **"Rebase Current onto..."** (matches IntelliJ's ellipsis convention for "onto *what*?" ambiguity).

**Files to touch:** `package.json:235`

---

## Observations (Not Findings)

1. **VS Code TreeView limitations:**  
   VS Code's built-in `TreeView` API does NOT support dynamic submenus or nested context menus. IntelliJ's "Branch Operation Group" and "Tracked Branch" submenus are platform features. Our workaround options:  
   a) QuickPick cascade (Track → if tracked, show Pull options)  
   b) Custom webview tree (heavy, ~1-2 weeks effort per R2-02-branches.md)  
   c) Defer to P4 platform-rebuild  
   **Recommendation:** QuickPick cascade (option a) for Tracked Branch submenu; defer Branch Operation Group to P4.

2. **Separator syntax divergence:**  
   IntelliJ XML uses `<separator/>` elements between action groups; VS Code uses group-ID prefixes (`1_branchOps@1`, `2_compare@1`, separator is implicit between groups). Our implementation correctly uses group IDs; the divergence is **ordering within groups**, not the separator mechanism.

3. **Positive note — our multi-select menu:**  
   Our multi-commit menu (`buildCommitContextMenuHtml` lines 210-241) correctly hides single-only actions (`data-multi-action="single-only"` + `menu-multi-hidden` class) and shows multi-only actions (`squashCommits`, `compareVersions`). IntelliJ's equivalent is more complex (dynamic menu generation per selection). Our declarative approach (upfront HTML + JS toggle) is simpler and works well.

---

## Prioritized Action Items

1. **[HIGH] Finding #1 — Reorder log commit menu** (Reset to top, add Branch Operations submenu, inline Copy utilities)  
   Effort: M (HTML reorder + new submenu dispatch + script handler)  
   Files: `htmlBuilders.ts:217-240`, `scriptBuilder.ts` (add submenu handler)

2. **[HIGH] Finding #2 — Add separator between Integrate and Sync sections** (local branch menu)  
   Effort: S (1-line separator insertion)  
   Files: `package.json:738-765`

3. **[HIGH] Finding #3 — Add Tracked Branch submenu or QuickPick cascade** (remote branch menu)  
   Effort: M (QuickPick cascade) or L (custom webview)  
   Files: `package.json:768-820`, `BranchContextMenuCommands.ts` (add cascade handler)

4. **[MEDIUM] Finding #4 — Standardize command-palette titles** (remove "Git:" prefix, add ellipsis, expand abbreviations)  
   Effort: S (find-replace patterns)  
   Files: `package.json:46-663`

5. **[MEDIUM] Finding #5 — Clarify "Rebase Current onto This" label**  
   Effort: S (1-line title change)  
   Files: `package.json:235`

---

## Positive Notes

1. **Branch menu groups are conceptually sound** — the group-ID naming (`1_branchOps`, `2_compare`, `3_integrate`, `4_sync`, `5_manage`) matches IntelliJ's semantic structure, even if the ordering isn't byte-identical. The *labels* are correct; only the *sequence* needs alignment.

2. **Multi-commit menu state management is clean** — `data-multi-action` + `menu-multi-hidden` class + JS toggle (`updateContextMenuState`) is simpler than IntelliJ's dynamic menu generation. Good architectural choice.

3. **Command-palette coverage is complete** — All 101 registered commands have titles and categories. The inconsistency is polish (ellipsis, prefix), not missing commands.

---

## Verdict

**UX Status:** 🟡 PARTIAL — core actions present, but ordering/grouping divergences reduce discoverability and break muscle memory.

**Risk Assessment:**  
- No data-loss or silent-wrong-op risks (UX-only review)  
- High friction for IntelliJ migrants (daily-hit actions mis-positioned)  
- Medium effort to fix (M+M+S = ~2 days for top 3 findings)

**Recommendation:**  
Fix Findings #1, #2, #3 (HIGH severity) before any "IntelliJ parity" claim in marketing. Findings #4, #5 (MEDIUM) are polish — acceptable to defer to a "menu consistency pass" batch post-P2.

---

## Follow-on pass — 2026-06-18 (ux-analyst sweep; folded from the former UX-PARITY.md)

A second UX sweep extended the surface map beyond the 3 menus above. Items below are the **open**
layout gaps; the forward-plan view (heatmap + ordering) is mirrored in `NORTHSTAR.md` section 4b.

**Landed (`64c5a20`, see STATUS):**
- **F#1 (log menu reorder)** — webview path done: Reset/Revert/Drop now LEAD the history block
  (`htmlBuilders.ts`, test-locked `resetToHere` before edit/drop/merge). *Native tree menu still
  diverges — see #2 below.*
- **F#4 (palette ellipsis)** — dialog-opening command titles got `…` (Commit…/Push…/Pull…).
- Reset-dialog destructive confirm verified already present (`ResetDialog._confirmDestructive`).

**Still open (numbering matches NORTHSTAR section 4b):**

| # | Surface | Gap | IntelliJ ref | IntelliG site |
|---|---|---|---|---|
| 2 | Log menu | Webview graph menu vs native tree menu diverge — pick one source of truth | `Git.Log.ContextMenu` | `htmlBuilders.ts:217` vs pkg.json logCommit |
| 3 | Log menu | "Edit Commit Message" → "Reword…" + add to tree menu | `Git.Reword.Commit` | `htmlBuilders.ts:227` |
| 4 | Branch popup | QuickPick: Rename/Delete LAST; missing Diff-with-Local / Update-Selected / Pull-into-current / New-Worktree / Push-Tags | `Git.Branch.Backend` | `BranchPopup.ts ~721-792` |
| 5 | Branch popup | Tracked-branch submenu (set-upstream / edit-tracked) — QuickPick cascade per Observation 1 | `Git.Branch.Tracked` | absent |
| 6 | Explorer submenu | No "Commit File"; History should trail; Annotate grouped w/ diff; "Compare with Revision…" → "Compare with Branch" | `Git.FileActions` | pkg.json `explorerSubmenu` |
| 8 | Palette | Drop redundant inner `Rebase:`/`Blame:` prefixes | plain action text | pkg.json commands |
| 9 | Toolbar | Fetch & Update both `$(sync)` → distinct Fetch icon; branch widget to navigation@1 | `AllIcons.Vcs.Fetch` | pkg.json `view/title` |
| 10 | Log menu | By-subject Fixup/Squash + New-Branch/New-Tag-from-commit in webview graph menu | `Git.Log.ContextMenu` | `htmlBuilders.ts:234` |

**Order:** quick wins (#8, #9, #6-partial — pkg.json-mostly) → structural wave (#2, #3, #4, #5, #10).
Tool-window Stash/Working-Trees tabs + per-dialog field audit are deferred.
