#!/usr/bin/env bash
#
# Structural CI guard — one context-menu widget.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    The Commit tool window and the Git tool window each grew their own menu:
#    two sets of rows, two keyboard patterns, two dismiss paths, two
#    stylesheets. The Git tool window's ref popup and its parent-navigation
#    popup then hand-rolled the same rows a third and fourth time. Every fix to
#    menu behaviour had to be made in four places, and in practice was made in
#    one — only the Commit window's menu budgeted its height correctly, and
#    only the commit menu answered Escape.
#    The widget lives in src/webview-common/contextMenu.ts and renders from an
#    item list; callers declare rows, never markup.
#
# 2. Heuristic
#    Only the widget may BUILD a menu row. A row is built by giving an element
#    the `context-menu-item` class, and this codebase has SIX ways to do that:
#      className = '…'      classList.add('…')
#      className: '…'       (the el() helper's property bag)
#      class="…"            (markup)
#      setAttribute('class', '…')
#      class: '…'           (the setAttrs() property bag — ctwDom.ts, 30+
#                            sites in src, the REALISTIC one: commitToolWindow.ts
#                            already stamps attributes through it)
#    Reading the class back (querySelector, closest, classList.contains) is
#    fine: the enable map has to find the rows it gates, so the patterns below
#    are anchored to assignment, not to any mention of the name.
#    A SEPARATE pass catches the class string HOISTED into a local constant
#    and assigned by reference (`const ROW = 'context-menu-item'; …
#    el.className = ROW;`) — the literal never lands on the assignment's own
#    line, so the line-based patterns above cannot see it; this pass finds
#    every local the file assigns the row-class STRING to, then flags any
#    assignment-shaped use of that local's NAME.
#    A line with a reason to build a row itself may carry
#    `// context-menu-exempt: <reason>` on that line or the one above it. The
#    exemption is per LINE, never per file: a marker at the top of a file would
#    silently un-fence everything below it.
#
# 3. Known false-positive cases
#    - An assignment whose class literal sits on the line AFTER the operator is
#      caught by a second pass (prettier writes that shape at printWidth 100).
#      A literal spread over three or more lines is still invisible.
#    - A class assembled by concatenating fragments evades the literal match.
#    - The hoisted-constant pass tracks by NAME, file-wide, the same
#      known-gap the literal-pathspec guard's local-tracking has: a second
#      local of the same name holding an unrelated string could ride in on
#      the first one's alias — no known live instance of this shape in the
#      codebase today.
#    - Test files are out of scope: a spec may build fixture markup freely.
#
# 4. Retirement criteria
#    Retire if webview menus move to a platform primitive that removes the
#    hand-built rows entirely.
#
# 5. Anti-vacuity
#    The owner file must still contain the class name. Renaming the class would
#    otherwise leave this guard scanning for a string that no longer exists and
#    printing OK forever.
#
# Exit: 0 on clean, 1 if any src file outside the widget builds menu rows.

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

OWNER="$SCAN_ROOT/webview-common/contextMenu.ts"
ROW_CLASS='context-menu-item'

# Assignment forms only: `= '…'`, `: '…'`, `classList.add('…')`, `class="…"`,
# `setAttribute('class', …)`, and the setAttrs() bag's `class: '…'` key (a
# WORD-boundary `class:` — distinct from `className:`, which the first
# alternative already covers).
BUILD_PATTERN="(className[[:space:]]*[=:]|classList\.add\(|class=\"|class='|\.className[[:space:]]*\+=|setAttribute\(['\"]class['\"]|\bclass:[[:space:]]*['\"])[^;]*${ROW_CLASS}"

matches=$(find "$SCAN_ROOT" -type f -name '*.ts' -print0 \
  | xargs -0 grep -nE "$BUILD_PATTERN" /dev/null 2>/dev/null || true)

