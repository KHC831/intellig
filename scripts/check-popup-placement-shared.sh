#!/usr/bin/env bash
#
# Structural CI guard — one pointer-placement rule for webview popups.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Four popups each grew their own copy of "clamp a box to the viewport near
#    the pointer": the Commit window's context menu, the Git tool window's
#    three context menus, its ref popup, and its parent-navigation popup. The
#    copies drifted — different assumed heights, different edge gaps (8 vs 10),
#    and three different answers at a window edge. Two of them set no height
#    budget at all, so a popup taller than its assumed height ran off the
#    bottom of the window with no way to scroll to the rest. Fixing the
#    placement bug in one copy left the other three wrong.
#    The single rule now lives in src/webview-common/placeNearPointer.ts.
#
# 2. Heuristic
#    Any src file that reads BOTH innerWidth and innerHeight is doing viewport
#    arithmetic. Only placeNearPointer.ts may do that; anything else must call
#    it. The receiver is deliberately NOT pinned to `window.`: the owner reads
#    them off `node.ownerDocument.defaultView`, so a `window.`-only match
#    would miss that form — and would make the owner exclusion dead code.
#    A line that legitimately needs the viewport for something other than
#    placement may carry `// placement-exempt: <reason>` on that line or the
#    one above it. The exemption is per LINE, never per file: a marker at the
#    top of a file would silently un-fence everything below it.
#
# 3. Known false-positive cases
#    - A copy that reads only one dimension, or reaches the viewport through
#      document.documentElement.clientWidth / getBoundingClientRect on the
#      root, evades the match. Code review covers those.
#    - Test files are out of scope: a test may fake a viewport freely.
#
# 4. Retirement criteria
#    Retire if webview popups move to a layout primitive (CSS anchor
#    positioning) that removes the arithmetic entirely.
#
# 5. Anti-vacuity
#    The owner must match the guard's own pattern. Otherwise a refactor of how
#    the viewport is read leaves this scanning for a form nothing uses.
#
# Exit: 0 on clean, 1 if any src file outside the shared module clamps to the
# viewport itself.

set -euo pipefail

# Resolve relative to this script's own location, not the caller's cwd — a
# worktree, a subdirectory, or a CI step with a different cwd must be able to
# invoke this by absolute path too.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/exempt-marker.sh
source "$SCRIPT_DIR/lib/exempt-marker.sh"
# shellcheck source=scripts/lib/grep-hit.sh
source "$SCRIPT_DIR/lib/grep-hit.sh"

# Optional scan root so the companion spec can point the guard at a fixture
# tree. Defaults to the real source tree.
SCAN_ROOT="${1:-src}"

OWNER="$SCAN_ROOT/webview-common/placeNearPointer.ts"

# Any receiver: window.innerWidth, view.innerWidth, defaultView.innerWidth.
WIDTH='\.innerWidth'
HEIGHT='\.innerHeight'

# Anti-vacuity: the owner must read the viewport the way this guard looks for.
if ! grep -qE "$WIDTH" "$OWNER" || ! grep -qE "$HEIGHT" "$OWNER"; then
  echo "popup-placement structural guard FAILED — the guard no longer matches its own owner:" >&2
  echo "  $OWNER does not read .innerWidth/.innerHeight." >&2
  echo "  How the viewport is read must have changed. Update WIDTH/HEIGHT here," >&2
  echo "  or this guard scans for a form nothing uses and passes forever." >&2
  exit 1
fi

violations=()

# Per-LINE exemption, never per file: a marker at the top of a file would
# silently un-fence every clamp written below it.
while IFS= read -r line; do
  [ -z "$line" ] && continue
  split_grep_hit "$line"
  file=$HIT_FILE lineno=$HIT_LINE
  [ "$file" = "$OWNER" ] && continue
  grep -qE "$HEIGHT" "$file" || continue
  is_exempt "$file" "$lineno" 'placement-exempt:' && continue
  violations+=("$file:$lineno")
done < <(grep -rnE "$WIDTH" "$SCAN_ROOT" --include='*.ts' 2>/dev/null || true)

if [ "${#violations[@]}" -gt 0 ]; then
  echo "popup-placement structural guard FAILED — viewport clamping outside the shared rule:" >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "  Pointer placement lives in $OWNER." >&2
  echo "  Call placeNearPointer(node, x, y, expectedHeight) instead of" >&2
  echo "  re-deriving left/top/maxHeight from window.innerWidth/innerHeight." >&2
  echo "  A line that needs the viewport for something else may carry a" >&2
  echo "  '// placement-exempt: <reason>' comment." >&2
  echo "" >&2
  echo "See scripts/check-popup-placement-shared.sh header for full rationale." >&2
  exit 1
fi

echo "popup-placement structural guard OK (one pointer-placement rule in src)."
