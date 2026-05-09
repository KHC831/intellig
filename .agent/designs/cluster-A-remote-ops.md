# Cluster A — Remote Ops Design (Push / Pull / Fetch + Auto-fetch)

_Covers T1-01 Push, T1-02 Pull, T1-03 Fetch + auto-fetch scheduler. Safety policy: IntelliJ-style minimal confirms (see `feedback_data_loss_confirms.md`); force push defaults to `--force-with-lease`, bare `--force` only via secondary opt-in menu entry. Webview patterns reused from `CommitDialog.ts:125-150` and `BranchPopup.ts:158+`._

---

## T1-01 Push dialog

### 1. Surface & entry points
- Command palette: `intellig.push` (was stub at `extension.ts:284-287` — replace).
- Keybinding: `Ctrl+Shift+K` / `Cmd+Shift+K` (already bound in `package.json:648`).
- Menus: `intellig.branch.push` (local branch tree — existing, `BranchContextMenuCommands.ts`), `intellig.remoteBranch.push` (new, for tag tree too once T1-09 lands), plus "Commit and Push" action from Commit tool window (T1-04 consumer).
- Programmatic: `PushDialog.show(repo?, branch?, { preselectForce? })`. Called without args = show current repo / current branch.

### 2. Decision: webview vs native
**Webview.** IR "Push dialog" requires: repositories table (rows w/ per-repo branch→remote edit), per-row commit-preview pane on focus change, "Edit all targets" link, a button with dropdown (`Push` / `Force Push (with lease)` / `Force Push (Anyway)…`). QuickPick can't express repo-table + editable-per-row + preview. Matches the webview footprint we already use in `CommitDialog.ts` and `RebaseEditor.ts`.

### 3. Fields
| Field | Type | Default | IntelliJ parity note |
|---|---|---|---|
| Repository rows (multi-repo) | table, per-row checkbox | all-selected in multi-root | IR §"Push dialog" repositories left column |
| Local branch | read-only label | current HEAD per repo | |
| Target branch name | inline editable text | `upstream.short` or `<remote>/<branch>` (if no upstream, `origin/<branchname>`) | IR "Click branch name → inline editable (type existing or new branch name)" |
| "Commits since last push" count | read-only badge | `rev-list --count @{u}..HEAD` (or `HEAD` if no upstream) | IR "each row shows commits since last push"; asterisk on commits by other authors |
| Commit preview pane (right) | read-only log list | commits in range; select row → show diff | IR right-side preview |
| Push tags | checkbox | off | IR "Push tags" w/ sub-radio (all tags / `--follow-tags`) |
| Tag scope | radio (all / follow) | `--follow-tags` when tags=on | IR sub-option |
| Force-with-lease | button-dropdown entry | implicit when branch diverges | Safety policy: default force path |
| Bare `--force` | secondary menu entry "Force Push (Anyway)…" | off | Explicit second opt-in per policy |
| `--set-upstream` | implicit | auto-set when branch has no upstream | Silent; matches IntelliJ behavior |
| `--no-verify` | checkbox in gear/overflow | off | Pre-push hooks toggle |

### 4. Button layout
- Bottom-right primary: **Push** (dropdown ▾ with: `Push`, `Force Push with Lease`, `Force Push (Anyway)…`). Default action = `Push`; when local diverges from tracked upstream, switch default label to `Force Push with Lease` (matches IR behavior).
- Bottom-left secondary: **Cancel** (Esc).
- Bottom-right link: **Edit all targets** (IR sourced) — toggles inline-edit on all rows.
- Overflow (⚙): `--no-verify`, `Push tags`, `Tag scope` radio.
- Protected-branches list (`intellig.protectedBranches`, new config) disables the `Force Push (Anyway)…` entry on matching targets (not the with-lease entry).

### 5. Multi-repo handling
Render one row per `IRepository` in `gitService.getRepositories()`. Each row: checkbox, repo root basename, branch label, editable target, commits-since count. "All-roots synchronous" pattern (IR Branches popup multi-root): on Push, iterate selected rows in parallel via `Promise.all`, collect per-row results; render success/failure column in-place without closing dialog. Per-row fail does not block other rows. Close only when all rows settle; a single failure surfaces a "Retry" on that row.

