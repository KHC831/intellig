#!/usr/bin/env bash
#
# Structural CI guard — a git merge-conflict predicate must delegate to the
# shared definition in gitParser.ts, never a hand-rolled `=== 'U'` check.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Porcelain v1 marks an unmerged path with `U` in either column, BUT
#    both-added (`AA`) and both-deleted (`DD`) are also unmerged with no `U`
#    in sight. A hand-rolled `indexStatus === 'U' || workTreeStatus === 'U'`
#    silently misses AA/DD — a real gap after a rebase/stash re-apply that
#    collides on an added or deleted path (git exits 0, the conflict is
#    invisible to the check). The single definition is `isConflictedStatusCode`
#    / `isConflictedStatus` in src/git-core/gitParser.ts; every caller must
#    delegate to it. This class was found across the SCM partition, the native
#    commit staged-set filter, the rebase conflict picker, and a duplicated
#    CheckinChecks copy; this guard locks the delegation.
#
# 2. Heuristic + how it scales
#    Fail on any comparison against a `'U'` / `"U"` status literal
#    (`=== 'U'` or `!== 'U'`) under `src`, excluding gitParser.ts (the shared
#    home) and `src/test`. In this codebase `U` is only ever the git unmerged
#    status code, so a bare value match is precise; comment-only lines are
#    stripped so prose mentions do not trip it. A line carrying
#    `conflict-predicate-exempt: <reason>` is skipped — sanctioned where `U`
#    is a single-letter marker in a DIFFERENT git output format (e.g.
#    `git diff --name-status`, where no AA/DD composite exists). Two modes:
#      * DEFAULT (no args — the gate): `git grep` over tracked `src`.
#      * EXPLICIT PATHS (companion spec): recursive `grep` over given dirs.
#
# 3. Known false-positive cases
#    A new single-letter `--name-status` / `--raw` consumer comparing to `U`
#    trips the gate until the author adds the exempt marker with a reason —
#    the intended review touchpoint, not a defect.
#
# 4. Retirement criteria
#    Retire when status codes are a branded type whose only conflict test is
#    the shared predicate, making a raw `=== 'U'` comparison unrepresentable.
#
# Exit: 0 on clean, 1 if any unmarked hand-rolled `=== 'U'` predicate is found.
#
# Manual repro of the red:
#   echo "if (s.indexStatus === 'U') return true;" > /tmp/x.ts
#   bash scripts/check-conflict-predicate-shared.sh /tmp/x.ts   # exits 1

set -euo pipefail
cd "$(dirname "$0")/.."

# A comparison against a `'U'` / `"U"` status literal.
PATTERN="(===|!==)[[:space:]]*['\"]U['\"]"
MARKER='conflict-predicate-exempt:'
# Strip full-line comments (`//`, `*`, `/*`) so prose mentions never match.
COMMENT='^[[:space:]]*(//|\*|/\*)'

if [ "$#" -eq 0 ]; then
  raw=$(git grep -nIE "$PATTERN" -- 'src' ':!src/git-core/gitParser.ts' ':!src/test' 2>/dev/null || true)
else
  raw=$(grep -rnIE --include='*.ts' "$PATTERN" "$@" 2>/dev/null || true)
fi

if [ -n "$raw" ]; then
  # Drop exempt-marked lines, then drop comment-only lines. `grep -nIE` output
  # is `path:lineno:code`; the comment test looks past the two-field prefix.
  hits=$(printf '%s\n' "$raw" \
    | grep -vF "$MARKER" \
    | grep -vE ":[0-9]+:${COMMENT#^}" \
    || true)
else
  hits=""
fi

if [ -n "$hits" ]; then
  echo "check-conflict-predicate-shared: a hand-rolled '=== U' conflict check —" >&2
  echo "  this misses both-added (AA) and both-deleted (DD) conflicts. Delegate to" >&2
  echo "  isConflictedStatus(file) / isConflictedStatusCode(index, workTree) from" >&2
  echo "  src/git-core/gitParser.ts. If 'U' here is a single-letter marker in a" >&2
  echo "  different git output (e.g. --name-status), append the marker" >&2
  echo "  '// ${MARKER} <why>' to the line. Offending lines:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "check-conflict-predicate-shared: OK (conflict predicate is shared)."
