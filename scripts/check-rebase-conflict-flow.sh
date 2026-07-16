#!/usr/bin/env bash
#
# Structural CI guard — the history-rewrite conflict contract: a conflicted
# extension-driven rebase is left PAUSED for the resolve dialog, and every
# rebase-editing flow rides the single `_runHistoryRewrite` runner.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    The four rebase-editing flows (single/multi drop, squash/fixup, reword)
#    each hand-rolled their own start → execute → outcome skeleton, and every
#    copy drifted differently on the conflict arm — auto-aborting the rebase
#    (destroying the user's resolvable state, against git4idea's
#    GitRebaseProcess, whose conflict loop never aborts) or opening the
#    resolve dialog with untruthful continue/abort affordances. The fix
#    collapsed them onto `_runHistoryRewrite`, whose single outcome switch
#    owns the pause-never-abort contract. A repo audit found no further
#    auto-abort-on-conflict instances, but the pause-correct conflict arm is
#    hand-rolled in several other places — each currently correct, each a
#    drift site — so the abort check runs REPO-scope. This guard keeps both
#    halves closed: no auto-abort re-entry anywhere, and no fifth
#    hand-rolled skeleton in the history-rewrite module.
#
# 2. Heuristic + how it scales
#    Two mechanical checks:
#      a. `abortRebase(` / `rebaseAbort(` across `src/**` may appear only in
#         the allow-listed user-action surfaces (the resolve dialog + its
#         service, the rebase progress view's confirmed abort handler, the
#         RebaseService/BranchOps/GitService ops themselves + their
#         interfaces, palette/toast command registrations, and the
#         paused-warning wiring) or behind a
#         `// rebase-abort-exempt: <reason>` justification on the same or
#         preceding line. The two orphaned-rebase recovery sites
#         (BranchContextMenuCommands / RebaseDialog) carry the marker: they
#         fire only on a NON-conflict failure and only when the before/after
#         state boundary proves the invocation itself created the rebasing
#         state.
#      b. `.executeRebase(` in `src/commits/*.ts` (the history-rewrite
#         module) may appear only inside the `_runHistoryRewrite` method
#         (scope: from its `private async _runHistoryRewrite(` signature to
#         the next class member at two-space indent). A new history-rewrite
#         flow is forced through the runner. Escape hatch:
#         `// history-rewrite-exempt: <reason>` on the same or preceding
#         line.
#      c. Every `_runHistoryRewrite` scope must contain BOTH pre-flight
#         gates: `_isRangeMergeFree(` (a plain rebase of a merge-bearing
#         range silently flattens topology — refused, IntelliJ
#         checkHeadLinearHistory) and `_isNotOnProtectedBranch(` (a commit
#         on an intellig.protectedBranches remote branch must not be
#         rewritten — refused, IntelliJ findProtectedRemoteBranch). With
#         check (b) forcing every flow through the runner, this closes the
#         gate-deletion drift: a refactor that drops either gate fails
#         here, not in review. Escape hatch:
#         `// runner-gate-exempt: <reason>` on the signature or preceding
#         line.
#    The guard runs in two modes: DEFAULT (no args) over the tracked tree;
#    EXPLICIT PATHS (companion spec) over the given dirs, where every file is
#    treated as non-allow-listed so fixtures exercise the teeth.
#
# 3. Known false-positive cases
#    A comment spelling out `abortRebase(`/`.executeRebase(` with the
#    parenthesis would match (none exist; comments reference the bare names).
#    Mark such a line with the corresponding exempt marker if it ever
#    appears. A method body containing a two-space-indented identifier line
#    would end the runner scope early — TS class bodies indent members at
#    two spaces and statements deeper, so this shape does not occur in
#    prettier-formatted sources.
#
# 4. Known false-negative cases
#    An abort/execute reached through an aliased service
#    (`const svc = this._rebaseService; svc.abortRebase(...)`) or a
#    dynamically-composed method name slips the literal patterns, as does a
#    raw `gitCli.exec(['rebase', '--abort'])` outside the allow-listed ops.
#    Review is the backstop; the runner remains the only sanctioned execute
#    site.
#
# 5. Retirement criteria
#    Retire if the rebase-editing flows move out of `src/commits/` into a
#    dedicated module whose only export is the runner (the type system then
#    makes the fifth skeleton unwritable), or if an eslint
#    no-restricted-syntax rule takes over both checks.

