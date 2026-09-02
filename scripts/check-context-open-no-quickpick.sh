#!/usr/bin/env bash
#
# Structural CI guard — a right-click is answered by a menu, not a QuickPick.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    A webview posts `contextOpen` when the user right-clicks a row, and the
#    host answers with what the menu should contain. Answering with
#    `showQuickPick` looks like it works — the user right-clicks and a list of
#    the right actions appears — but VS Code draws a QuickPick as the
#    command-palette dropdown at the TOP-CENTRE of the window, nowhere near the
#    row, with the pointer position thrown away. Both tabs of the Commit tool
#    window shipped that way; the fix is to post the items to the webview,
#    which draws them under the pointer through the shared ContextMenu widget.
#
# 2. Heuristic
#    Any src file that handles `contextOpen` must not call `showQuickPick`.
#    The pairing is what makes this precise: `showQuickPick` is the right API
#    in plenty of other places (pick a branch, pick a commit), and a file that
#    never sees a right-click is out of scope.
#    "Handles" means comparing against or switching on the literal, in either
#    quote style: `=== 'contextOpen'`, `== "contextOpen"`, `case 'contextOpen':`.
#    Both handlers sit next to a `switch (action)` block, so folding the branch
#    into the switch is a natural cleanup — and it must not drop the file out of
#    this guard's scope.
#    Gated per `showQuickPick` CALL SITE, not per file: a `showQuickPick` used
#    for something unrelated to the right-click (picking a branch, picking a
#    commit) in a file that also happens to handle `contextOpen` elsewhere may
#    carry `// quickpick-exempt: <reason>` on that line or the one above. The
#    exemption is per LINE, never per file: a marker at the top of a file would
#    silently un-fence every `showQuickPick` call written below it.
#
# 3. Known false-positive cases
#    - A handler that splits `contextOpen` and the QuickPick call across two
#      files evades the match — including the shape most likely here, where the
#      answer goes through an injected `deps.showContextMenu`: swapping that
#      dependency for one that opens a QuickPick is invisible. Code review and
#      the webview-side tests cover that.
#    - A right-click routed through some name other than `contextOpen` is
#      invisible here; extend the pattern if one appears.
#
# 4. Retirement criteria
#    Retire if the context-menu reply moves behind a typed seam that cannot
#    express a QuickPick at all.
#
# 5. Anti-vacuity
#    At least MIN_HANDLERS files must be in scope. If a refactor renames the
#    message or restructures the dispatch, this guard would otherwise scan
#    nothing and print OK.
#
# Exit: 0 on clean, 1 if a contextOpen handler reaches for a QuickPick.

set -euo pipefail

# Resolve relative to this script's own location, not the caller's cwd — a
# worktree, a subdirectory, or a CI step with a different cwd must be able to
# invoke this by absolute path too.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/exempt-marker.sh
source "$SCRIPT_DIR/lib/exempt-marker.sh"

# Optional scan root so the companion spec can point the guard at a fixture
# tree. Defaults to the real source tree.
SCAN_ROOT="${1:-src}"

# Files that must be in scope for this guard to mean anything.
MIN_HANDLERS=2

# Comparing against, or switching on, the literal — either quote style.
HANDLES="(==[=]?[[:space:]]*['\"]contextOpen['\"]|case[[:space:]]+['\"]contextOpen['\"])"
MARKER='quickpick-exempt:'

violations=()
handlers=0

while IFS= read -r file; do
  [ -z "$file" ] && continue
  # Skip files that only NAME contextOpen in a type union or a comment. The
  # comment skip is by line prefix, which is all a grep-based guard can do:
  # a handler sharing a line with a trailing comment still counts, which is
  # the safe direction.
  grep -nE "$HANDLES" "$file" | grep -qvE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || continue
  handlers=$((handlers + 1))
  while IFS= read -r qpline; do
    [ -z "$qpline" ] && continue
    lineno="${qpline%%:*}"
    is_exempt "$file" "$lineno" "$MARKER" && continue
    violations+=("$file:$lineno")
  done < <(grep -nE 'showQuickPick' "$file" | grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' || true)
done < <(grep -rl "contextOpen" "$SCAN_ROOT" --include='*.ts' 2>/dev/null || true)

if [ "$handlers" -lt "$MIN_HANDLERS" ]; then
  echo "context-open structural guard FAILED — it is scanning almost nothing:" >&2
  echo "  found $handlers contextOpen handler(s) in src, expected at least $MIN_HANDLERS." >&2
  echo "  The dispatch was probably renamed or restructured. Update HANDLES /" >&2
  echo "  MIN_HANDLERS here, or this guard passes without checking anything." >&2
  exit 1
fi

if [ "${#violations[@]}" -gt 0 ]; then
  echo "context-open structural guard FAILED — a right-click answered with a QuickPick:" >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "  VS Code draws a QuickPick at the top of the window, not under the" >&2
  echo "  pointer. Post the items to the webview instead (showRowContextMenu)," >&2
  echo "  which renders them through src/webview-common/contextMenu.ts." >&2
  echo "  A showQuickPick call unrelated to the right-click may carry a" >&2
  echo "  '// ${MARKER} <reason>' comment." >&2
  echo "" >&2
  echo "See scripts/check-context-open-no-quickpick.sh header for full rationale." >&2
  exit 1
fi

echo "context-open structural guard OK (right-clicks are answered by the menu widget)."