### 6. Flag → `GitService.push` mapping
Existing signature (`IGitService.ts:229-236` + `GitService.ts:634-657`):
```ts
push(repo, { force?, forceWithLease?, setUpstream?, remote?, branch?, tags? })
```
**To add to `IPushOptions`:**
- `noVerify?: boolean` → append `--no-verify`
- `followTags?: boolean` → append `--follow-tags` (mutually exclusive with `tags: true`)
- `refspec?: string` → when target branch name differs from local, push as `<localBranch>:<targetBranch>`

**Mapping table:**
| Dialog control | Option | CLI |
|---|---|---|
| Push (default) | `{}` or `{setUpstream}` | `git push [-u] <remote> <branch>` |
| Force Push with Lease | `{forceWithLease: true}` | `git push --force-with-lease …` |
| Force Push (Anyway) | `{force: true}` | `git push --force …` (safety policy: explicit opt-in only) |
| Push tags ✓ / scope=all | `{tags: true}` | `--tags` |
| Push tags ✓ / scope=follow | `{followTags: true}` | `--follow-tags` |
| No-verify | `{noVerify: true}` | `--no-verify` |
| Target edit | `{refspec: "local:target"}` | `<refspec>` |

### 7. Error / conflict handoff
- **Rejected (non-fast-forward):** inline row error banner "Rejected — remote has new commits." Action buttons: `Pull and Retry` (invokes T1-02 Pull dialog pre-filled with this repo+branch, then re-queues Push), `Force Push with Lease` (re-arms button to that mode).
- **Rejected (protected-branch on server):** row error with server message; no auto-retry.
- **Auth failure:** bubble to `NotificationService.showError` (existing wrapper); dialog stays open.
- **Hook failure (`--no-verify` off):** stderr rendered in row expand-panel; user can toggle no-verify in overflow and retry.
- No conflict handoff needed (push never produces merge conflicts). Pull-induced conflicts handled via **T1-08 Resolve Conflicts** when user clicks `Pull and Retry`.

