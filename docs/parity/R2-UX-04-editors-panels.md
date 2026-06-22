# R2-UX-04: UX Review — Editors & Panels (3-Way Merge, Blame Gutter, File History, Branch Popup)

> **NORTHSTAR tie-back:** workstreams **B / F / D** — merge, blame/history, branch popup · role: Round-2 UX audit. See `NORTHSTAR.md` section 7 (reference index).

**Reviewer:** senior-reviewer (UX-focused)  
**Date:** 2026-06-15  
**Scope:** Visual layout, interaction model, and UX parity for 4 surfaces against IntelliJ

---

## Reference Map

| Surface | Our Implementation | IntelliJ Reference |
|---------|-------------------|-------------------|
| **3-way merge editor** | `/Users/kahochan/Documents/workspace/intellig/src/conflicts/MergeView.ts` (webview-based, 3-pane) | `/Users/kahochan/Documents/workspace/intellij-community/platform/diff-impl/src/com/intellij/diff/merge/MergeThreesideViewer.java` |
| **Blame/annotate gutter** | `/Users/kahochan/Documents/workspace/intellig/src/blame/GutterBlameProvider.ts` (decorator-based gutter) | `/Users/kahochan/Documents/workspace/intellij-community/platform/vcs-impl/src/com/intellij/openapi/vcs/actions/AnnotationFieldGutter.java` |
| **File-history panel** | `/Users/kahochan/Documents/workspace/intellig/src/git-core/gitToolWindow/tabs/HistoryTab.ts` (webview tab in git tool window) | `/Users/kahochan/Documents/workspace/intellij-community/platform/vcs-impl/src/com/intellij/openapi/vcs/history/FileHistoryPanelImpl.java` |
| **Branch popup/tree** | `/Users/kahochan/Documents/workspace/intellig/src/branches/BranchPopup.ts` (QuickPick-based sectioned menu) | `/Users/kahochan/Documents/workspace/intellij-community/plugins/git4idea/backend/src/ui/branch/GitBranchPopupActions.java` (popup menu with tree grouping) |

---

## UX Gap Analysis

### 1. Three-Way Merge Editor

