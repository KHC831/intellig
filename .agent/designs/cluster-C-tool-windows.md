# Cluster C — Tool Windows, Changelist UI, Conflict Dialog

_Scope: GAP_ANALYSIS.md T1-04, T1-05, T1-06, T1-08. Source-of-truth for layout: `INTELLIJ_REFERENCE.md` §UI Structure & Menus. Current-state: `CURRENT_FEATURES.md` rows 59, 190–201, 226, 261–268._

---

## 1. View registration map

All new/modified entries added to `package.json > contributes`. Activation for the Git tool-window panel is already `onStartupFinished` (global); views register lazily.

| View ID | Container | Type | Activation context | `activeView` ctx key | Status |
|---|---|---|---|---|---|
| `intellig.branchTree` | `intellig` panel | `tree` | always | — | existing, unchanged |
| `intellig.toolWindow` | `intellig` panel | `webview` | always | `intellig.toolWindow.activeTab` ∈ {`log`,`console`,`incoming`,`updateInfo`,`history`} | **refactored (T1-05)** |
| `intellig.commitToolWindow` | `intellig` panel (new) | `webview` | `workbenchState != empty && git.enabled` | `intellig.commitToolWindow.activeTab` ∈ {`localChanges`,`shelf`} | **new (T1-04)** |
| `intellig.resolveConflictsDialog` | modal via `createWebviewPanel` | `webviewPanel` | invoked on conflict | — | **new (T1-08)** |

Keybindings added:
- `alt+0` → `intellig.showCommitToolWindow` (focus the Commit tool window view)
- `alt+9` (already bound) → `intellig.openGitToolWindow` (unchanged)
- `ctrl+shift+h` / `ctrl+alt+u` / `ctrl+shift+u` — reserved for Cluster B (Shelf); listed here only to avoid view-activation collision

Context keys set via `vscode.commands.executeCommand('setContext', ...)`:
- `intellig.toolWindow.activeTab` (current tab id)
- `intellig.commitToolWindow.activeTab`
- `intellig.conflicts.active` (bool; set by `ConflictResolutionService`, used to gate `Resolve Conflicts…` status-bar action)

Commands registered:
- `intellig.showCommitToolWindow` (Alt+0)
- `intellig.commitToolWindow.focusShelf` · `.focusLocalChanges`
- `intellig.toolWindow.focusTab` (arg: tab id) — used by status bar to jump to `Incoming` after fetch
- `intellig.showResolveConflictsDialog` (manual re-open; auto-open is event-driven)
- `intellig.changelist.{new,rename,delete,setActive,editDescription,moveFilesTo,commitOnly,shelve}`

---

## 2. T1-04 — Commit tool window

### 2.1 View registration

Second webview inside the existing `intellig` panel container (adjacent to `intellig.toolWindow`):

```jsonc
// package.json > contributes.views.intellig (append)
{
  "type": "webview",
  "id": "intellig.commitToolWindow",
  "name": "Commit",
  "icon": "$(git-commit)",
  "when": "workbenchState != empty"
}
```

Implementation: new `services/CommitToolWindow.ts` implementing `WebviewViewProvider`. Constructor wires `ChangelistService`, `ShelfService`, `GitService`, and the existing `CommitDialog` for its commit-execution logic (see §2.5).

### 2.2 DOM / tab layout (matches IR §"Commit tool window")

```
┌─────────────────────────────────────────────────────────────┐
│ ⟨repo-selector⟩  [Local Changes]  [Shelf]                ⚙︎ │  ← tab strip + gear
├─────────────────────────────────────────────────────────────┤
│ ▾ Default Changelist (Active)             3 files          │  ← changelist tree
│   M  src/services/GitService.ts                             │     (T1-06 content)
│   A  src/test/commitToolWindow.test.ts                      │
│   ? docs/new-page.md                                        │
│ ▸ refactor-blame                          2 files           │
│ ▸ wip                                     1 file            │
├───────────────────┬─────────────────────────────────────────┤
│ commit message    │ diff preview (selected file)            │
│ [ ________ ]      │  1  - old line                          │
│                   │  2  + new line                          │
│ ☐ Amend   ☐ Sign-off                                        │
│                   [ Commit ▾ ] ← Commit / Commit and Push   │
└───────────────────┴─────────────────────────────────────────┘
```