### 8. ASCII mockup
```
┌── Push Commits to Remote ─────────────────────────────────────────── ✕ ──┐
│                                                                           │
│ ┌─ Repositories ──────────────────┐ ┌─ Commits ────────────────────────┐ │
│ │ ▣ my-app     feature/x → origin/│ │ • a1b2c3 Add login form  *jane   │ │
│ │               feature/x    [ 3 ]│ │ • 4d5e6f Fix null guard   you    │ │
│ │ ☐ shared-lib main → origin/main │ │ • 7g8h9i Bump deps        you    │ │
│ │               [up to date]      │ │                                  │ │
│ │                                 │ │ Diff preview for selected ↓      │ │
│ │                                 │ │ ──────────────────────────────── │ │
│ │              [Edit all targets] │ │ + src/auth/Login.tsx             │ │
│ │                                 │ │ - src/auth/index.ts              │ │
│ └─────────────────────────────────┘ └──────────────────────────────────┘ │
│                                                                           │
│ ⚙  ☐ Push tags  ( ) all tags  (•) --follow-tags    ☐ --no-verify         │
│                                                                           │
│                                        [Cancel]  [Push ▾]                 │
│                                                  ├─ Push                  │
│                                                  ├─ Force Push with Lease │
│                                                  └─ Force Push (Anyway)…  │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## T1-02 Pull dialog

### 1. Surface & entry points
- Command palette: `intellig.pull` (was stub at `extension.ts:290-293`).
- Keybinding: `Ctrl+T` / `Cmd+T` (already bound `package.json:654`; note IR maps Ctrl+T to Update Project — we keep it on Pull for now since Update-Project multi-root is Tier-3 / not in this cluster).
- Menus: Branch-popup `Pull into Current Using…` (IR), Branches-tree remote menu items `intellig.remoteBranch.pullUsingRebase` / `pullUsingMerge` (existing in `package.json:442-450` — route through this dialog with flag pre-filled).
- Programmatic: `PullDialog.show(repo?, preset?: "rebase" | "merge")`.

### 2. Decision: webview vs native
**Native QuickPick + InputBox chain.** IR §"Pull dialog" is just a remote dropdown + branch list + flag checkboxes + Pull/Cancel. Low structural complexity; fits a two-step native flow: (1) QuickPick w/ sectioned remotes + branches, (2) QuickPick w/ toggleable flag items (using `canPickMany` and a terminal "Pull" item). Avoids webview overhead where none of the webview affordances help. Same pattern as `BranchPopup.ts` sectioned picker.

### 3. Fields
| Field | Type | Default | IntelliJ parity note |
|---|---|---|---|
| Remote | QuickPick (sectioned) | `origin` (or `HEAD.upstream.remote`) | IR "Choose remote (default `origin`)" |
| Branch to pull from | QuickPick item under remote | tracked upstream if any | IR branch list |
| `--rebase` | toggle item | respects `intellig.pullRebase` config | IR flag |
| `--ff-only` | toggle item | off; mutex w/ `--no-ff`, `--squash`, `--rebase` | IR flag |
| `--no-ff` | toggle item | off; mutex w/ `--ff-only`, `--rebase` | IR flag |
| `--squash` | toggle item | off; mutex w/ `--rebase`, `--ff-only` | IR flag |
| `--no-commit` | toggle item | off | IR flag |
| `--no-verify` | toggle item | off | IR flag |

Mutex UI: when selecting a strategy flag, auto-clear conflicting flags and render a footer hint "`--rebase` unchecked `--no-ff`" so it's visible.

### 4. Button layout
- Terminal QuickPick item: `▶ Pull`. Esc = cancel. No destructive path → no force confirm.
- Second-pane QuickPick buttons (top-right): refresh-remotes icon (re-fetch remote list), gear → opens settings page filter `intellig.pullRebase`.

### 5. Multi-repo handling
Step 0 (only if multiple repos): repo picker QuickPick. For multi-root "Pull into Current" across all roots, invoke the dialog with a pre-set "Apply to all selected repositories" toggle; execute `Promise.all(pulls)` and show summary notification. (IR update-project strategy is deferred to Tier-3; here we keep single-repo simple.)

### 6. Flag → `GitService.pull` mapping
Existing signature (`IGitService.ts:220-224`):
```ts
pull(repo, { rebase?, remote?, branch? })
```
**To extend `IPullOptions`:**
- `ffOnly?: boolean` → `--ff-only`
- `noFf?: boolean` → `--no-ff`
- `squash?: boolean` → `--squash`
- `noCommit?: boolean` → `--no-commit`
- `noVerify?: boolean` → `--no-verify`

Implementation: extend `GitService.pull` (`GitService.ts:617-632`) — straightforward arg push; order `git pull [--rebase|--ff-only|--no-ff] [--squash] [--no-commit] [--no-verify] <remote> <branch>`.

### 7. Error / conflict handoff
- **Conflict on pull:** return path from `GitService.pull` currently throws on non-zero exit. Wrap the throw: catch stderr containing `CONFLICT`, leave the pull state in repo (`.git/MERGE_HEAD` or `REBASE_HEAD` depending on mode), and fire `ConflictResolutionService.onConflictDetected` → **T1-08** Resolve Conflicts dialog opens automatically. Pull dialog closes first.
- **Diverged (no strategy selected):** render footer error "Diverged — pick `--rebase`, `--ff-only`, or `--no-ff`"; don't close.
- **`--squash` + `--no-commit`:** accept but warn in footer "merge commit will require manual `git commit`." (No modal confirm — policy: trust the user.)
- **Auth failure / network:** bubble via `NotificationService`.

### 8. ASCII mockup
```
Step 1:                                  Step 2 (after remote+branch picked):
┌── Pull: Choose source ──────────── ✕ ┐ ┌── Pull: Options ───────────── ✕ ┐
│ Search…                              │ │ Remote: origin  Branch: main   │
│ ── Remote: origin ──                 │ │                                │
│  → main  (upstream)                  │ │ ▣ --rebase                     │
│    develop                           │ │ ☐ --ff-only                    │
│    release/2.4                       │ │ ☐ --no-ff                      │
│ ── Remote: upstream ──               │ │ ☐ --squash                     │
│    main                              │ │ ☐ --no-commit                  │
│    develop                           │ │ ☐ --no-verify                  │
│ ⟳ refresh remotes             [Esc]  │ │                                │
└──────────────────────────────────────┘ │ ▶ Pull                         │
                                         │     (Esc to cancel)            │
                                         └────────────────────────────────┘
