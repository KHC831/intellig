# Cluster B Design: Dialogs & Menus
## T1-07, T1-09, T1-10, T1-11, T1-12

---

## 1. Command & Label Mapping Table

| IntelliJ Surface | IntelliJ Label | Current/New Command ID | Menu Group | Status |
|---|---|---|---|---|
| **Log commit context** | Copy Revision Number | `intellig.commit.copyHash` (rename label only) | `view/item/context` | rename |
| **Log commit context** | New Branch… | `intellig.commit.newBranch` (NEW) | `view/item/context` | new command |
| **Log commit context** | New Tag… | `intellig.commit.newTag` (NEW; delegates to T1-09) | `view/item/context` | new command |
| **Log commit context** | Checkout Revision | `intellig.commit.checkoutRevision` (exists) | `view/item/context` | reuse |
| **Log commit context** | Reset Current Branch to Here… | `intellig.commit.resetToHere` (exists; add T1-11 dialog) | `view/item/context` | enhance |
| **Log commit context** | Revert Commit | `intellig.commit.revert` (exists) | `view/item/context` | reuse |
| **Log commit context** | Cherry-Pick | `intellig.commit.cherryPick` (exists) | `view/item/context` | reuse |
| **Log commit context** | Show Diff | `intellig.commit.showDiff` (NEW) | `view/item/context` | new command |
| **Log commit context** | Compare with HEAD | `intellig.commit.compareWithHead` (NEW) | `view/item/context` | new command |
| **Log commit context** | Compare with… | `intellig.commit.compareWith` (NEW) | `view/item/context` | new command |
| **Log commit context** | Show File in Revision | `intellig.commit.showFileInRevision` (NEW) | `view/item/context` | new command |
| **Log commit context** | File History from Here | `intellig.commit.fileHistoryFromHere` (NEW) | `view/item/context` | new command |
| **Log commit context** | Interactively Rebase from Here… | `intellig.rebase.interactiveFromHere` (NEW) | `view/item/context` | new command |
| **Log commit context** | Create Patch… | `intellig.commit.createPatch` (exists) | `view/item/context` | reuse |
| **Tag tree context** | Checkout (Detached) | `intellig.tag.checkoutDetached` (exists) | `view/item/context` | reuse |
| **Tag tree context** | New Branch from Here | `intellig.tag.newBranchFrom` (exists) | `view/item/context` | reuse |
| **Tag tree context** | Cherry-Pick | `intellig.tag.cherryPick` (exists) | `view/item/context` | reuse |
| **Tag tree context** | Delete | `intellig.tag.delete` (exists) | `view/item/context` | reuse |
| **Tag tree context** | Push | `intellig.tag.push` (exists) | `view/item/context` | reuse |
| **Branches popup (new)** | Section header | (tree structure, no commands) | (N/A) | structural |
| **Branches popup search** | (search/filter UI) | (N/A) | (N/A) | structural |
| **Branches popup (new)** | Recent (section) | (UI section, no command) | (N/A) | structural |
| **Reset dialog (new)** | (four-radio modal) | `intellig.commit.resetToHere` invokes modal | (N/A) | dialog |
| **Apply Patch dialog (new)** | Apply Patch | `intellig.patch.apply` (NEW) | File context menu or command palette | new command |
| **Apply Patch dialog (new)** | Create Patch from Local Changes | `intellig.patch.createFromLocal` (NEW) | Commit tool window context | new command |

**Legend:**
- **new command**: command ID doesn't exist; must register in extension.ts + package.json
- **rename**: command exists; change displayed label only (package.json `"title"`)
- **enhance**: command exists; upgrade implementation (e.g., add modal dialog)
- **reuse**: command exists, working as-is
- **structural**: UI layout only (no command registration)

---

## 2. Per-Item Designs

### T1-09: New Tag Dialog & Tag Menu (Foundation for T1-07)

**Entry points:**
- Log commit context menu → `"New Tag…"` (command: `intellig.commit.newTag`)
- Tag tree: right-click existing tag → `"Delete"` / `"Push"` / `"Checkout"` (existing commands)
- Command palette: `IntelliG: Create Tag`

