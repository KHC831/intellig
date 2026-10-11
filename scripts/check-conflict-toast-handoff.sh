#!/usr/bin/env bash
#
# Structural CI guard — a post-operation conflict toast must be the FALLBACK
# behind a Resolve Conflicts dialog handoff, never the only surface.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    An op result with `conflicts` (merge / rebase / cherry-pick / revert /
#    unstash) leaves the repo mid-operation. Surfacing that as a bare
#    "… file(s). Please resolve conflicts." warning dead-ends the user with
#    no resolve/continue/abort affordance while every sibling path opens the
#    Resolve Conflicts dialog. The class was found live on the tag
#    cherry-pick arm (toast-only while branch and commit cherry-picks handed
#    off); this guard locks the handoff pattern: the toast is legal only as
#    the no-service fallback.
#
# 2. Heuristic + how it scales
#    Fail on any line under `src` matching the canonical fallback prose
#    `file(s). Please resolve conflicts` whose PRECEDING 25 lines do not
#    mention `conflictResolutionService` (the service guard the fallback
#    must sit behind). New conflict arms reusing the same prose inherit the
#    check automatically. A line carrying `conflict-toast-exempt: <reason>`
#    is skipped — sanctioned where the prose is used outside a post-op
#    conflict arm. Two modes:
#      * DEFAULT (no args — the gate): `git grep --untracked` over tracked
#        AND new-but-uncommitted `src`.
#      * EXPLICIT PATHS (companion spec): recursive `grep` over given dirs.
#
# 3. Known false-positive cases
#    A guarded arm whose service check drifts more than 25 lines above the
#    fallback toast (giant doc comment inside the method) trips the gate;
#    either tighten the method or add the exempt marker with a reason — the
#    intended review touchpoint.
#
# 4. Retirement criteria
#    Retire when conflict surfacing is a single shared helper (typed result →
#    dialog-or-toast) and handlers can no longer emit the toast directly.
#
# Exit: 0 on clean, 1 if any unguarded conflict toast is found.
#
# Manual repro of the red:
#   mkdir -p /tmp/cth && echo 'void vscode.window.showWarningMessage(`Merge conflicts in 2 file(s). Please resolve conflicts.`);' > /tmp/cth/x.ts
#   bash scripts/check-conflict-toast-handoff.sh /tmp/cth   # exits 1

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib/grep-hit.sh
source scripts/lib/grep-hit.sh

PATTERN='file\(s\)\. Please resolve conflicts'
GUARD='onflictResolutionService'
MARKER='conflict-toast-exempt:'
WINDOW=25

if [ "$#" -eq 0 ]; then
  raw=$(git grep --untracked -nIE "$PATTERN" -- 'src/*.ts' 'src/**/*.ts' 2>/dev/null || true)
else
  raw=$(grep -rnIE --include='*.ts' "$PATTERN" "$@" 2>/dev/null || true)
fi

fail=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  split_grep_hit "$hit"
  file=$HIT_FILE line=$HIT_LINE code=$HIT_TEXT
  case "$code" in
    *"$MARKER"*) continue ;;
  esac
  start=$((line - WINDOW))
  [ "$start" -lt 1 ] && start=1
  if ! sed -n "${start},${line}p" "$file" | grep -q "$GUARD"; then
    if [ "$fail" -eq 0 ]; then
      echo "check-conflict-toast-handoff: a bare conflict toast without a Resolve" >&2
      echo "  Conflicts dialog handoff. The toast is legal only as the fallback" >&2
      echo "  behind a conflictResolutionService guard (within $WINDOW lines). Hand" >&2
      echo "  conflicts to openResolveConflictsDialog first, or append" >&2
      echo "  '// ${MARKER} <why>' if this prose is not a post-op conflict arm." >&2
      echo "  Offending lines:" >&2
    fi
    echo "  $file:$line" >&2
    fail=1
  fi
done <<< "$raw"

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-conflict-toast-handoff: OK (conflict toasts sit behind the dialog handoff)."
