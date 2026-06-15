# Parity reference: Update Project + Update Info tab

Layer-3 reference doc (ADR-010) for IntelliJ's **Update Project**
(`Vcs.UpdateProject`, Ctrl+T) — `GitUpdateOptionsDialog` +
`GitUpdateProcess` + the **Update Info** results tab.

Cross-references: ADR-001 (IGitService freeze), ADR-010,
`docs/parity/full-parity-audit-2026-06-15.md` §C Item 5, and the git4idea
reference `plugins/git4idea/backend/src/update/{GitUpdateProcess.java,
GitUpdateOptionsDialog.kt}` + `shared/.../config/UpdateMethod.java`.

## 0. Repo-state landmap (ADR-010 Layer 4)

| State | Behaviour | Coverage |
| --- | --- | --- |
| default, upstream set, incoming > 0 | fetch → pull with chosen strategy → `updated` | covered (updateProjectFlow.test.ts) |
| in sync (incoming = 0) | fetch only → `up-to-date`, no pull | covered |
| no upstream | `up-to-date`, no pull | covered |
| rebase/merge in progress | per-repo `error` (preflight block), other repos continue | covered |
| unmerged files | per-repo `error` (preflight block) | covered |
| pull conflict | per-repo `conflict` | covered |
| multi-root | each root updated independently, results aggregated | covered |

## 1. Update method (GitUpdateOptionsDialog / UpdateMethod)

The dialog (a QuickPick) offers three methods, mirroring git4idea's
`UpdateMethod` (RESET is out of scope for the pure-Git surface):

- **Merge** → `git pull` (merge fetched commits; fast-forwards when possible).
- **Rebase** → `git pull --rebase` (replay local commits on the fetched tip).
- **Branch default** → resolve per repo.

### 1.1 BRANCH_DEFAULT resolution

git4idea's `GitUpdater.getUpdater(BRANCH_DEFAULT)` reads, in order:
`branch.<name>.rebase` → `pull.rebase` → MERGE.

IntelliG approximates this with the `intellig.pullRebase` setting (the
IntelliG analog of `pull.rebase`): `resolveUpdateRebase('branch-default',
pullRebaseDefault)`. The finer-grained per-branch `branch.<name>.rebase`
override needs a `git config` read on the service — a **deferred
cross-cutting change** (a new git op + GitService method, ADR-001 pattern).
Until then, branch-default == the repo/global pull.rebase analog.

## 2. GitUpdateProcess flow (`runUpdateProject`)

For each repository (multi-root):

1. **Preflight** (`updateProjectBlockedReason`): block on rebase/merge in
   progress or unmerged files (GitUpdateProcess parity). A blocked repo is
   recorded as `error` and the run continues with the next repo.
2. **`git fetch --all --prune`**.
3. **Incoming count** via Phase-0a `getIncomingOutgoing` — populates the
   Update Info summary and short-circuits `up-to-date` when nothing is
   incoming / no upstream.
4. **`git pull`** with the resolved strategy. A `CONFLICT` failure →
   `conflict`; any other failure → `error`.

The flow is pure orchestration over an injected git surface
(`IUpdateGitService`) — no `vscode` import — so it is fully unit-testable.

> **Deferred vs git4idea**: the save-local-changes (autostash) step is NOT
> performed here; it is owed to the Pull `--autostash` follow-up (§C Item 6,
> a cross-cutting change in `IPullOptions` + `RemoteOps`). The rebase-over-
> merge problem dialog and the per-root `GitUpdatedRanges` log-range
> computation are also out of scope for this pass.

## 3. Update Info tab (`UpdateInfoTab`)

Holds the latest `IUpdateInfoSummary` (per-repo `IUpdateRepoResult[]` +
totals). `updateInfoHeadline(summary)` produces the one-line outcome used by
the post-update notification and the tab header:

- conflicts present → "Update finished with N conflict(s) …"
- errors present → "Update failed in N of M repo(s)."
- nothing incoming → "Already up to date." / "All repositories already up to date."
- otherwise → "Updated N repositories; K commit(s) pulled."

### 3.1 Render + provider wiring (DEFERRED to the Log/Graph workstream)

`UpdateInfoTab` exposes `setSummary(summary)` + `asTabHandler()` + an
`onStateChange` hook, mirroring HistoryTab/IncomingTab. The HTML renderer
(`html/updateInfoHtml.ts`) and the provider wiring that calls `setSummary`
after `intellig.updateProject` runs live in the Log/Graph (G) workstream.
Until that lands, the command surfaces the headline via a notification with a
"Show Update Info" deep-link that focuses the `updateInfo` tab.

## 4. Test coverage

- Method resolution: `resolveUpdateRebase`, `buildUpdatePullOptions`.
- Orchestration: `runUpdateProject` (single/multi-root, in-sync, no-upstream,
  blocked, conflict, error) — `updateProjectFlow.test.ts`.
- Summary fold + headline: `summarizeUpdate`, `updateInfoHeadline`.
- Tab state machine: `UpdateInfoTab` (setSummary, refresh, jump, malformed).
- Preflight predicate: `updateProjectGuard.test.ts` (pre-existing).
