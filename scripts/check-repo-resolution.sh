#!/usr/bin/env bash
#
# Structural CI guard — commands resolve their repository through
# resolveRepo, never a blind `getRepositories()[0]`.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    `getRepositories()[0]` silently targets an ARBITRARY repository in a
#    multi-root workspace — the user acts on repo B while the command
#    mutates repo A (the stash rename/branch-from-stash pickers shipped
#    exactly this). The shared resolver `resolveRepo`
#    (src/utils/resolveRepo.ts) owns the ordered fallback chain (explicit
#    hint -> defaultRepo config -> active editor -> single repo -> QuickPick
#    -> error toast) and every command handler must route through it. This
#    class was fixed once module-wide when resolveRepo was introduced and
#    re-found later in stashShelfCommands — this guard pins it shut.
#
# 2. Heuristic + how it scales
#    Fail on any `getRepositories()[0]` under git-tracked `src/`, skipping
#    comment lines (prose references to the anti-pattern are fine — the
#    resolver's own doc cites it). The single sanctioned in-code shape is
#    resolveRepo's own `.length === 1` fast path, which indexes a local
#    `repositories` array, not the raw service call, so it never matches.
#    A justified exception marks the line `single-repo-exempt: <reason>`.
#
# 3. Known false-positive cases
#    Comment-line mentions are excluded by the leading `//` / `*` filter.
#    None in code today.

set -euo pipefail
cd "$(dirname "$0")/.."

matches=$(git grep --untracked -nE 'getRepositories\(\)\[0\]' -- 'src/**/*.ts' \
  | grep -vE ':[0-9]+: *(\*|//)' \
  | grep -v 'single-repo-exempt:' || true)

if [ -n "$matches" ]; then
  echo "check-repo-resolution: blind getRepositories()[0] targets an arbitrary"
  echo "repo in a multi-root workspace. Route through resolveRepo"
  echo "(src/utils/resolveRepo.ts) — hint/config/active-editor/picker chain —"
  echo "or mark the line 'single-repo-exempt: <reason>'."
  echo
  echo "$matches"
  exit 1
fi

echo "check-repo-resolution: OK"
