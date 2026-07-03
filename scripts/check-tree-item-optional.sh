#!/usr/bin/env bash
# Structural CI guard — tree-item command params must admit `undefined`.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    A `view/item/context` command receives NO argument when the tree
#    refreshes under the click, and `executeCommand(id)` bare is always
#    possible — so a handler typed `(item: BranchTreeItem)` compiles while
#    crashing at runtime on `item.branch` ("Cannot read properties of
#    undefined"). Reproduced live: checkout-as-local refreshed the branch
#    tree and the following "Rebase Current onto This" click crashed.
#    Typing the param `BranchTreeItem | undefined` (or `item?:`) makes the
#    compiler force a guard at every access — the class becomes unwritable.
#
# 2. Heuristic + how it scales
#    Ban the literal non-optional form `(item: BranchTreeItem)` anywhere in
#    src/. New tree-item argument types can be added to the pattern below.
#    Escape hatch: a `// item-required-exempt: <reason>` comment on the
#    line above a match (for a call path that provably always passes one).
#
# 3. Known false-positive cases
#    None today — every command/handler taking a clicked tree item must
#    tolerate its absence.

set -euo pipefail
cd "$(dirname "$0")/.."

# `|| true`: git grep exits 1 on zero matches, which is the PASSING case.
violations=$( (git grep -n '(item: BranchTreeItem)' -- 'src/**/*.ts' || true) | while IFS=: read -r file line _rest; do
  prev=$((line - 1))
  if ! sed -n "${prev}p" "$file" | grep -q 'item-required-exempt:'; then
    echo "  $file:$line"
  fi
done)

if [ -n "$violations" ]; then
  echo 'check-tree-item-optional: non-optional tree-item command params found.'
  echo 'Type the param `item: BranchTreeItem | undefined` (or `item?:`) and guard'
  echo 'the access — VS Code invokes context commands with NO argument when the'
  echo 'tree refreshes under the click. Justified exceptions carry a'
  echo '`// item-required-exempt: <reason>` comment on the line above.'
  echo "$violations"
  exit 1
fi
echo 'check-tree-item-optional: OK'
