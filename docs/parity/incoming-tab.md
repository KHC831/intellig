# Parity reference: Incoming tab

Layer-3 reference doc (ADR-010) for the Git tool window **Incoming** tab.
IntelliJ reference: git4idea's "Incoming" view, fed by
`GitBranchIncomingOutgoingManager` (the same notion that drives the
incoming/outgoing branch arrows).

Cross-references: ADR-001 (IGitService freeze), ADR-010 (visual parity
discipline), `docs/parity/full-parity-audit-2026-06-15.md` §C Item 4.

## 0. Repo-state landmap (ADR-010 Layer 4)

| State | Behaviour | Coverage |
| --- | --- | --- |
| default (attached HEAD, upstream set) | lists incoming commits; shows counts | covered (incomingTab.test.ts, incomingCommitSelection.property) |
| no upstream | `noUpstream: true`, empty list, no log calls | covered |
| in sync (incoming = 0) | empty list, no log calls | covered |
| diverged (branch + upstream both moved) | exact upstream-minus-HEAD difference | covered (property test) |
| detached HEAD | resolves to `branch: 'HEAD'`, treated as no-upstream by 0a | inherited from `IncomingOutgoingOps.getForCurrentBranch` |
| empty repo / mid-op | `getIncomingOutgoing` returns zero counts → empty list | inherited from 0a; renderer-stage NOT covered (deferred to Log/Graph stream) |

## 1. Data model

The tab's state (`IIncomingTabState`) is:

- `branch` — current branch (or `HEAD` when detached)
- `upstream` — resolved tracking ref (e.g. `origin/main`), or `undefined`
- `incomingCount` — git "behind" count (commits a pull would bring in)
- `outgoingCount` — git "ahead" count (shown as context)
- `noUpstream` — true when the branch tracks nothing
- `commits` — the incoming commits, newest first
- `selectedCommit` — selected row hash
- `error` / `loading` — UI side-bands

### 1.1 Where the data comes from

- **Counts + upstream**: `GitService.getIncomingOutgoing` (Phase 0a) —
  `git rev-list --left-right --count <upstream>...HEAD`.
- **Commit list**: computed as the **set difference** of the upstream's log
  and HEAD's log, keyed on commit hash
  (`selectIncomingCommits(upstreamLog, headHashSet(headLog))`). This uses only
  the frozen `IGitService.getLog`, so the tab adds **no new git op** (ADR-001).
  The set-difference is exact even when the branch and upstream have diverged —
  a naïve "top N of the upstream log" slice would be wrong in that case.

## 2. Render rules (DEFERRED to the Log/Graph workstream)

The HTML renderer lives in `src/git-core/gitToolWindow/html/incomingHtml.ts`
and the provider wiring in `GitToolWindowProvider.ts` — both owned by the
Log/Graph (G) workstream. This workstream (C) ships the **data + handler
layer** only (`tabs/IncomingTab.ts`). The intended render contract, for G to
implement against this state:

- Header row: `↓<incomingCount>` badge, branch → upstream label, and a Pull
  button when `incomingCount > 0`.
- "No upstream" empty state when `noUpstream`.
- "Up to date" empty state when `incomingCount === 0 && !noUpstream`.
- One row per `commits[i]`: short hash, first message line, author, date.
- Row click posts `incoming.selectCommit`; double-click / Enter posts
  `incoming.jumpToCommit` (routed to the Log tab's scroll-to-commit).
- `error` rendered as an inline banner (HistoryTab state-sideband pattern).

## 3. Message protocol

Inbound (webview → host):

- `incoming.refresh` — recompute counts + list
- `incoming.selectCommit { hash }` — record selection
- `incoming.jumpToCommit { hash }` — route to the Log tab via the
  `jumpToCommit` hook

Outbound (host → webview), posted by the provider via the `onStateChange`
hook: `incoming.updateState { state }`.

## 4. Test coverage (snapshot back-references)

- Pure set-difference: `selectIncomingCommits` / `headHashSet`
  (`incomingTab.test.ts`, `incomingCommitSelection.property.test.ts` — 200-run
  fast-check).
- State machine: refresh (no-upstream / in-sync / diverged / error / no-repo),
  selection, jump routing, malformed-message handling, `onStateChange`
  loading→settled emission (`incomingTab.test.ts`).
- Renderer-stage / jsdom-layout snapshots are owed when the Log/Graph stream
  lands `incomingHtml.ts` (ADR-010 Layer 1 multi-stage discipline).