**UX flow:**
1. User clicks `"New Tag…"` on a commit in log, or invokes `intellig.commit.newTag`
2. QuickPick dialog appears with fields:
   - Tag name (text input, required)
   - Annotation message (optional; if provided → annotated tag; else lightweight)
3. User presses Enter or clicks "Create"
4. GitService.createTag(repo, name, message, ref) executes
5. Tag added to tree view; BranchTreeProvider refreshes
6. Confirmation toast: "Created tag: <name>"

**UI mockup (QuickPick):**
```
┌─ Create Tag ───────────────────────┐
│ Tag name: [feature/v1.0.0________] │
│ Message:  [optional; press Tab____] │
│           [e.g., "Release 1.0"]    │
├────────────────────────────────────┤
│ Create    Cancel                   │
└────────────────────────────────────┘
```

**Webview vs QuickPick:** QuickPick (simple, minimal)

**Dependencies:**
- None (upstream); T1-07 depends on this

**Data-loss guards:**
- No destructive operation; tag exists after create

---

### T1-07: Log Commit Right-Click Menu Parity

**Entry points:**
- Log panel (git graph) → right-click commit
- Menu surfaces in `package.json`: `"when": "viewItem == intellig.logCommit"` in `view/item/context`

**New commands needed** (from mapping table above):
- `intellig.commit.newBranch` — prompt for branch name
- `intellig.commit.newTag` — delegates to T1-09 dialog
- `intellig.commit.showDiff` — open diff editor for commit vs. parent
- `intellig.commit.compareWithHead` — diff vs. HEAD
- `intellig.commit.compareWith` — QuickPick branch/commit to diff against
- `intellig.commit.showFileInRevision` — QuickPick file from commit, open read-only view
- `intellig.commit.fileHistoryFromHere` — show file history starting from this commit
- `intellig.rebase.interactiveFromHere` — interactive rebase starting from this commit

**UX flows (example: New Branch):**
1. User right-clicks commit → `"New Branch…"`
2. Input dialog: "Branch name:"
3. BranchPopup.validateBranchName() checks; if invalid, show error toast
4. GitService.createBranch(repo, name, ref) creates tracking branch
5. Confirm: "Branch created: <name>"

**Menu structure in package.json:**
```json
{
  "command": "intellig.commit.copyHash",
  "title": "Copy Revision Number",
  "when": "viewItem == intellig.logCommit",
  "group": "1_copy@1"
},
{
  "command": "intellig.commit.newBranch",
  "title": "New Branch…",
  "when": "viewItem == intellig.logCommit",
  "group": "2_create@1"
},
{
  "command": "intellig.commit.newTag",
  "title": "New Tag…",
  "when": "viewItem == intellig.logCommit",
  "group": "2_create@2"
},
{
  "command": "intellig.commit.checkoutRevision",
  "title": "Checkout Revision",
  "when": "viewItem == intellig.logCommit",
  "group": "3_checkout@1"
},
{
  "command": "intellig.commit.resetToHere",
  "title": "Reset Current Branch to Here…",
  "when": "viewItem == intellig.logCommit",
  "group": "4_reset@1"
}
```

**Dependencies:**
- T1-09 (New Tag)
- T1-11 (Reset dialog)

---

### T1-11: Reset Dialog (Data-Loss Guard)

**Entry points:**
- Log context menu → `"Reset Current Branch to Here…"` (command: `intellig.commit.resetToHere`)
- Branch context menu: "Reset…" (if added)

**UX flow:**
1. User selects commit in log → `"Reset Current Branch to Here…"`
2. Modal dialog appears with four radio buttons:
   - ⦿ **Soft** — *Keep changes staged* (index = commit, working tree unchanged)
   - ⦾ **Mixed** — *Keep changes unstaged* (index reset, working tree unchanged) [default]
   - ⦾ **Hard** — *Discard all changes* [WARN]
   - ⦾ **Keep** — *Discard committed, keep local* [WARN]
3. Display target commit hash in dialog
4. User selects radio + clicks "Reset" or "Cancel"
5. For **Hard** or **Keep**: show confirmation modal — *"This will discard all changes. Continue?"*
6. On confirm: GitService executes `git reset --<mode> <commit>`
7. Toast: "Reset to <hash>" or error if pre-flight checks fail

