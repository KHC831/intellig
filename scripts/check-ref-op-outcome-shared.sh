#!/usr/bin/env bash
#
# Structural CI guard — a branch-menu ref operation must route its outcome
# through the shared router, never re-type the ladder.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Merge, cherry-pick and rebase all answer the same three-way result
#    (success / conflicts / non-conflict failure) and every branch-menu site
#    grew its own copy of the ladder — eight copies across four files. Copies
#    drift silently: a mislabelled `operation` hands the resolver the wrong
#    ours/theirs orientation, a dropped `failureReason` turns a real git
#    refusal into a no-op, and a conflict arm that toasts instead of opening
#    the dialog leaves the sequencer mid-operation with no way out. The
#    ladder now lives once in src/branches/refOperationOutcome.ts.
#
# 2. Heuristic + how it scales
#    Fail on any line under `src/branches` testing `result.conflicts…length`
#    whose FOLLOWING 10 lines call none of the routers
#    (`routeRefOperationOutcome`, `routeRebaseOutcome`, or the dispatcher's
#    `surfaceRebaseConflicts`, which owns continuability). Re-typing the
#    ladder trips it; a new action module inherits the check for free.
#    refOperationOutcome.ts — where the ladder legitimately lives — is
#    skipped by basename. A line carrying `ref-op-outcome-exempt: <reason>`
#    is skipped. Two modes:
#      * DEFAULT (no args — the gate): `git grep --untracked` over tracked
#        AND new-but-uncommitted `src/branches`.
#      * EXPLICIT PATHS (companion spec): recursive `grep` over given dirs.
#
# 3. Known false-positive cases
#    A site that legitimately inspects `result.conflicts` for something other
#    than routing (a count for telemetry, say) and routes more than 10 lines
#    later. Move the routing call up or add the exempt marker with a reason —
#    the intended review touchpoint.
#
# 4. Known false-negative cases
#    A hand-rolled ladder that tests conflicts some other way
#    (`conflicts.length` off a destructured local). The toast half of that
#    shape is still caught by check-conflict-toast-handoff.
#
# 5. Retirement criteria
#    Retire when git results reach the UI as a typed outcome the callers
#    cannot destructure — at which point re-typing the ladder stops compiling.
#
# Exit: 0 on clean, 1 if any site re-types the ladder.
#
# Manual repro of the red:
#   mkdir -p /tmp/rops && printf 'if (result.conflicts && result.conflicts.length > 0) {\n  await ctx.openResolveConflictsDialog(repo, result.conflicts, opts);\n}\n' > /tmp/rops/x.ts
#   bash scripts/check-ref-op-outcome-shared.sh /tmp/rops   # exits 1

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/grep-hit.sh
source scripts/lib/grep-hit.sh

PATTERN='result\.conflicts[?]?\.length'
ROUTERS='routeRefOperationOutcome|routeRebaseOutcome|surfaceRebaseConflicts'
HOME_FILE='refOperationOutcome.ts'
MARKER='ref-op-outcome-exempt:'
WINDOW=10

if [ "$#" -eq 0 ]; then
  raw=$(git grep --untracked -nIE "$PATTERN" -- 'src/branches/*.ts' 2>/dev/null || true)
else
  raw=$(grep -rnIE --include='*.ts' "$PATTERN" "$@" 2>/dev/null || true)
fi

fail=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  split_grep_hit "$hit"
  file=$HIT_FILE line=$HIT_LINE code=$HIT_TEXT
  case "$(basename "$file")" in
    "$HOME_FILE") continue ;;
  esac
  case "$code" in
    *"$MARKER"*) continue ;;
  esac
  end=$((line + WINDOW))
  if ! sed -n "${line},${end}p" "$file" | grep -qE "$ROUTERS"; then
    if [ "$fail" -eq 0 ]; then
      echo "check-ref-op-outcome-shared: a re-typed outcome ladder. Route the" >&2
      echo "  result through routeRefOperationOutcome / routeRebaseOutcome (or" >&2
      echo "  surfaceRebaseConflicts for a rebase) within $WINDOW lines, so the" >&2
      echo "  operation label, the dialog handoff and git's failure reason stay" >&2
      echo "  in one place. Append '// ${MARKER} <why>' if this read is not a" >&2
      echo "  routing decision. Offending lines:" >&2
    fi
    echo "  $file:$line" >&2
    fail=1
  fi
done <<< "$raw"

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-ref-op-outcome-shared: OK (every branch-menu outcome routes through the shared ladder)."