# Second pass for the shape prettier produces at printWidth 100: the assignment
# operator ends one line and the class literal opens the next. A line-based scan
# cannot see it, and it is the form a long class expression naturally takes.
wrapped=$(find "$SCAN_ROOT" -type f -name '*.ts' -print0 \
  | xargs -0 awk -v cls="$ROW_CLASS" '
      FNR == 1 { prev = ""; prevno = 0 }
      prev ~ /(className|class)[[:space:]]*[=:][[:space:]]*$/ && index($0, cls) > 0 {
        printf "%s:%d:%s%s\n", FILENAME, prevno, prev, $0
      }
      { prev = $0; prevno = FNR }
    ' 2>/dev/null || true)
if [ -n "$wrapped" ]; then
  matches=$(printf '%s\n%s' "$matches" "$wrapped")
fi

# Third pass: a local constant HOISTED to hold the row-class string, then
# assigned by reference (`const ROW = 'context-menu-item'; … el.className =
# ROW;`). The literal never lands on the assignment line, so passes 1-2 —
# which both require the literal substring on the matched line — cannot see
# it. Written to a temp file (rather than `node -e "..."`) so its own
# regex/backslash characters never have to survive bash double-quote
# interpolation.
ALIAS_CHECKER="$(mktemp -t check-context-menu-widget-alias.XXXXXX.js)"
trap 'rm -f "$ALIAS_CHECKER"' EXIT

cat > "$ALIAS_CHECKER" <<'NODE_EOF'
const fs = require('fs');
const path = require('path');

const scanRoot = process.argv[2];
const rowClass = process.argv[3];
const ownerPath = path.resolve(path.join(scanRoot, 'webview-common/contextMenu.ts'));

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
}
const files = [];
walk(scanRoot, files);

const declRe = new RegExp(
  '\\b(?:const|let)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*[\'"]' + rowClass + '[\'"]'
);
// Same assignment shapes as BUILD_PATTERN, minus the markup/setAttrs-bag
// forms a bare identifier can't fill: `className = X`, `className: X`,
// `classList.add(X)`, `setAttribute('class', X)`.
const useRe =
  /(className\s*[=:]|classList\.add\(|setAttribute\(['"]class['"]\s*,)\s*/;

for (const file of files) {
  if (path.resolve(file) === ownerPath) {
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');

  const aliasNames = new Set();
  for (const line of lines) {
    const m = declRe.exec(line);
    if (m) {
      aliasNames.add(m[1]);
    }
  }
  if (aliasNames.size === 0) {
    continue;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = useRe.exec(line);
    if (!m) {
      continue;
    }
    const rest = line.slice(m.index + m[0].length);
    const identMatch = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (identMatch && aliasNames.has(identMatch[1])) {
      console.log(file + ':' + (i + 1) + ':' + line.trim());
    }
  }
}
NODE_EOF

aliased="$(node "$ALIAS_CHECKER" "$SCAN_ROOT" "$ROW_CLASS" 2>/dev/null || true)"
if [ -n "$aliased" ]; then
  matches=$(printf '%s\n%s' "$matches" "$aliased")
fi

# Anti-vacuity: the class this guard is built around must still exist.
if ! grep -q "$ROW_CLASS" "$OWNER"; then
  echo "context-menu-widget structural guard FAILED — the guard no longer matches its own owner:" >&2
  echo "  $OWNER does not mention .${ROW_CLASS} at all." >&2
  echo "  The class was probably renamed. Update ROW_CLASS/BUILD_PATTERN here, or" >&2
  echo "  this guard silently stops fencing anything." >&2
  exit 1
fi

violations=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  file="${line%%:*}"
  [ "$file" = "$OWNER" ] && continue
  rest="${line#*:}"
  lineno="${rest%%:*}"
  is_exempt "$file" "$lineno" 'context-menu-exempt:' && continue
  violations+=("$line")
done <<<"$matches"

if [ "${#violations[@]}" -gt 0 ]; then
  echo "context-menu-widget structural guard FAILED — menu rows built outside the widget:" >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "  The context menu lives in $OWNER." >&2
  echo "  Declare rows as IContextMenuItem[] and hand them to ContextMenu.render()" >&2
  echo "  instead of building .${ROW_CLASS} elements or markup." >&2
  echo "" >&2
  echo "See scripts/check-context-menu-widget.sh header for full rationale." >&2
  exit 1
fi

echo "context-menu-widget structural guard OK (menu rows come from the shared widget)."