- **Tab strip**: two tabs (`Local Changes`, `Shelf`). Tab state stored in `workspaceState['intellig.commitToolWindow.activeTab']`.
- **Gear menu** (⚙︎): dropdown with `Reformat code`, `Optimize imports`, `Run Code Cleanup`, `Check TODO`, `--no-verify` toggle. Content deferred to T2-06; Cluster C ships only the skeleton (disabled/grey items with tooltips "coming soon").
- **Shelf tab** reuses `ShelfView` content but renders as a tree + diff-preview pane rather than QuickPick. Tree nodes emit the same events the Cluster B shelf-menu design consumes.
- **Message history dropdown**: click `∨` next to the message field. Source = `workspaceState['intellig.recentCommitMessages']` (max 20 entries, deduped, LRU). Falls back to global state if workspace state missing (matches VS Code conventions; workspace preferred since messages are repo-scoped).

### 2.3 Message protocol

Follows project CLAUDE.md rule: incremental `postMessage` for state deltas, full HTML regen only for structural changes.

Webview → host:
| `type` | payload | response |
|---|---|---|
| `tabChange` | `{ tab: 'localChanges' \| 'shelf' }` | no-op on host; host updates context key |
| `selectFile` | `{ path: string }` | host posts `updateDiffPreview` |
| `toggleChangelist` | `{ changelistId: string, collapsed: boolean }` | persist in workspaceState |
| `toggleFile` | `{ path: string }` | host posts `updateFileCheckbox` |
| `commit` | `{ message, amend, signOff, files[] }` | invokes `CommitDialog._executeCommit()` path |
| `commitAndPush` | as above | invokes commit then `intellig.push` (Cluster A dialog) |
| `messageHistoryRequest` | `{}` | host posts `messageHistory` |
| `changelistContextAction` | `{ action, changelistId, targetFiles? }` | see T1-06 §4.3 |

Host → webview:
| `type` | payload | semantics |
|---|---|---|
| `fullRender` | entire state | structural (tab switch, initial load) |
| `updateChangelistTree` | `{ changelists: IChangelist[] }` | incremental; replaces tree root without re-rendering diff |
| `updateDiffPreview` | `{ path, diffHunks }` | incremental; right pane only |
| `updateFileCheckbox` | `{ path, checked }` | single-row update (PERF-04 pattern) |
| `updateShelfList` | `{ entries }` | on shelf tab |
| `messageHistory` | `{ messages: string[] }` | populate dropdown |
| `commitDone` | `{ success, error? }` | clear message field, refetch tree |

### 2.4 Keybinding

```jsonc
{
  "command": "intellig.showCommitToolWindow",
  "key": "alt+0",
  "when": "!terminalFocus"
}
```

### 2.5 Integration with existing `CommitDialog.ts`

- **Keep both surfaces during rollout.** `CommitDialog` (modal-style webview panel) continues to be invoked by `intellig.commit`; it is the fallback when the tool window is closed. The tool window calls the **same internal commit-execution path** by extracting shared logic into a helper `performCommit(repo, opts)` in `CommitDialog.ts` (refactor only — no behavior change).
- After a successful commit, the tool window emits `onDidCommit` so `GitToolWindowProvider` can refresh the Log tab.
- Amend, sign-off, partial-staging logic all stay in the helper — tool window just renders the controls that set the flags.

### 2.6 Migration path

1. **Phase 1** (this cluster): add tool window alongside `CommitDialog`. Default: `intellig.commit` still opens the modal. Config flag `intellig.useCommitToolWindow` (default `false`) opt-in.
2. **Phase 2** (post-review): flip default to `true`; `intellig.commit` reveals + focuses the tool window (sends `showCommitPane` message).
3. **Phase 3** (next release after telemetry shows adoption): deprecate the modal `CommitDialog.show()`; retain `performCommit` helper.

