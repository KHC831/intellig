#!/usr/bin/env bash
#
# Structural CI guard — inline event-handler attributes in webview HTML.
#
# 1. Bug class
#    Every IntelliG webview ships a nonce-only Content-Security-Policy
#    (`script-src 'nonce-<…>'`, NO `'unsafe-inline'` / `'unsafe-hashes'`),
#    which BLOCKS inline event-handler attributes — `onclick="…"`,
#    `oninput="…"`, `onchange="…"`, etc. A control wired that way renders
#    fine but is DEAD: the handler never fires. This shipped silently in
#    CommitDialog (Commit/Cancel/gear/refresh), RebaseProgressView
#    (Abort/Skip/Continue), and RebaseEditor (action dropdown, reword
#    textarea, Start Rebase) — the user could click and nothing happened.
#    The CSP-safe pattern is `data-action` + a delegated `addEventListener`
#    click dispatcher (and `addEventListener('input'|'change', …)` by id for
#    inputs).
#
# 2. Heuristic
#    `find src -type f -name '*.ts'` + `grep -nE` for a whitespace-led DOM
#    event attribute immediately followed by a quote: `\son<event>=["']`.
#    - The leading whitespace requirement excludes the CSP-safe JS DOM
#      *property* form `el.onclick = fn` (the `on` there is preceded by `.`).
#    - The `=["']` requirement targets the HTML *attribute* form (the inline
#      handler) and skips `el.onclick = ...` (space after `=`).
#    Pure comment lines (`//`, `*`, `/* … */`) are filtered, so prose that
#    mentions an old `onclick="…"` pattern doesn't trip the guard.
#
# 3. Known gaps
#    - A handler attribute split across lines, or built by string concat,
#      evades the single-line literal match. Rare; code review covers it.
#    - The event-verb alternation is pinned to the verbs seen in-tree; add
#      to INLINE_EVENTS if a new one appears.
#
# 4. Retirement
#    Retire when an HTML-aware lint (or a typed webview-render helper that
#    can't express inline handlers) makes this grep redundant.
#
# Exit: 0 on clean, 1 if any src file uses an inline on<event>="…" attribute.

set -euo pipefail

# DOM event verbs that appear as inline handler attributes. Extend as needed.
INLINE_EVENTS='click|dblclick|input|change|submit|keydown|keyup|keypress|mousedown|mouseup|mouseover|mouseout|mouseenter|mouseleave|focus|blur|contextmenu'

matches=$(find src -type f -name '*.ts' -print0 \
  | xargs -0 grep -nE "[[:space:]]on(${INLINE_EVENTS})=[\"']" /dev/null 2>/dev/null || true)

violations=0
violation_lines=()

while IFS= read -r line; do
  if [ -z "$line" ]; then
    continue
  fi
  # Format: <file>:<lineno>:<content>
  rest="${line#*:}"
  content="${rest#*:}"

  # Trim leading whitespace so the comment classification sees the first token.
  trimmed="${content#"${content%%[![:space:]]*}"}"

  # Allow pure comment lines (line + JSDoc/block bodies): prose referencing
  # the old inline-handler pattern is not a violation.
  case "$trimmed" in
    //*|\**|/\**|\*/*)
      continue
      ;;
  esac

  violations=$((violations + 1))
  violation_lines+=("$line")
done <<<"$matches"

if [ "$violations" -gt 0 ]; then
  echo "no-inline-handlers structural guard FAILED — webview source uses inline on<event>=\"…\" attributes:" >&2
  for v in "${violation_lines[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "  IntelliG webviews use a nonce-only CSP (no 'unsafe-inline'), which" >&2
  echo "  BLOCKS inline event-handler attributes — the control would be dead." >&2
  echo "  Wire clicks via data-action + a delegated addEventListener('click')" >&2
  echo "  dispatcher, and inputs via addEventListener('input'|'change') by id." >&2
  echo "" >&2
  echo "See scripts/check-no-inline-handlers.sh header for full rationale." >&2
  exit 1
fi

echo "no-inline-handlers structural guard OK (no inline on<event>=\"…\" attributes in src)."