**Safety policy (per feedback_data_loss_confirms.md):**
- Hard/Keep → single confirm modal (not double-confirm; current approach is correct)
- Default to Mixed (non-destructive)
- No inline-warnings in dialog; just confirm modal before exec

**Webview vs QuickPick:** Webview (modal with radios + confirm)

**ASCII mockup:**
```
┌─ Reset Current Branch ──────────────────┐
│ Target: a1b2c3d (feat: add feature)     │
│                                         │
│ ⦿ Soft     (changes staged)             │
│ ⦾ Mixed    (changes unstaged) [default] │
│ ⦾ Hard     (discard all) ⚠              │
│ ⦾ Keep     (keep uncommitted) ⚠         │
├─────────────────────────────────────────┤
│ Reset          Cancel                   │
└─────────────────────────────────────────┘

[On Hard/Keep selection:]
┌─ Confirm Reset ─────────────────────────┐
│ This will discard all changes.          │
│ Continue?                               │
├─────────────────────────────────────────┤
│ Reset          Cancel                   │
└─────────────────────────────────────────┘
```

**Dependencies:**
- None (upstream); T1-07 depends on label parity

---

### T1-10: Branches Popup Redesign (Sections + Search + Favorites)

**Entry points:**
- VCS widget (status bar)
- `intellig.showBranchPopup` command (Alt+` or Cmd+Shift+`)

**Structural changes:**
- Replace flat branch list with sectioned QuickPick:
  - **Recent** (≤5 most-recently-checked-out branches)
  - **Local** (all local branches, current highlighted)
  - **Remote** (all remote branches)
  - **Tags** (all tags, collapse-able section)
  - **Favorites** (starred/pinned branches, pinned to top)
- Add search/filter field at top
- Auto-group branches by `/` prefix (e.g., `feature/add-*`, `bugfix/fix-*`)

**UX flow:**
1. User presses Alt+` (or Cmd+Shift+`)
2. BranchPopup.show() opens QuickPick with sectioned items
3. User types to search (regex or literal; configurable)
4. On selection:
   - If local/remote branch → checkout (or show context menu for merge/rebase/etc.)
   - If tag → show tag context menu (checkout, cherry-pick, delete, push)
   - If favorite → prioritize in sort order
5. Context menu on branch → merge / rebase / delete / rename / compare / etc.

**Webview vs QuickPick:** QuickPick with separators (VS Code native)

**ASCII mockup:**
```
┌─ Quick Branch Switcher ────────────────┐
│ [search: ____________________]          │
├────────────────────────────────────────┤
│ ► Recent                               │
│   feature/auth                         │
│   main                                 │
│ ► Local Branches                       │
│   ★ feature/dashboard (pinned)         │
│   ● main (current)                     │
│   develop                              │
│   feature/api                          │
│ ► Remote Branches                      │
│   origin/main                          │
│   origin/feature/auth                  │
│ ► Tags                                 │
│   v1.0.0                               │
│   v1.1.0                               │
└────────────────────────────────────────┘
```

**Dependencies:**
- T1-09 (for tag menu integration)
- T1-07 (optional; UI parity benefit)

**Note:** Favorite toggle not wired in current codebase; MVP can defer starring.

---

### T1-12: Apply Patch Dialog

**Entry points:**
- Command palette → `IntelliG: Apply Patch`
- File context menu (future): right-click → `"Apply Patch…"`
- Shelf context menu: `"Import Patches…"` (future)