No command IDs renamed; user keybindings preserved.

---

## 3. T1-05 — Git tool window tabs

### 3.1 Current state recap

`GitToolWindowProvider.ts` (3572 lines) renders a single 2-panel webview: graph (center) + details (right). Message protocol already uses incremental postMessage for `selectGraphRow`, `updateDetailsPanel`, `toggleCommitSelection`, filters (sourced at lines 438–533). `ConsoleService` streams raw git output but there is no UI tab for it.

### 3.2 Target

Tabs: `Log` · `Console` · `Incoming` · `Update Info` · `History`.

```
┌ [Log] [Console] [Incoming] [Update Info] [History] ⟨repo⟩ ⚙︎ ┐
│ ┌──────────┬────────────────────┬─────────────────────────┐  │
│ │ Branches │ Commits graph      │ Changed Files           │  │  Log tab:
│ │  ▸ local │  ● feat: add push  │  M  GitService.ts       │  │  4-pane
│ │  ▸ remote│  ○ fix: blame perf │  A  PushDialog.ts       │  │  (matches IR)
│ │  ▸ tags  │  ○ chore: bump     ├─────────────────────────┤  │
│ │          │                    │ Details (msg/hash/...)  │  │
│ └──────────┴────────────────────┴─────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Other tabs:
- **Console**: virtualized list of `IConsoleEntry` items (already in provider state line 116). Scrollback 1000 (existing cap). Filter chip + clear button.
- **Incoming**: rendered from `git rev-list HEAD..@{u}` after each fetch. Click → reveals in Log tab with scrollToCommit. Refresh button.
- **Update Info**: last `Update Project`/`Pull` result — list of commits pulled, files changed, per-root if multi-repo. Persists until next update.
- **History**: embedded equivalent of `intellig.showHistory` QuickPick. Shows commit list for a single file with diff preview. Depends on T2-07 for full feature set; ship MVP here (file path header + commit list + diff-with-prev).

### 3.3 Tab routing: single webview vs multiple webviews

**Decision: single webview, tab routing in DOM.**

Rationale:
1. **State continuity.** Filter state, commit-graph render cache, scroll position for the Log tab must survive tab switches without reload. A single webview keeps `IExtendedLogState` (line 107) in memory.
2. **retainContextWhenHidden is not enough for multi-view.** VS Code's `WebviewView` (used by tool-window providers) doesn't support `retainContextWhenHidden` the same way `WebviewPanel` does — registering 5 separate webviews would destroy/rebuild DOM on each pane switch in the sidebar, regressing PERF-04.
3. **Message protocol already supports tab discrimination** with minor additions (§3.4).
4. **LOC-efficient.** Extracting 5 independent providers would triple the boilerplate; one provider with per-tab HTML fragments keeps churn manageable.

Trade-off: host-side dispatcher must be disciplined — see §3.5 for file split.

### 3.4 Message protocol — tab routing

Extend the existing discriminated-union message shape with a `tab` field. All new messages carry `tab`; existing messages (`selectCommit`, `toggleCommitSelection`, filters) are implicit `tab: 'log'` and need no change.

```ts
type WebviewMessage =
  | { type: 'tabChange'; tab: TabId }
  | { type: 'log.*'; /* existing */ }
  | { type: 'console.clear' | 'console.filter'; tab: 'console'; ... }
  | { type: 'incoming.refresh'; tab: 'incoming' }
  | { type: 'incoming.jumpToCommit'; tab: 'incoming'; hash: string }  // routed to 'log'
  | { type: 'updateInfo.refresh'; tab: 'updateInfo' }
  | { type: 'history.loadFile'; tab: 'history'; path: string }
  | { type: 'history.selectRevision'; tab: 'history'; rev: string };
