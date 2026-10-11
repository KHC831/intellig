#!/usr/bin/env bash
#
# Structural CI guard — graph-window map KEYS are row keys, not commit hashes.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    The log state's `branchMap` / `tagMap` are keyed by graphRowKey(hash,
#    root) — `hash\0root` in the merged all-roots log, a bare hash only in
#    single-repo loads. A consumer that iterates the KEYS and hands one to a
#    hash-consuming seam (selectCommit, scrollToCommit, the BFS) matches no
#    commit node and no webview row, so the action dies silently — exactly the
#    "BRANCHES click does nothing in a multi-root workspace" bug. Keys must be
#    decomposed through `graphRowKeyParts` (src/git-core/graphRowKey.ts)
#    before use as a commit identity.
#
# 2. Heuristic + how it scales
#    Fail on any `.branchMap.entries(` / `.branchMap.keys(` / `.tagMap.entries(`
#    / `.tagMap.keys(` under `src` whose FILE never references
#    `graphRowKeyParts`, unless the line carries `row-key-exempt: <reason>`
#    (sanctioned where keys are treated as opaque tokens — e.g. the log-state
#    fingerprint, which only needs stable identity, never a hash). Two modes:
#      * DEFAULT (no args — the gate): `git grep --untracked` over tracked
#        AND new-but-uncommitted `src`.
#      * EXPLICIT PATHS (companion spec): recursive `grep` over given dirs.
#    Residual: a file can import `graphRowKeyParts` for one site and still
#    mishandle another; the unit pins in branchClickMergedRoots.test.ts hold
#    the behavioral line for the known consumers.
#
# 3. Known false-positive cases
#    A new opaque-key consumer (serialization, diffing, counting) trips the
#    gate until the author adds the exempt marker with a reason — the intended
#    review touchpoint, not a defect.
#
# 4. Retirement criteria
#    Retire when the map key becomes a branded type (GraphRowKey) that cannot
#    be passed where a commit hash is expected, making the confusion
#    unrepresentable at compile time.
#
# Exit: 0 on clean, 1 if any unmarked key iteration lacks the decomposition.
#
# Manual repro of the red:
#   printf 'for (const [h] of s.branchMap.entries()) { pick(h); }\n' > /tmp/x.ts
#   bash scripts/check-graph-row-key-parts.sh /tmp   # exits 1

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=scripts/lib/exempt-marker.sh
source scripts/lib/exempt-marker.sh
# shellcheck source=scripts/lib/grep-hit.sh
source scripts/lib/grep-hit.sh

PATTERN='\.(branchMap|tagMap)\.(entries|keys)\('
MARKER='row-key-exempt:'

if [ "$#" -eq 0 ]; then
  raw=$(git grep --untracked -nIE "$PATTERN" -- 'src/*.ts' 'src/**/*.ts' 2>/dev/null || true)
else
  raw=$(grep -rnIE --include='*.ts' "$PATTERN" "$@" 2>/dev/null || true)
fi

hits=""
if [ -n "$raw" ]; then
  while IFS= read -r line; do
    split_grep_hit "$line"
    file=$HIT_FILE lineno=$HIT_LINE
    is_exempt "$file" "$lineno" "$MARKER" && continue
    # File decomposes keys through the shared helper.
    if grep -qF 'graphRowKeyParts' "$file" 2>/dev/null; then
      continue
    fi
    hits="${hits}${line}"$'\n'
  done <<<"$raw"
fi

if [ -n "$hits" ]; then
  echo "check-graph-row-key-parts: branchMap/tagMap KEYS are graph row keys" >&2
  echo "  (hash\\0root in the merged multi-root log), not commit hashes. Decompose" >&2
  echo "  them with graphRowKeyParts() from src/git-core/graphRowKey.ts before use" >&2
  echo "  as a commit identity. If the keys are treated as opaque tokens, add" >&2
  echo "  '// ${MARKER} <why>' on (or directly above) the line. Offending lines:" >&2
  printf '%s' "$hits" >&2
  exit 1
fi

echo "check-graph-row-key-parts: OK (row-key iteration decomposes or is exempt)."