**UX flow:**
1. User invokes `intellig.patch.apply`
2. Dialog appears: `"Select patch file"` (file picker)
3. Optional: base-directory mapping UI (if paths don't align)
4. Optional: show diff preview (red = conflicts)
5. Checkbox: `"Assign to changelist"` (if T1-06 changelist UI exists)
6. On confirm: `GitService.applyPatch(repo, filePath, options)` or `git apply`
7. Toast: `"Patch applied"` or error with conflicted file list

**Create Patch from Local Changes:**
1. User in Commit tool window → right-click changelist → `"Create Patch…"`
2. Dialog: name, path to save (or clipboard)
3. `GitService.createPatch(repo, files, reverse?, outputPath?)` generates patch
4. Toast: `"Patch created: <path>"`

**Webview vs QuickPick:** Webview (file picker + optional diff preview)

**Dependencies:**
- T1-06 (changelist UI for assign-to-changelist option)

**Note:** Patch functionality is advanced; MVP can implement minimal version without diff preview.

---

## 3. Package.json Delta

**Commands section (add to existing array):**
```json
{
  "command": "intellig.commit.newBranch",
  "title": "New Branch…",
  "category": "IntelliG"
},
{
  "command": "intellig.commit.newTag",
  "title": "New Tag…",
  "category": "IntelliG"
},
{
  "command": "intellig.commit.showDiff",
  "title": "Show Diff",
  "category": "IntelliG"
},
{
  "command": "intellig.commit.compareWithHead",
  "title": "Compare with HEAD",
  "category": "IntelliG"
},
{
  "command": "intellig.commit.compareWith",
  "title": "Compare with…",
  "category": "IntelliG"
},
{
  "command": "intellig.commit.showFileInRevision",
  "title": "Show File in Revision",
  "category": "IntelliG"
},
{
  "command": "intellig.commit.fileHistoryFromHere",
  "title": "File History from Here",
  "category": "IntelliG"
},
{
  "command": "intellig.rebase.interactiveFromHere",
  "title": "Interactively Rebase from Here…",
  "category": "IntelliG"
},
{
  "command": "intellig.patch.apply",
  "title": "Apply Patch…",
  "category": "IntelliG"
},
{
  "command": "intellig.patch.createFromLocal",
  "title": "Create Patch from Local Changes",
  "category": "IntelliG"
},
{
  "command": "intellig.commit.resetToHere",
  "title": "Reset Current Branch to Here…",
  "category": "IntelliG"
}
```

**Menus section (add under `view/item/context`):**
```json
{
  "command": "intellig.commit.copyHash",
  "when": "viewItem == intellig.logCommit",
  "group": "1_copy@1",
  "title": "Copy Revision Number"
},
{
  "command": "intellig.commit.newBranch",
  "when": "viewItem == intellig.logCommit",
  "group": "2_create@1"
},
{
  "command": "intellig.commit.newTag",
  "when": "viewItem == intellig.logCommit",
  "group": "2_create@2"
},
{
  "command": "intellig.commit.checkoutRevision",
  "when": "viewItem == intellig.logCommit",
  "group": "3_checkout@1"
},
{
  "command": "intellig.commit.resetToHere",
  "when": "viewItem == intellig.logCommit",
  "group": "4_reset@1"
},
{
  "command": "intellig.commit.revert",
  "when": "viewItem == intellig.logCommit",
  "group": "5_modify@1"
},
{
  "command": "intellig.commit.cherryPick",
  "when": "viewItem == intellig.logCommit",
  "group": "5_modify@2"
},
{
  "command": "intellig.commit.showDiff",
  "when": "viewItem == intellig.logCommit",
  "group": "6_view@1"
},
{
  "command": "intellig.commit.compareWithHead",
  "when": "viewItem == intellig.logCommit",
  "group": "6_view@2"
},
{
  "command": "intellig.commit.compareWith",
  "when": "viewItem == intellig.logCommit",
  "group": "6_view@3"
},
{
  "command": "intellig.commit.showFileInRevision",
  "when": "viewItem == intellig.logCommit",
  "group": "7_files@1"
},
{
  "command": "intellig.commit.fileHistoryFromHere",
  "when": "viewItem == intellig.logCommit",
  "group": "7_files@2"
},
{
  "command": "intellig.rebase.interactiveFromHere",
  "when": "viewItem == intellig.logCommit",
  "group": "8_rebase@1"
},
{
  "command": "intellig.commit.createPatch",
  "when": "viewItem == intellig.logCommit",
  "group": "9_patch@1"
}
```

---

## 4. Open Questions

**None.** All items clearly scoped:
- T1-09 (New Tag) is a simple QuickPick + GitService call
- T1-07 (Log menu) reuses existing commands, adds new ones per mapping table
- T1-11 (Reset dialog) is a modal with four radios + confirm guard
- T1-10 (Branches popup) restructures existing BranchPopup logic into sections
- T1-12 (Patch) delegates to GitService; minimal UI in MVP