```

Host dispatcher (new `_onMessage` router): switch on `tab` first, then per-tab handler. Incremental postMessage responses likewise carry `tab` so the webview JS only updates the right fragment.

Lazy activation: tab content DOM is empty until first `tabChange`; host sends `initTab` payload on demand (e.g., `Console` stream buffer only flushed to DOM when tab is focused).

### 3.5 File split proposal

Current: `GitToolWindowProvider.ts` — 3572 LOC monolith.

Target split (each under ~800 LOC):

```
src/services/gitToolWindow/
  GitToolWindowProvider.ts     ~400  root provider, tab routing, message dispatch, webview lifecycle
  tabs/LogTab.ts               ~900  existing graph + details panel state + handlers
  tabs/ConsoleTab.ts           ~200  console entries, clear, filter
  tabs/IncomingTab.ts          ~200  rev-list HEAD..@{u} + jump-to-commit
  tabs/UpdateInfoTab.ts        ~200  last-update result state
  tabs/HistoryTab.ts           ~400  file history MVP (T2-07 finishes)
  html/logTabHtml.ts           ~700  extracted HTML template (lines 2943–3491 of current file)
  html/commonHtml.ts           ~150  chrome, tab strip, repo-selector, gear
  html/consoleHtml.ts          ~150
  html/incomingHtml.ts         ~150
  html/updateInfoHtml.ts       ~100
  html/historyHtml.ts          ~200
```

Each tab file exports `{ render(state): string, handleMessage(msg, ctx): Promise<void>, onStateChange(): void }`. The root provider composes them.

### 3.6 LOC-risky refactor hotspots

In the existing 3572-line file, specific line ranges most likely to regress:

| Lines | Function | Risk | Guard |
|---|---|---|---|
| 267–624 | `onDidReceiveMessage` switch | **high** — protocol expansion | Property-test dispatch table (pattern: `commitContextMenuDispatch.property.test.ts`) |
| 433–533 | partial postMessage paths (`selectGraphRow`, `updateDetailsPanel`, `toggleCommitSelection`) | **high** — PERF-04 regression | Integration test: timing budget <16ms for single-file toggle |
| 1078 | initial `initRepository` | low | |
| 1314–1350 | `panelResize` persistence | medium — new tab-width state needed | |
| 1571 | `repository-selector` HTML (embedded `acquireVsCodeApi` call) | medium — must survive HTML split | |
| 2943–3491 | huge inline HTML template w/ event wiring | **very high** — move to `html/logTabHtml.ts` unchanged first, then layer tab strip around it | stage split in 2 PRs: (1) extract log HTML intact, (2) add other tabs |
| 3547+ | type declarations for postMessage | medium | |

Rollout: Phase 1 adds the tab strip and empty `Console`/`Incoming`/`Update Info`/`History` shells behind `intellig.useTabbedGitToolWindow` config (default `false`). Phase 2 ships Console + Incoming content. Phase 3 ships History + Update Info + flips default.

### 3.7 Perf guards

- Each tab DOM fragment is `display: none` when inactive — no re-renders on background state changes, just diff into hidden DOM.
- Console tab: subscribe to `ConsoleService` stream only while active; buffer updates into a coalesced 100ms window when inactive, flush on activation.
- Incoming: cache `rev-list HEAD..@{u}` result until next fetch event; don't re-run on tab-switch.

---

## 4. T1-06 — Changelist tree UI

### 4.1 Decision: tree-in-webview embedded in Commit tool window

Considered:
- **(A) TreeView provider** (native `window.createTreeView`) — Pros: free drag-drop, free context menu via `view/item/context`. Cons: cannot coexist in the same panel as the Commit tool-window webview; would split the UX across two views. Rejected — IR §"Commit tool window" shows changelists *inside* the tool window.
- **(B) Dedicated webview view** — extra surface, doubles state plumbing.
- **(C) Tree-in-webview embedded in the Commit tool window's Local Changes tab** — matches IntelliJ visually; one webview, one state stream. **Chosen.**

Context menu is simulated in HTML (right-click handler calls `postMessage({ type: 'changelistContextAction', ... })`). Labels match IR §"Local Changes / changelist context menu".

### 4.2 Node model

```ts
type ChangelistTreeNode =
  | { kind: 'changelist'; id: string; name: string; isDefault: boolean; isActive: boolean; files: FileNode[]; collapsed: boolean }
  | { kind: 'file'; path: string; status: FileStatus; staged: boolean; changelistId: string };
