#!/usr/bin/env bash
#
# Structural CI guard — the rebase state-dir names (`rebase-merge` /
# `rebase-apply`) live ONLY in src/git-core/gitDirMarkers.ts, the module that
# owns the marker-file contract distinguishing what those directories mean.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    `rebase-apply/` backs BOTH a `git am` session and an am-based rebase;
#    only the `applying` flag file separates them (git wt-status.c). A site
#    that hand-rolls the directory name gets the directory check without the
#    marker check — exactly how a paused `git am` masqueraded as a REBASE
#    and was offered `git rebase --continue/--abort`, which git refuses
#    during am. Forcing every state-dir reference through gitDirMarkers'
#    constants/readers keeps the marker disambiguation attached to the
#    directory name.
#
# 2. Heuristic + how it scales
#    Fail on any non-comment line under `src` carrying `rebase-merge` or
#    `rebase-apply` inside a string or regex literal — EXCEPT the sanctioned
#    module. `rebase-merges` (the `--rebase-merges` CLI flag and its prose)
#    is excluded via a trailing-`s` guard. Comment-only lines are skipped:
#    docs may name the dirs freely. A new consumer imports
#    REBASE_MERGE_DIR / REBASE_APPLY_DIR / REBASE_STATE_DIRS (or a reader)
#    and inherits the marker contract; a literal fails the gate. Escape
#    hatch: `// git-dir-marker-exempt: <reason>` on the same or preceding
#    line — sanctioned where the text is provably not a `.git` path (e.g.
#    UI copy).
#    Two modes: DEFAULT (no args — the gate) via `git grep --untracked`
#    over tracked and new-but-uncommitted src; EXPLICIT PATHS (companion
#    spec) via recursive grep over the given dirs, where every file is
#    non-sanctioned so fixtures exercise the teeth.
#
# 3. Known false-positive cases
#    A string that legitimately mentions the dir name without touching
#    `.git` (a toast explaining rebase internals) trips the gate until the
#    author adds the exempt marker — the intended review touchpoint. None
#    exist today.
#
# 4. Known false-negative cases
#    A dir name assembled from fragments (`'rebase-' + kind`) or read from
#    config slips the literal pattern. Review is the backstop.
#
# 5. Retirement criteria
#    Retire if the state-dir probing moves behind a single typed facade that
#    consumers cannot bypass (constants no longer exported).
#
# Exit: 0 on clean, 1 if any stray literal is found.
#
# Manual repro of the red:
#   mkdir -p /tmp/gdm && echo "const p = path.join(gitDir, 'rebase-apply');" > /tmp/gdm/x.ts
#   bash scripts/check-git-dir-markers.sh /tmp/gdm   # exits 1

set -euo pipefail
cd "$(dirname "$0")/.."

# The dir name inside a string/regex literal: an opening quote/backtick/slash
# somewhere before it on the line, and NOT followed by `s` (--rebase-merges).
PATTERN="['\"\`/][^'\"\`]*rebase-(merge|apply)([^s]|\$)"
MARKER='git-dir-marker-exempt:'
SANCTIONED='src/git-core/gitDirMarkers.ts'

if [ "$#" -eq 0 ]; then
  raw=$(git grep --untracked -nIE "$PATTERN" -- 'src/*.ts' 'src/**/*.ts' 2>/dev/null || true)
else
  raw=$(grep -rnIE --include='*.ts' "$PATTERN" "$@" 2>/dev/null || true)
fi

fail=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  file=${hit%%:*}
  rest=${hit#*:}
  line=${rest%%:*}
  code=${rest#*:}

  # Sanctioned module (default mode only — explicit paths test the teeth).
  if [ "$#" -eq 0 ] && [ "$file" = "$SANCTIONED" ]; then
    continue
  fi

  # Comment-only lines: docs may name the dirs freely.
  trimmed=$(printf '%s' "$code" | sed 's/^[[:space:]]*//')
  case "$trimmed" in
    //*|\**|/\**) continue ;;
  esac

  # Escape hatch on the same or the preceding line.
  case "$code" in
    *"$MARKER"*) continue ;;
  esac
  if [ "$line" -gt 1 ] && sed -n "$((line - 1))p" "$file" | grep -q "$MARKER"; then
    continue
  fi

  if [ "$fail" -eq 0 ]; then
    echo "check-git-dir-markers: rebase state-dir literal outside gitDirMarkers.ts." >&2
    echo "  'rebase-merge'/'rebase-apply' carry a marker-file contract (the" >&2
    echo "  'applying' flag separates a git-am session from a rebase); import" >&2
    echo "  REBASE_MERGE_DIR / REBASE_APPLY_DIR / REBASE_STATE_DIRS or a reader" >&2
    echo "  from src/git-core/gitDirMarkers.ts instead, or justify with" >&2
    echo "  '// $MARKER <reason>' when the text is not a .git path." >&2
    echo "  Offending lines:" >&2
  fi
  echo "  $file:$line: $trimmed" >&2
  fail=1
done <<< "$raw"

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "check-git-dir-markers: OK"