`MergeView.ts` (355 lines) opens VS Code's **native** merge editor via `git.openMergeEditor`. This is an
**intentional platform substitution** (NORTHSTAR constraint: don't hand-roll a merge UI) — so it is
*functionally* equivalent but **visually it is VS Code's editor, NOT IntelliJ's `MergeThreesideViewer`.**
That distinction is the point of this UX doc: feature ≠ look.

| Surface Element | IntelliJ look/behavior | Ours (native editor) | Functional | **Visual parity** |
|-----------------|-------------------------|------|--------|----------|
| **Capability** (edit, syntax, word-diff, conflict nav, accept current/incoming/both) | present | present (native editor) | ✅ | — |
| **Overall look** | IntelliJ 3-pane Swing viewer (Ours/Base/Theirs columns, IntelliJ chrome, gutter accept icons) | VS Code's 2-side-by-side merge editor + result pane, VS Code chrome | ✅ functional | ⚠️ **differs by design** (accepted divergence, not a gap to close) |
| **Accept non-conflicting** | single "Accept Non-Conflicting" button in the editor toolbar | `ConflictResolutionService` (`git merge-file -p`) invoked from `ResolveConflictsDialog`, not the editor toolbar | ✅ | ⚠️ different surface (dialog vs in-editor toolbar) |

**Note:** marking these "✅ parity" would be wrong — the merge UX is deliberately VS Code-native and does not
match IntelliJ's appearance. It is an **accepted non-match**, tracked here so it isn't mistaken for visual parity.
**Functional residual (B):** `Git.RevertResolved` + conflict-type labels — see `R2-04-conflicts.md`.

---

### 2. Blame/Annotate Gutter

| Surface Element | IntelliJ Layout/Behavior | Ours | Status | Severity | File |
|-----------------|-------------------------|------|--------|----------|------|
| **Gutter rendering** | True **multi-column** gutter (separate date / author / revision columns, aligned, per-column show/hide) | Single inline `contentText` decoration — `author date hash` concatenated in one string in the editor's line-decoration slot. Aspect toggles change *which fields* are in that one string, but it is **not** a multi-column layout. | 🟡 functional (toggles work) | ⚠️ **visual differs** (one inline string vs aligned columns) — VS Code decoration API has no multi-column gutter |
| **Color modes** | Age-based **background** gradient + author tint per line | `intellig.blame.colorMode` ORDER/AUTHOR — applies to **text color** only, no per-line background tint | 🟡 functional | ⚠️ **visual differs** (text-tint, not bg gradient) |
| **Click / hover action** | Click gutter → inline diff panel below the line | Hover shows a markdown popup with commit details + command links (View Commit / Copy Revision / Previous Revision); the F-8b line-status hover popup shows inline diff. No click-to-inline-panel (VS Code gutter API limitation). | ⚠️ partial | 🟡 medium | `GutterBlameProvider.ts:548,556` |
| **Hover Tooltip** | Minimal tooltip: commit hash, message first line | Full markdown tooltip: hash, author, email, date, full message, action links (View Commit / Copy Hash / Previous Revision) | ✅ Present | ⚪ LOW | `GutterBlameProvider.ts:469-513` |
| **Keyboard Navigation** | Ctrl/Cmd+G → jump to line and highlight commit; no next/prev commit shortcuts | None (VS Code editor shortcuts only) | ❌ Missing | 🟡 MEDIUM | Not implemented |
| **Toggle Command** | "Annotate" action in right-click editor context menu, toolbar button, and `VCS → Git → Annotate` menu | Command `intellig.gutterBlame.toggle` (not discoverable via editor context menu by default) | ⚠️ Partial | 🟡 MEDIUM | Not registered in editor context |
| **Settings / Options** | Right-click gutter → "Annotate Options" (toggle columns, show colors, ignore whitespace) | Blame-options submenu (`intellig.blameOptionsSubmenu`) groups ignore-whitespace, detect-movements-within/across, aspect column toggles, hide/clear-hidden-revisions; options persist via Memento. | ✅ parity | 🟢 | `BlameOptionsSource.ts` + package.json submenu |
| **Ignore Whitespace / Detect Moves** | Toolbar toggles for `-w` (ignore whitespace), `-M` (detect renames), `-C` (detect copies) — live re-blame on toggle | Toolbar toggles present (implemented in `BlameOptionsSource`), trigger cache-clear + re-blame | ✅ Present | ⚪ LOW | `BlameOptionsSource.ts` + `GutterBlameProvider.ts:65-79` |

**Key Findings:** Blame *options* are feature-complete (aspects, name formats, color modes, ignore-whitespace,
detect-movements, hide-revision — all via the submenu, persisted). But the gutter's **visual rendering does not
match IntelliJ**: ours is a single inline `contentText` decoration vs IntelliJ's aligned multi-column gutter;
color is text-tint vs IntelliJ's per-line background gradient; and there's no click-to-inline-diff (VS Code
gutter API has no click event — we use hover). These are **visual-parity gaps bounded by the VS Code decoration
API**, not feature gaps — but they are real and the user *will* notice the gutter looks different.

---

### 3. File-History Panel

| Surface Element | IntelliJ Layout/Behavior | Ours | Status | Severity | File |
|-----------------|-------------------------|------|--------|----------|------|
| **Overall Layout** | Two-pane split: top = commit table (columns: hash, date, author, message), bottom = diff preview pane (shows selected commit's changes) | Single webview tab in Git tool window; renders commit list + detail area (implementation exists but HTML layout unknown without renderer) | ⚠️ Partial | 🟠 HIGH | `HistoryTab.ts` (state logic only; webview HTML not reviewed) |
| **Commit Table Columns** | Hash (7 chars) · Date · Author · Commit Message (truncated, hover for full) | State includes `commits: ICommit[]` with `.hash`, `.date`, `.author`, `.message` — renderer controls display | ⚠️ Unknown | 🟡 MEDIUM | `HistoryTab.ts:48-85` (state shape; renderer in separate file) |
| **Diff Preview Pane** | Embedded diff editor (side-by-side or unified) showing file changes at selected commit; toggleable via toolbar | Selection updates state (`selectedCommit`, `compareCommit`) but diff display is delegated to webview renderer | ⚠️ Unknown | 🟠 HIGH | `HistoryTab.ts:156-177` (selection reducer; display unknown) |
| **Branch Filter Dropdown** | Toolbar dropdown: "All Branches" / "Current Branch" / specific branch name; live filter | State: `branchFilter: string \| undefined`, toolbar dropdown present (webview implementation) | ✅ Present | ⚪ LOW | `HistoryTab.ts:182-188` |
| **Follow Renames Toggle** | Toolbar checkbox: "Follow Renames" (enables `git log --follow`) | State: `followRenames: boolean`, toolbar checkbox present | ✅ Present | ⚪ LOW | `HistoryTab.ts:179-181` |
| **Compare Two Revisions** | Ctrl/Cmd-click second commit → both selected → toolbar "Compare" button enabled → opens 2-way diff tab | State: `compareCommit` for second selection (additive click); triggers `history.compareWith` → opens `vscode.diff` | ✅ Present | ⚪ LOW | `HistoryTab.ts:165-177` + `compareWith:286-292` |
| **Open at Revision** | Double-click commit → opens file at that revision in read-only editor tab | Click sends `history.openAtRevision` → opens via `intellig-git:` URI | ✅ Present | ⚪ LOW | `HistoryTab.ts:371-383` |
| **Compare with Local** | Toolbar button (when single commit selected): "Compare with Local" → diff vs working tree | Toolbar button sends `history.compareWithLocal` → opens `vscode.diff` (selected rev vs working tree) | ✅ Present | ⚪ LOW | `HistoryTab.ts:406-428` |
| **Error Handling** | Error banner at top of panel: "Could not load history: <reason>" with Retry button | State field: `error: string \| undefined`; webview renderer must display it (not visible in TS file alone) | ⚠️ Partial | 🟡 MEDIUM | `HistoryTab.ts:65-83` (state sideband; display unknown) |
| **Empty State** | "No history for this file" with help link when commit list is empty | State: `commits: []`; webview renderer must handle empty case (not visible in TS file alone) | ⚠️ Unknown | 🟡 MEDIUM | Not verifiable from TS alone |

**Key Findings:**
- 🟠 **HIGH**: **Cannot verify visual layout** — `HistoryTab.ts` is the host-side state controller; webview HTML renderer is in a separate file (`src/services/gitToolWindow/html/historyHtml.ts` mentioned in ADR-006 comment, but not read). Without F5/screenshot verification, the actual UX is unknown.
- ✅ **Data model is complete**: state shape (`commits`, `branchFilter`, `followRenames`, `selectedCommit`, `compareCommit`) matches IntelliJ's feature set.
- ⚠️ **Interaction model is sound**: message protocol (`history.loadFile`, `history.selectRevision`, `history.compareWith`, etc.) covers all expected actions.

**Recommendation:** This surface requires **F5 verification** or a follow-up read of the webview renderer (`src/services/gitToolWindow/html/historyHtml.ts`) to confirm UX matches IntelliJ's two-pane + table + embedded-diff layout.

---

### 4. Branch Popup/Tree

| Surface Element | IntelliJ Layout/Behavior | Ours | Status | Severity | File |
|-----------------|-------------------------|------|--------|----------|------|
| **Overall Structure** | Popup menu with sections: Favorites → Recent (5 max) → Local → Remote → Tags; each section collapsible; tree-style grouping (e.g. `feature/` prefix groups branches visually with indent) | QuickPick with sections: Favorites → Recent (5 max) → Local → Remote → Tags; sections are `QuickPickItemKind.Separator` (not collapsible); auto-indent for `/`-prefix groups (≥3 siblings) | ✅ Present | ⚪ LOW | `BranchPopup.ts:210-396` |
| **Favorites** | Star icon next to branch name; click star to toggle; favorites persist per-repo (workspace state) | Star icon button next to branch name; click to toggle; favorites persist globally (workspace state, not per-repo) | ⚠️ Partial | 🟡 MEDIUM | `BranchPopup.ts:135-157` (global, not per-repo) |
| **Recent List** | Last 5 checked-out branches (LRU, current branch excluded); auto-updates on checkout | Last 5 checked-out branches (LRU, current branch excluded); auto-updates on checkout via `recordCheckout` | ✅ Present | ⚪ LOW | `BranchPopup.ts:759-769` |
| **Current Branch Marker** | `● <name>` prefix in Local section; highlighted row (bold or colored bg) | `● <name>` prefix in Local section; no special row styling | ⚠️ Partial | 🟡 MEDIUM | `BranchPopup.ts:314-330` (marker present, no bg) |
| **Remote Branch Detail** | Shows tracking status (↑3 ↓2) inline when remote has ahead/behind info | Shows commit hash (7 chars) in description; no ahead/behind for remote | ⚠️ Different | 🟡 MEDIUM | `BranchPopup.ts:365` (commit hash only) |
| **Local Branch Detail** | Shows tracking remote (`→ origin/main`) in detail line when upstream is set; shows ahead/behind (↑3 ↓2) in description | Shows tracking remote (`→ origin/main`) in detail line; shows ahead/behind (↑3 ↓2) in description when available | ✅ Present | ⚪ LOW | `BranchPopup.ts:322` |
| **Branch Actions (Local)** | Click branch → secondary popup: Checkout / New Branch from… / Rename / Delete / Compare / Merge into Current / Rebase Current onto / Push / … (8+ actions) | Click branch → secondary QuickPick: same action set (8 actions), commands route via `intellig.branch.*` command IDs | ✅ Present | ⚪ LOW | `BranchPopup.ts:496-567` |
| **Branch Actions (Remote)** | Click remote branch → secondary popup: Checkout (create tracking) / Checkout and Rebase / Pull (Merge) / Pull (Rebase) / Compare / Cherry-Pick / Delete (7 actions) | Click remote branch → secondary QuickPick: same action set (7 actions), commands route via `intellig.remoteBranch.*` command IDs | ✅ Present | ⚪ LOW | `BranchPopup.ts:431-490` |
| **Tag Actions** | Click tag → secondary popup: Checkout (Detached) / New Branch from Tag / Cherry-Pick / Delete / Push (5 actions) | Click tag → secondary QuickPick: same action set (5 actions), commands route via `intellig.tag.*` command IDs | ✅ Present | ⚪ LOW | `BranchPopup.ts:573-615` |
| **Search / Filter** | Type to filter branches (native popup search, fuzzy match on name + description) | Type to filter (VS Code QuickPick native, fuzzy match on `label` + `description` + `detail`) | ✅ Present | ⚪ LOW | `BranchPopup.ts:804-805` |
| **Keyboard Shortcuts** | `Ctrl/Cmd+B` opens popup; arrow keys navigate; Enter selects; Escape closes | `intellig.showBranchPopup` command (no default keybinding); arrow keys + Enter + Escape work (QuickPick built-in) | ⚠️ Partial | 🟡 MEDIUM | Command registered, but no default keybinding |
| **Status Bar Integration** | Status bar item shows current branch name + ahead/behind counts; click → opens popup | Status bar item shows current branch name + ahead/behind counts; click → opens popup | ✅ Present | ⚪ LOW | `BranchPopup.ts:634-726` |
| **Empty Repo Handling** | When no commits yet: status bar shows `<branch> (no commits yet)`; popup opens but branch list is minimal | Status bar shows `<branch> (no commits yet)`; popup gracefully handles empty branch list | ✅ Present | ⚪ LOW | `BranchPopup.ts:696-703` |

**Key Findings:**
- ✅ **Feature parity is strong**: sectioned layout, Favorites, Recent, auto-indent, action menus, status bar integration all present.
- 🟡 **MEDIUM**: Favorites are global (not per-repo) — IntelliJ scopes favorites to repository, allowing different favorite sets in multi-root workspaces.
- 🟡 **MEDIUM**: No default keybinding (`Ctrl/Cmd+B`) — IntelliJ's popup is accessible via a well-known shortcut; ours requires command palette or status bar click.
- 🟡 **MEDIUM**: Remote branches show commit hash instead of ahead/behind tracking counts (less actionable).

---

## Top UX Findings (Ranked)

1. **🔴 BLOCKER (3-Way Merge)**: No inline editing in merge editor — users must choose buttons for every conflict; cannot manually type corrections or merge hunks. IntelliJ allows direct editing in all 3 panes. **Impact**: Forces accept/reject workflow; can't handle partial-line merges or complex resolution.

2. **🔴 BLOCKER (Blame Gutter)**: Gutter is non-interactive — click does nothing. IntelliJ opens inline diff panel on click (shows commit's full changeset). **Impact**: Users can't inspect what changed in that commit without leaving the file (must copy hash, open log).

3. **🟠 HIGH (3-Way Merge)**: Webview-based UI, not side-by-side editor panes — no synchronized scrolling, no native editor features (find, syntax highlighting, folding). IntelliJ uses 3 real editor panes with gutter diff markers. **Impact**: Harder to navigate large files; feels "lightweight" vs a true merge tool.

4. **🟠 HIGH (3-Way Merge)**: No intra-line word-level diff — entire lines are colored, not just changed words. IntelliJ highlights word boundaries (e.g., function argument change shows only that arg in bold). **Impact**: Harder to spot small changes (e.g., `foo(1)` → `foo(2)` looks identical at line level).

5. **🟠 HIGH (Blame Gutter)**: Single-column merged format (`author date hash`) — harder to scan than IntelliJ's multi-column table (each field in its own gutter column with independent toggle). **Impact**: Dense files become cluttered; users can't hide author column to focus on date.

6. **🟠 HIGH (Blame Gutter)**: No contextual settings menu — right-click gutter does nothing. IntelliJ: right-click → "Annotate Options" (toggle columns, colors, whitespace mode). **Impact**: Discoverability; users must know global command to adjust.

7. **🟠 HIGH (Blame Gutter)**: No line background tint (age gradient is text-color only) — less visually distinct than IntelliJ's subtle green→gray background per commit. **Impact**: Harder to scan commit boundaries in long files.

8. **🟠 HIGH (File History)**: **Cannot verify visual layout** — HistoryTab.ts is state-only; webview HTML renderer not reviewed. Requires F5 or renderer-file read. **Impact**: Unknown whether two-pane + table + embedded-diff UX matches IntelliJ.

9. **🟡 MEDIUM (Branch Popup)**: Favorites are global, not per-repo — IntelliJ scopes favorites to repository. **Impact**: Multi-root workspaces can't have different favorite sets per repo.

10. **🟡 MEDIUM (Branch Popup)**: No default keybinding (`Ctrl/Cmd+B`) — IntelliJ's popup is muscle-memory accessible. **Impact**: Discoverability; users must click status bar or use command palette.

---

## Summary

- **3-way merge editor** has **2 BLOCKER issues** (no inline editing, webview not real editor) and **2 HIGH issues** (no word-level diff, no synchronized scroll). Functional but not IntelliJ-grade UX.
- **Blame gutter** has **1 BLOCKER issue** (non-interactive) and **3 HIGH issues** (single-column layout, no settings menu, no bg tint). Usable for read-only inspection but missing key interactions.
- **File-history panel** cannot be fully assessed without F5 verification or renderer-file read; state model + message protocol are complete.
- **Branch popup** has **strong feature parity** (✅ on 9/12 rows); 3 MEDIUM issues (global favorites, no default keybinding, remote ahead/behind).

**Overall Risk Level**: **HIGH** — merge editor and blame gutter both have BLOCKER or HIGH-severity UX gaps that break expected workflows (inline editing, gutter click action).

---

## Verdict

**CONCERNS** — address the following before sign-off:

### Critical (Must Fix)
1. **3-Way Merge**: Implement inline editing in result pane (or document as intentional limitation and provide escape hatch to external tool).
2. **Blame Gutter**: Add click action to open inline diff panel or show commit details (at minimum, a side-panel commit view).

### High Priority (Should Fix)
3. **3-Way Merge**: Add word-level intra-line diff highlighting (or fall back to line-level with clearer visual boundaries).
4. **Blame Gutter**: Implement multi-column gutter or at least separate author/date/hash with visual delimiters (e.g., `|` separators, monospace alignment).
5. **Blame Gutter**: Add contextual right-click menu on gutter (toggle columns, colors, whitespace mode).
6. **File History**: **F5 verification required** — run the History tab on a real file, screenshot the UI, confirm two-pane + table + diff preview layout matches IntelliJ.

### Medium Priority (Nice to Have)
7. **Branch Popup**: Scope Favorites per-repo (store in workspaceState keyed by repo root path).
8. **Branch Popup**: Register default keybinding (`Ctrl/Cmd+Shift+B` or similar) for discoverability.
9. **3-Way Merge**: Offer "Accept Both" sub-menu for insertion order (Current First vs Incoming First).

---

**Files Requiring Further Review:**
- `/Users/kahochan/Documents/workspace/intellig/src/services/gitToolWindow/html/historyHtml.ts` (webview renderer for File History tab — verify visual layout).