```

Default changelist always renders first, even when empty (matches IntelliJ). Active changelist is shown with `(Active)` suffix and bold. Unversioned files go in a pseudo-changelist `Unversioned Files` (id sentinel `'_unversioned'`, not persisted).

### 4.3 Context menu (labels from IR §"Local Changes / changelist context menu")

On a **changelist node**:

| Label | Command | Notes |
|---|---|---|
| `New Changelist…` | `intellig.changelist.new` | input box |
| `Set Active Changelist` | `intellig.changelist.setActive` | |
| `Rename Changelist…` | `intellig.changelist.rename` | |
| `Edit Description…` | `intellig.changelist.editDescription` | requires schema bump (stored description field — see §4.5) |
| `Remove Changelist` | `intellig.changelist.delete` | existing service moves files to default |
| `Commit Only This Changelist…` | `intellig.changelist.commitOnly` | opens commit tool window pre-filtered |
| `Shelve Changelist` | `intellig.changelist.shelve` | existing ShelfService |

On a **file node** (reuses Cluster B mapping where applicable):

| Label | Command |
|---|---|
| `Show Diff` (Ctrl+D) | `intellig.localChanges.showDiff` |
| `Jump to Source` (F4) | `intellig.localChanges.openFile` |
| `Move to Another Changelist…` (F6) | `intellig.changelist.moveFilesTo` |
| `Rollback…` (Ctrl+Alt+Z) | `intellig.revertFile` |
| `Shelve Changes…` | `intellig.shelve.selected` |
| `Add to VCS` (Ctrl+Alt+A) | `intellig.addToVcs` (only when `status = untracked`) |
| `Show History` | `intellig.showHistory` |
| `Annotate with Git Blame` | `intellig.annotate` |

### 4.4 Interaction with external `git add` — reconciliation policy

Since changelists are an IntelliG-only overlay (stored in `.git/intellig-changelists.json`), external tools can modify the index under us. Policy:

1. **Source of truth for file list = git status.** `ChangelistService` storage only holds `path → changelistId` assignments; a file absent from git-status is ignored even if present in storage (tombstone cleanup runs on load).
2. **Any modified-but-unassigned file → default changelist.** Files that appear in git-status with no storage entry are auto-assigned to the default changelist on read.
3. **Repository change event (`GitService.onDidChangeRepository`) triggers reconciliation.** Steps: (a) fetch current git status; (b) prune storage entries whose path is no longer dirty; (c) add missing entries to default; (d) persist; (e) fire `onDidChangeChangelists`. Debounced 300ms (matches existing file-watcher debounce per project CLAUDE.md).
4. **External staging does NOT change the changelist.** `git add` merely flips `staged = true` on the file node; the changelist assignment is preserved. IntelliJ behaves the same way.

### 4.5 Data sync & persistence

Existing `ChangelistService` already persists to `.git/intellig-changelists.json`. Add:
- `description?: string` field to `IChangelistStorageItem` (version bump: `CHANGELIST_STORAGE_VERSION = 2`, with migrator that fills `description: ''` on read).
- `reconcileWithGitStatus(repo)` method called from the `onDidChangeRepository` handler.
- `getChangelistForFile(repo, path): Promise<string>` convenience for the tree renderer.
- `setActiveChangelist(repo, id)` — currently `getDefaultChangelist` returns the default, but there's no distinct "active" concept. Add `activeChangelistId` to storage; UI "Set Active" updates it. Default = active when storage first created.

No existing API is renamed; these are additive.

### 4.6 ASCII mockup (inside Commit tool window Local Changes tab)

```
┌ Local Changes ──────────────────────────────────────────┐
│ ▾ Default Changelist (Active)             3 files    … │
│     ☑ M  src/services/GitService.ts                     │
│     ☐ A  src/test/commitToolWindow.test.ts              │
│     ☑ ? docs/new-page.md                                │
│                                                          │
│ ▸ refactor-blame                          2 files    … │
│     ☑ M  src/services/BlameService.ts                   │
│     ☑ M  src/services/InlineBlameProvider.ts            │
│                                                          │
│ ▸ Unversioned Files                       1 file     … │
│     ☐ ? notes.md                                        │
└──────────────────────────────────────────────────────────┘
           ↑ right-click any row → context menu
           ↑ drag-drop between changelists via postMessage('fileDrop')
