#!/usr/bin/env bash
#
# Structural CI guard — a conflicted extension-driven rebase is left PAUSED for
# the resolve dialog; auto-abort is user-initiated only.
#
# (This is check (a) of the former combined guard. Checks (b) executeRebase-
# only-inside-the-runner and (c) the-runner-keeps-its-gates were ported to
# scripts/check-rebase-runner-scope.mjs, whose indent-anchored scope detection
# handles the runner in EITHER home — the dispatcher class or the extracted
# history-rewrite module. Check (a) below is glob-wide, so it already covers the
# extracted module with no change.)
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    A conflicted rebase auto-aborted (destroying the user's resolvable state,
#    against git4idea's GitRebaseProcess whose conflict loop never aborts). The
#    pause-correct conflict arm is hand-rolled in several places — each a drift
#    site — so the abort check runs REPO-scope: no auto-abort re-entry anywhere.
#
# 2. Heuristic + how it scales
#    `abortRebase(` / `rebaseAbort(` across `src/**/*.ts` may appear only in the
#    allow-listed user-action surfaces (the resolve dialog + its service, the
#    rebase progress view's confirmed abort handler, the RebaseService/BranchOps/
#    GitService ops + their interfaces, palette/toast command registrations, the
#    paused-warning wiring) or behind a `// rebase-abort-exempt: <reason>`
#    justification on the same or preceding line. The two orphaned-rebase
#    recovery sites (BranchContextMenuCommands / RebaseDialog) carry the marker:
#    they fire only on a NON-conflict failure when the state boundary proves the
#    invocation itself created the rebasing state. DEFAULT (no args) scans the
#    tracked tree; EXPLICIT PATHS (companion spec) treat every file as
#    non-allow-listed so fixtures exercise the teeth.
#
# 3. Known false-positive cases
#    A comment spelling `abortRebase(`/`rebaseAbort(` with the parenthesis would
#    match (none exist; comments reference the bare names). Mark such a line with
#    the exempt marker if it appears.
#
# 4. Known false-negative cases
#    An abort reached through an aliased service or a raw
#    `gitCli.exec(['rebase','--abort'])` outside the allow-listed ops slips the
#    literal patterns. Review is the backstop.
#
# 5. Retirement criteria
#    Retire if an eslint no-restricted-syntax rule takes over the abort check.

set -euo pipefail
cd "$(dirname "$0")/.."

# User-action surfaces + the ops/interfaces that DEFINE abort. Everything else
# in src/** needs a justification comment.
ALLOW_RE='^src/(conflicts/(ResolveConflictsDialog|ConflictResolutionService)\.ts|conflicts/interfaces/|git-core/(RebaseService|GitService)\.ts|git-core/ops/BranchOps\.ts|git-core/interfaces/|rebase/RebaseProgressView\.ts|commands/registration/|registration/wiring\.ts)'

if [ "$#" -eq 0 ]; then
  abort_files=$(git ls-files --cached --others --exclude-standard -- 'src/**/*.ts' \
    | grep -vE "$ALLOW_RE" || true)
else
  abort_files=$(find "$@" -name '*.ts' -type f 2>/dev/null || true)
fi

fail=0

# ── No auto-abort re-entry (repo-scope) ─────────────────────────────────────
for f in $abort_files; do
  abort_hits=$(awk '
    {
      if ($0 ~ /(abortRebase|rebaseAbort)\(/ \
          && $0 !~ /rebase-abort-exempt:/ && prev !~ /rebase-abort-exempt:/) {
        printf "%s:%d: %s\n", FILENAME, FNR, $0
      }
      prev = $0
    }
  ' "$f")
  if [ -n "$abort_hits" ]; then
    if [ "$fail" -eq 0 ]; then
      echo "check-rebase-conflict-flow: abortRebase(/rebaseAbort( outside the"
      echo "allow-listed user-action surfaces. A conflicted rebase is left PAUSED"
      echo "for the resolve dialog; abort is user-initiated only (dialog Abort,"
      echo "palette, paused-warning toast, terminal). Route the flow through"
      echo "runHistoryRewrite, or justify with '// rebase-abort-exempt: <reason>'"
      echo "on the same or preceding line."
      echo
    fi
    echo "$abort_hits"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-rebase-conflict-flow: OK"