set -euo pipefail
cd "$(dirname "$0")/.."

# User-action surfaces + the ops/interfaces that DEFINE abort. Everything
# else in src/** needs a justification comment.
ALLOW_RE='^src/(conflicts/(ResolveConflictsDialog|ConflictResolutionService)\.ts|conflicts/interfaces/|git-core/(RebaseService|GitService)\.ts|git-core/ops/BranchOps\.ts|git-core/interfaces/|rebase/RebaseProgressView\.ts|commands/registration/|registration/wiring\.ts)'

if [ "$#" -eq 0 ]; then
  abort_files=$(git ls-files --cached --others --exclude-standard -- 'src/**/*.ts' \
    | grep -vE "$ALLOW_RE" || true)
  exec_files=$(git ls-files --cached --others --exclude-standard -- 'src/commits/*.ts')
else
  abort_files=$(find "$@" -name '*.ts' -type f 2>/dev/null || true)
  exec_files="$abort_files"
fi

fail=0

# ── a. No auto-abort re-entry (repo-scope) ──────────────────────────────────
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
      echo "_runHistoryRewrite, or justify with '// rebase-abort-exempt: <reason>'"
      echo "on the same or preceding line."
      echo
    fi
    echo "$abort_hits"
    fail=1
  fi
done

# ── b. No fifth skeleton: execute only inside the runner ────────────────────
for f in $exec_files; do
  exec_hits=$(awk '
    {
      if ($0 ~ /private async _runHistoryRewrite\(/) {
        inrunner = 1
      } else if (inrunner && $0 ~ /^  [A-Za-z_$]/) {
        inrunner = 0
      }
      if ($0 ~ /\.executeRebase\(/ && !inrunner \
          && $0 !~ /history-rewrite-exempt:/ && prev !~ /history-rewrite-exempt:/) {
        printf "%s:%d: %s\n", FILENAME, FNR, $0
      }
      prev = $0
    }
  ' "$f")
  if [ -n "$exec_hits" ]; then
    echo "check-rebase-conflict-flow: executeRebase( outside _runHistoryRewrite."
    echo "New history-rewrite flows ride the shared runner (one skeleton, N thin"
    echo "bodies — handbook rule 10); it owns the pre-flight, stale-plan, and"
    echo "pause-on-conflict invariants. Add a body that calls _runHistoryRewrite,"
    echo "or justify with '// history-rewrite-exempt: <reason>' on the same or"
    echo "preceding line."
    echo
    echo "$exec_hits"
    fail=1
  fi
done

# ── c. The runner keeps its pre-flight gates ────────────────────────────────
for f in $exec_files; do
  gate_hits=$(awk '
    {
      if ($0 ~ /private async _runHistoryRewrite\(/ \
          && $0 !~ /runner-gate-exempt:/ && prev !~ /runner-gate-exempt:/) {
        inrunner = 1; merge = 0; prot = 0; startline = FNR
      } else if (inrunner && $0 ~ /^  [A-Za-z_$]/) {
        inrunner = 0
        if (!merge || !prot) {
          printf "%s:%d: _runHistoryRewrite missing gate(s):%s%s\n", FILENAME, startline, \
            (merge ? "" : " _isRangeMergeFree("), (prot ? "" : " _isNotOnProtectedBranch(")
        }
      }
      if (inrunner) {
        if ($0 ~ /_isRangeMergeFree\(/) { merge = 1 }
        if ($0 ~ /_isNotOnProtectedBranch\(/) { prot = 1 }
      }
      prev = $0
    }
    END {
      if (inrunner && (!merge || !prot)) {
        printf "%s:%d: _runHistoryRewrite missing gate(s):%s%s\n", FILENAME, startline, \
          (merge ? "" : " _isRangeMergeFree("), (prot ? "" : " _isNotOnProtectedBranch(")
      }
    }
  ' "$f")
  if [ -n "$gate_hits" ]; then
    echo "check-rebase-conflict-flow: _runHistoryRewrite lost a pre-flight gate."
    echo "The runner owns the merge-flattening refusal (_isRangeMergeFree) and the"
    echo "protected-branch refusal (_isNotOnProtectedBranch) for every history-"
    echo "rewrite flow riding it. Restore the gate, or justify with"
    echo "'// runner-gate-exempt: <reason>' on the signature or preceding line."
    echo
    echo "$gate_hits"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-rebase-conflict-flow: OK"