```

Right-click `…` icon on the changelist row or right-click anywhere on the row to show the menu (HTML-rendered popup, positioned by mouse coords).

---

## 5. T1-08 — Auto-open merge + Resolve Conflicts dialog

### 5.1 Auto-trigger — event sources

Two independent triggers, both needed:

1. **Operation-return trigger.** Every git operation that can produce conflicts returns `{ success: false, conflicts: [...] }`. The existing call sites already surface this. New behavior: the callers invoke `ConflictResolutionService.openResolveConflictsDialog(repo, conflicts, opContext)`.

2. **State-file watcher trigger.** Covers the case where conflicts appear asynchronously (e.g., user abandoned an external `git merge` mid-flight, or an IDE restart). Watch for presence of:
   - `.git/MERGE_HEAD` → merge in progress
   - `.git/REBASE_HEAD` or `.git/rebase-merge/` or `.git/rebase-apply/` → rebase
   - `.git/CHERRY_PICK_HEAD` → cherry-pick
   - `.git/REVERT_HEAD` → revert

   On any of these *plus* at least one unmerged file, `ConflictResolutionService` surfaces a **status bar prompt** (`$(warning) Unresolved conflicts — click to resolve`) rather than stealing focus. The existing `setupRepositoryWatcher` (GitService line 292) already debounces `.git` changes at 300ms; piggyback on that.

Context key `intellig.conflicts.active` drives `when` clauses for the status bar item and for a `Resolve Conflicts…` entry in the VCS menu.

### 5.2 Hook sites in `GitService.ts`

Exact functions that currently return `{ success: false, conflicts }`:

| Function | Lines | Hook (in call site, not the GitService method) |
|---|---|---|
| `mergeBranch` | 456–483 | `BranchContextMenuCommands._handleMergeInto` + any Merge dialog in Cluster B |
| `rebaseBranch` | 492–519 | `BranchContextMenuCommands._handleRebaseCurrentOnto`, `_handleCheckoutAndRebase` |
| `cherryPick` | 999–1021 | `CommitContextMenuCommands._handleCherryPick`, `BranchContextMenuCommands._handleCherryPickFromRemote` |
| `pull` (current `services/GitService.ts` path) | ~637 area | Cluster A `PullDialog`, and the legacy `intellig.pull` command |
| revert commit (`git revert`) | via `_handleRevert` | `CommitContextMenuCommands._handleRevert` |
| unshelve (ShelfService.unshelve) | conflict detection on apply | `ShelfService.unshelve` call site |
| unstash (`git stash pop/apply`) | StashService | `StashView.apply/pop` handlers |

Policy: **callers**, not GitService itself, open the dialog. This keeps GitService UI-free. Pattern:

```ts
const res = await gitService.mergeBranch(repo, branch);
if (!res.success && res.conflicts?.length) {
  await conflictResolutionService.openResolveConflictsDialog(repo, res.conflicts, {
    operation: 'merge',
    target: branch,
    canAbort: true,
    canContinue: true,
  });
}
```

### 5.3 Dialog layout (matches IR §"Resolve Conflicts dialog")

```
┌ Resolve Conflicts — merge from 'feature/x' ───────────────┐
│                                                             │
│  Conflicted files:                                          │
│                                                             │
│  ⚠  src/services/GitService.ts      [Yours][Theirs][Merge…]│
│  ⚠  src/services/BlameService.ts    [Yours][Theirs][Merge…]│
│  ✓  src/services/Changes.ts         resolved               │
│                                                             │
│  ─────────────────────────────────────────────────────     │
│  [ Apply Non-Conflicting Changes from Both Sides ]          │
│                                                             │
│                                                             │
│           [ Abort Merge ]  [ Continue ]                     │
└─────────────────────────────────────────────────────────────┘
```

- **Modal webview panel** (`createWebviewPanel`, ViewColumn.One); auto-focus; ESC prompts before close if unresolved files remain.
- **Per-row buttons**:
  - `Accept Yours` → `ConflictResolutionService.acceptCurrent(repo, path)` (already implemented, line 134)
  - `Accept Theirs` → `ConflictResolutionService.acceptIncoming(repo, path)` (symmetric, present)
  - `Merge…` → opens existing `MergeView` for that file; listen for `MergeView.onDidResolve` (line 22) to flip the row to ✓
- **Status icons**: ⚠ unresolved · ✓ resolved · ⊘ auto-resolvable (future).
- **Bottom buttons**:
  - `Abort {Merge|Rebase|Cherry-pick|Revert}` — invokes the matching `*Abort` method on GitService and closes the dialog.
  - `Continue` — enabled only when all files ✓. Invokes the matching `*Continue` method.
- **`[Apply Non-Conflicting Changes from Both Sides]`** row is a per-file bulk shortcut — scans each unresolved file for hunks that don't conflict and stages them, leaving only true conflicts for `Merge…`. Covers the IR capability without requiring new MergeView infra in this cluster.

### 5.4 Message protocol

Webview → host:
- `acceptYours` / `acceptTheirs` `{ path }`
- `openMergeView` `{ path }`
- `abort` / `continue`
- `applyAllNonConflicting` `{ path }` (per-row variant)

Host → webview (all incremental):
- `updateFileStatus` `{ path, status: 'resolved' | 'unresolved' }`
- `closeDialog` `{ reason: 'completed' | 'aborted' | 'cancelled' }`

### 5.5 ASCII mockup of the status-bar prompt (fallback)

```
    ⎇ main   ⟳ 2 incoming   ⚠ 3 unresolved conflicts   [click → Resolve…]