```

---

## T1-03 Fetch command + auto-fetch scheduler

### 1. Surface & entry points
- Command palette: `intellig.fetch` (was stub at `extension.ts:296-299`). No default keybinding (IR does not source one).
- Menus: branch-popup (T1-10 integrates it), optional status-bar action `⟳ Fetch all` on the incoming-commits badge (T2-12 consumer).
- Programmatic: `GitService.fetch(repo, remote?)` already works (`GitService.ts:605-614`).

### 2. Decision: webview vs native
**None — command is a direct action.** If multiple repos, a 1-pick repo QuickPick; if single repo, execute silently with a status-bar progress indicator. If multiple remotes configured, pop a QuickPick `origin`, `upstream`, …, `All remotes`. Keep the flow Enter-through-able (don't stop users who just want `Ctrl+P → fetch`).

### 3. Fields (for the interactive QuickPick when multiple choices exist)
| Field | Type | Default | Notes |
|---|---|---|---|
| Repository | QuickPick (if N>1) | current active editor's repo; fall back to `repositories[0]` | |
| Remote | QuickPick (if N>1) | `All remotes` | `--all` used when nothing picked |
| `--prune` | toggle (gear) | on via new config `intellig.fetchPrune` (default true) | Not in IR explicitly but standard default |
| `--tags` | toggle (gear) | per config `intellig.fetchTags` (default "auto" — omit flag) | T3-12 completes this |

### 4. Button layout
None — fire-and-forget.

### 5. Multi-repo handling
`All repos` entry in the repo QuickPick; when chosen, `Promise.all(fetch-per-repo)` with per-repo progress reported to the status bar. Per-repo failures do not abort siblings.

### 6. Flag → `GitService.fetch` mapping
Existing signature `fetch(repo, remote?)`. **Extend** to:
```ts
fetch(repo: IRepository, options?: IFetchOptions): Promise<IFetchResult>
```
New `IFetchOptions`:
- `remote?: string` (preserve current positional arg via back-compat overload)
- `all?: boolean` → `--all`
- `prune?: boolean` → `--prune`
- `tags?: boolean` → `--tags`
- `noTags?: boolean` → `--no-tags`

New `IFetchResult`: `{ updatedRefs: Array<{ ref: string; oldSha: string; newSha: string }>; errors: string[] }` — parsed from `git fetch --porcelain` (or stderr fallback). Powers the incoming badge event.

### 7. Error / conflict handoff
Fetch never conflicts. Network / auth errors surface via `NotificationService`; scheduler backs off (see below).

### 8. ASCII mockup
```
┌── Fetch from: ──────────────────── ✕ ┐
│  → All remotes                       │
│    origin                            │
│    upstream                          │
│  ⚙ ▣ --prune   ☐ --tags              │
└──────────────────────────────────────┘
```

### Scheduler

**Component:** new `services/AutoFetchService.ts` (interface `IAutoFetchService`; owned by `ExtensionServices`).

**Activation hook.** In `extension.ts` `activate()` (line 123-152), after `registerCommands` and `setupEventListeners`, call:
```ts
const autoFetch = extensionServices.autoFetchService;
autoFetch.start();
context.subscriptions.push(autoFetch); // disposed by VS Code on deactivate
```
Add `autoFetchService` to `ExtensionServices` (pattern matches `StatusBarService` wiring in `extension.ts:~158`).

**Disposal hook.** `AutoFetchService.dispose()` clears the pending timer and removes workspace/config listeners. Because we `context.subscriptions.push(...)`, VS Code fires it automatically; no manual dispose needed in `deactivate()` (consistent with OTHER-05 fix — don't double-dispose).

**Config.**
- `intellig.autoFetchEnabled` (existing, default `true`).
- `intellig.autoFetchInterval` (existing, seconds, default 180). Clamp to `>= 60` at runtime to avoid abusive values.
- Live-reload via `ConfigurationService.onDidChangeConfiguration` → `autoFetch.reschedule()`.

**Scheduling loop.**
```
start():
  this._reschedule();
  this._watchConfig();
  this._watchWorkspace();   // onDidChangeWorkspaceFolders → reschedule

