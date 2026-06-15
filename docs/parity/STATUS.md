# IntelliJ-parity — status & landing log

_Living tracker: current state, what's landed, and the next step. The analysis/plan (gaps,
heatmap, execution order) lives in **[`NORTHSTAR.md`](./NORTHSTAR.md)**. Updated 2026-06-15._

## Current state

- `main` carries the R1 correctness pass + Phase-0 foundations + workstreams **A** and **C**.
- Three tracks merged via PR on 2026-06-15 in the recommended conflict-minimizing order:
  **#42** (crash fix) → **#43** (workstream C) → **#44** (workstream A).
- **Next up:** the 🔴 `RemoteOps.fetch` argv-injection fix (+ CI grep gate), then the UX quick
  wins and unwired front-doors batch — see `NORTHSTAR.md` section 7.

## Landing log

Newest at top. PR# where merged via GitHub; otherwise local squash commit.

| When | Item | Ref | Notes |
|---|---|---|---|
| 2026-06-15 | Workstream A — commit/changelists (changelist-driven commit, before-commit checks, Add-to-VCS fix, Local Changes grouping + Unversioned node, diff-preview, tool-window default-on, AA/DD detection) | #44 | merged |
| 2026-06-15 | Workstream C — shell/menus/sync (keymap fixes, status-bar branch popup, view/title toolbar, Incoming tab, Update Project dialog, structured notifications) | #43 | merged |
| 2026-06-15 | Crash fix — cap git output capture at 64 MiB (stops extension-host RangeError on multi-GB repos) | #42 | merged |
| 2026-06-15 | Phase-0 foundations — IncomingOutgoingOps, IChangelist.isActive, KeymapService de-drift | 267d718 | base for A/C/D/G |
| 2026-06-14 | R1 P3 — reset-mode persistence, rebase-options persistence, Copy Commit Message, deleteRemoteTag op | 43b09c5…e1c1e75 | local squash |
| 2026-06-14 | R1 P2 — rebase options, rebase-in-progress guard, revert-hunk, add-to-gitignore, remote set-url/rename, getMergedBranches, tag force, cherry-pick -x, merge options, Update Project (backend) | fd15118…2eedae9 | local squash |
| 2026-06-14 | R1 P1 — all 9 silent-wrong ops + #5 filter-bar UI + #4 rebase-todo preservation | 075b3d4…0bca889 | local squash |

## Review/evidence artifacts

- `NORTHSTAR.md` — high-level plan (heatmap, component gaps, R2 findings, execution order).
- `R2-01-log` … `R2-09-shell`, `R2-UX-01` … `R2-UX-04` — per-area review detail with file:line refs.
- `full-parity-audit` content is folded into `NORTHSTAR.md` (the standalone file was removed in the
  2026-06-15 doc consolidation).
- Reference/design docs: `accessibility.md`, `changed-files-tree.md`, `git-log-graph.md`,
  `repo-states.md`; track design notes `before-commit-checks.md`, `commit-tool-window-changes.md`,
  `incoming-tab.md`, `update-project.md`.

## Open risk carried forward
- 🔴 `RemoteOps.fetch` argv-injection — still open, not addressed by any landed track (NORTHSTAR section 5).
- R2 review predates the A/C/phase-0 merges — re-verify findings against the merged tree.
