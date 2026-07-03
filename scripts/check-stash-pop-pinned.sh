#!/usr/bin/env bash
#
# Structural CI guard — stash pops must be PINNED to the entry they target,
# never a blind `stashPop(<repo>, 0)`.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    `stash@{0}` is not stable between a `stash push` and the later pop: an
#    autostash, a concurrent flow, or the user can push another entry in
#    between, renumbering the stack — and a blind head-pop then applies the
#    WRONG stash (silent data corruption of the working tree). The fix is
#    uniform: capture the created entry's sha right after the push, resolve
#    its CURRENT index from a fresh `stashList` at pop time, and warn
#    instead of popping when the sha has vanished (git4idea pins the stash
#    commit the same way). This class was fixed once in
#    BranchContextMenuCommands (_restoreStashAfterSwitch) and re-found later
#    in the apply-files-to-branch flow — this guard exists so the class
#    cannot silently reopen a third time.
#
# 2. Heuristic + how it scales
#    Fail on any `.stashPop(<ident>, 0)` call under git-tracked `src/`
#    (tests are out of scope — fixtures drive the pinned index through the
#    same helpers). A pinned pop passes a RESOLVED index variable, so the
#    literal-`0` second argument is the discriminator. A line carrying the
#    opt-out marker `pop-head-exempt:` (with a written justification) is
#    skipped — sanctioned only where the head is provably the entry just
#    created within the same lock/queue scope.
#
# 3. Known false-positive cases
#    A legitimate immediate push→pop pair with no interleaving await could
#    match; mark it `pop-head-exempt:` with the justification. None exist
#    today.

set -euo pipefail
cd "$(dirname "$0")/.."

matches=$(git grep -nE '\.stashPop\([A-Za-z_$][A-Za-z0-9_$]*, *0[,)]' -- 'src/**/*.ts' \
  | grep -v 'pop-head-exempt:' || true)

if [ -n "$matches" ]; then
  echo "check-stash-pop-pinned: blind stashPop(<repo>, 0) — the stack may have"
  echo "renumbered since the push. Capture the created entry's sha after the"
  echo "push and resolve its current index from stashList at pop time (see"
  echo "BranchContextMenuCommands._restoreStashAfterSwitch), or mark the line"
  echo "'pop-head-exempt: <reason>' if the head is provably the created entry."
  echo
  echo "$matches"
  exit 1
fi

echo "check-stash-pop-pinned: OK"
