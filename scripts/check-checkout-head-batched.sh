#!/usr/bin/env bash
#
# Structural CI guard — a `git checkout HEAD -- <paths>` over a caller-supplied
# path list must route through restorePathsToHead, never a bare batched exec.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    `git checkout HEAD -- <path>` FATALS ("pathspec did not match any
#    file(s) known to git", exit 128) for a path that is ABSENT from HEAD —
#    a both-added (add/add) conflict file, or a file the reverted commit
#    DELETED. When such a path is batched into one `checkout HEAD -- a b c`,
#    the whole exec exits non-zero having restored NOTHING, so a rollback /
#    abort / partial-revert flow fails entirely exactly when the selection
#    includes a HEAD-absent path. The fix is uniform: route through the shared
#    restore-to-HEAD writer (src/git-core/worktree/restoreToHead.ts), which
#    probes each path's HEAD membership and UNINDEXES the absent ones (git4idea
#    GitRollbackEnvironment.rollbackChanges unversions a NEW file) instead of
#    checking them out. This class was fixed in abortWorkingTreeConflicts and
#    the selective-revert exclude path; this guard locks it closed.
#
# 2. Heuristic + how it scales
#    Fail on any argv literal of the shape `['checkout', 'HEAD', '--', ...]`
#    (quote style / whitespace tolerant) under `src`, excluding `src/test` and
#    the sanctioned writer restoreToHead.ts (which owns the ONE safe batched
#    checkout, after partitioning HEAD-present paths). A line carrying the
#    opt-out marker `checkout-head-exempt: <reason>` is skipped — sanctioned
#    only where the path is provably present in HEAD (so a fatal is impossible)
#    or a caller already has its own HEAD-absent fallback. The guard runs in
#    two modes:
#      * DEFAULT (no path args — the real gate): `git grep --untracked` over
#        tracked AND new-but-uncommitted files under `src` (gitignored scratch
#        stays out), excluding `src/test` and the writer.
#      * EXPLICIT PATHS (used by the companion spec): plain recursive
#        `grep -rnIE` over the given paths (temp fixtures are not git dirs).
#
# 3. Known false-positive cases
#    A new site whose path is provably HEAD-tracked (e.g. a status branch that
#    already excluded the added case) trips the gate until the author adds the
#    `checkout-head-exempt: <reason>` marker — the intended review touchpoint,
#    not a defect.
#
# 4. Retirement criteria
#    Retire when restorePathsToHead is the only code allowed to spawn a
#    `checkout HEAD --` (e.g. a typed writer boundary makes the raw argv
#    unrepresentable outside git-core/worktree).
#
# Exit: 0 on clean, 1 if any unmarked batched `checkout HEAD --` argv is found.
#
# Manual repro of the red:
#   echo "await cli.exec(['checkout', 'HEAD', '--', ...paths]);" > /tmp/x.ts
#   bash scripts/check-checkout-head-batched.sh /tmp/x.ts   # exits 1

set -euo pipefail

# An argv literal `['checkout', 'HEAD', '--', ...]` — single or double quotes,
# any inter-element whitespace.
PATTERN="['\"]checkout['\"],[[:space:]]*['\"]HEAD['\"],[[:space:]]*['\"]--['\"]"
MARKER='checkout-head-exempt:'

if [ "$#" -eq 0 ]; then
  raw=$(git grep --untracked -nIE "$PATTERN" -- 'src' ':!src/test' \
    ':!src/git-core/worktree/restoreToHead.ts' 2>/dev/null || true)
else
  raw=$(grep -rnIE --include='*.ts' "$PATTERN" "$@" 2>/dev/null || true)
fi

if [ -n "$raw" ]; then
  hits=$(grep -vF "$MARKER" <<<"$raw" || true)
else
  hits=""
fi

if [ -n "$hits" ]; then
  echo "check-checkout-head-batched: a bare 'checkout HEAD -- <paths>' exec — this" >&2
  echo "  fatals (exit 128) for any path ABSENT from HEAD (add/add conflict, or a" >&2
  echo "  file the reverted commit deleted), failing the whole batch. Route through" >&2
  echo "  restorePathsToHead (src/git-core/worktree/restoreToHead.ts), which probes" >&2
  echo "  HEAD membership and unindexes the absent paths. If the path is provably in" >&2
  echo "  HEAD (or the caller has its own HEAD-absent fallback), append the marker" >&2
  echo "  '// ${MARKER} <why>' to the line. Offending lines:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "check-checkout-head-batched: OK (no bare batched checkout HEAD --)."