_reschedule():
  clearTimeout(this._timer);
  if (!enabled || repos.length === 0) return;
  this._timer = setTimeout(tick, intervalMs);

tick():
  for each repo in getRepositories():
    try { result = await gitService.fetch(repo, { all: true, prune: true }) }
    catch (e) { record error → backoff }
    if (result.updatedRefs.length > 0) emitter.fire({ repo, updatedRefs })
  this._reschedule()
```

**Event emission for incoming-commits badge.**
- New `IAutoFetchService.onDidFetch: vscode.Event<IFetchResult & { repo: IRepository }>`.
- `StatusBarService` subscribes; computes `↑N ↓M` via `GitService.getRepositoryState` (ahead/behind already cached — `GitCacheManager`) and updates badge text. Clicking the badge opens Git tool window (T1-05) → Incoming tab.
- Also add `IGitService.onDidChangeRepository` (existing) coalesces with the fetch event so the tool window refreshes its log tab.

**Backoff on error.**
- Exponential: failure → double interval (cap at 30 min). Reset to configured interval on next success.
- Auth-failure fingerprint (stderr contains `Authentication failed` / `could not read Username`): **pause** and surface one-time notification "Auto-fetch paused for `<repo>` — authentication failed. [Re-enable]"; do not retry until user action or workspace change.

**Pause when no repo / resume on new workspace folder.**
- `getRepositories().length === 0` → don't set a timer.
- `vscode.workspace.onDidChangeWorkspaceFolders` → `reschedule()` (re-discovers via `GitService.getRepository`).
- `vscode.window.onDidChangeWindowState` optional: when `!state.focused`, drop frequency to 10× interval (IntelliJ does similar background throttling); optional polish — flag as T3.

**Manual fetch integration.** When user fires `intellig.fetch`, call `gitService.fetch(…)` directly and also call `autoFetch.resetSchedule()` so the next auto-tick isn't immediately on top of the manual one.

---

## Cross-cluster notes

- **Shared webview base utility.** T1-01 (and T1-04/T1-05 in cluster C) will want a common webview scaffold: CSP+nonce (OTHER-01 pattern from `MergeView.ts`), message-delegation handler, `@vscode/webview-ui-toolkit` light reuse. Recommend adding `services/webview/BaseWebviewPanel.ts` in a Tier-1 prep PR before any of these land.
- **Config keys introduced:** `intellig.protectedBranches` (string[]), `intellig.fetchPrune` (boolean, default true), `intellig.fetchTags` ("auto"|"all"|"never", default "auto" — completes T3-12 alongside this cluster). `intellig.pullRebase` already exists; keep as the Pull dialog's default `--rebase` checkbox state.
- **T1-08 dependency:** Pull dialog's conflict path (§7) requires the `ConflictResolutionService.onConflictDetected` event — T1-08 must land together with T1-02 or T1-02 ships w/ a toast fallback ("Conflicts — open Merge View manually") that T1-08 later replaces.
- **Testing.** Unit tests (mocha) for option→CLI mapping in `GitService.push/pull/fetch` following the `commitCmdBranchPopup.fixes.test.ts` typed-private-accessor pattern. Property tests (fast-check) for the scheduler's `_reschedule` state machine following `branchContextMenuErrors.property.test.ts` pattern. No VS Code integration tests needed — webview+service split keeps it unit-testable.