```

Click → `intellig.showResolveConflictsDialog` (opens the dialog for the active repo).

---

## 6. Perf & state concerns

1. **Incremental postMessage per tab** — strictly enforced. Every new message type carries enough context (`tab`, `path`, etc.) to patch a DOM subtree; no tab replaces > its own subtree. Regression guard: add an integration test that flips changelist-file checkboxes 100× and asserts p95 render budget < 16ms (mirrors PERF-04 Commit dialog test).

2. **Tab lazy-activation.**
   - `Console`: don't stream to DOM while hidden; host-side `ConsoleService` subscription remains active (to accumulate buffer) but `_flush()` only posts to webview when `activeTab === 'console'`. Enforce cap = 1000 entries; drop oldest.
   - `Incoming`: skip `rev-list HEAD..@{u}` on tab-switch if a cached result is < 30s old or no fetch has happened since.
   - `Update Info`: static until next update/pull completes.
   - `History`: no data fetched until user opens a file into it.

3. **Memory.**
   - Console buffer capped at 1000 entries × ~200 bytes ≈ 200 KB steady state.
   - Log graph state already capped at `INCREMENTAL_COMMIT_LOAD_COUNT` (100) per page load.
   - Commit tool window: changelist tree is O(files), no upper bound needed beyond git-status truncation.

4. **State races.**
   - *Graph filter changed while `Incoming` tab is refreshing.* `Incoming` owns its own state slice; no shared mutable object with Log. Filter state changes are scoped to `log.*` messages.
   - *Concurrent commit + external git add.* `ChangelistService.reconcileWithGitStatus` is serialized per-repo via an in-flight promise; new events queue up and the latest subsumes older pending ones.
   - *Tab switch during pending postMessage.* Webview JS drops messages whose `tab` doesn't match the active tab, *except* for `fullRender` — that's authoritative.
   - *Resolve Conflicts dialog open while repo changes branch.* Dialog subscribes to `onDidChangeRepository`; on branch change while conflicts remain, show warning banner and disable `Continue`.

---

## 7. Risks & rollout

### 7.1 LOC-risky areas

| File | Range | Risk | Mitigation |
|---|---|---|---|
| `GitToolWindowProvider.ts` | 267–624 (message switch) | high | Property test new dispatch table before merging |
| `GitToolWindowProvider.ts` | 2943–3491 (inline HTML) | very high | Stage split: PR1 = extract intact, PR2 = add tab chrome |
| `GitToolWindowProvider.ts` | 433–533 (incremental postMessage) | high | Preserve signatures; only add `tab: 'log'` field (ignored by existing client code paths) |
| `CommitDialog.ts` | 102–170 (`show` method) | medium | Extract `performCommit` helper without changing public API first |
| `ConflictResolutionService.ts` | 34–45 (constructor watchers) | medium | Add MERGE_HEAD/REBASE_HEAD watcher as a new disposable, don't touch existing |
| `ChangelistService.ts` | 32–45 (storage schema) | medium | Version bump with read-side migrator |

### 7.2 Feature flags

All three UI swaps shipped behind opt-in config keys:

```jsonc
"intellig.useCommitToolWindow": { "type": "boolean", "default": false }
"intellig.useTabbedGitToolWindow": { "type": "boolean", "default": false }
"intellig.autoOpenResolveConflictsDialog": { "type": "boolean", "default": true }  // T1-08 is pure addition, low risk — default on
```

Default `false` for the two tool-window swaps until a full release cycle + telemetry confirm no regression in PERF-04 envelope. Auto-conflict dialog is pure UX improvement over the current dead-end behavior, default on.

### 7.3 Deprecation plan

- **`CommitDialog` modal panel** — `show()` remains callable; wraps the tool window in fallback mode when the user's workbench has hidden the panel container. Remove in the release *after* tool window is default.
- **Single-panel Git tool window** — once tabs are default, the pre-tab HTML template is deleted from `LogTab.ts` (the other tabs never shared it).
- **QuickPick conflict re-entry** — once T1-08 lands with default-on flag, the current "open command palette to find MergeView" fallback path becomes unreachable; remove the `intellig.openMergeView` entry from the command palette (keep command for programmatic callers).

### 7.4 Test coverage plan

- **Unit:**
  - `CommitToolWindow` message-dispatch (tab → handler mapping).
  - `ChangelistService.reconcileWithGitStatus` — 8 cases: empty storage / stale entries / external add / external rm / rename / case-sensitivity / multi-repo isolation / corrupt JSON.
  - `ConflictResolutionService.openResolveConflictsDialog` — 5 op contexts (merge/rebase/cherry-pick/revert/unshelve).
- **Property:** tab-router — for any valid message, there exists exactly one handler (fast-check).
- **Integration:** perf budget for Commit tool window file-checkbox toggle (reuse Commit dialog pattern).

---

## 8. Cross-references

- **Push/Pull/Fetch dialogs** (Cluster A) — the `Commit and Push` button routes to `intellig.push` (Cluster A T1-01).
- **Menu labels & shortcuts** (Cluster B) — changelist & file node context menus source their labels/shortcuts from the Cluster B mapping table; this cluster owns the host logic, Cluster B owns the `package.json` menu contributions.
- **Shelf enhancements** (Cluster B T2-10) — the Commit tool window Shelf tab ships MVP here (tree + diff preview); rename / silent unshelve / Already-Unshelved filter / Import Patches land in Cluster B's ShelfView work.
- **File history panel** (T2-07) — the `History` tab ships an MVP; T2-07 upgrades it.
