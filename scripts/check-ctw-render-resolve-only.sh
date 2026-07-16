#!/usr/bin/env bash
#
# Structural CI guard — the Commit Tool Window's full webview.html regen is
# resolve-only; every post-resolve refresh rides the typed updateModel push.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    A full `_render()` regen rebuilds the CTW document from scratch: file
#    checkboxes come back unchecked, composer focus/caret drop mid-typing,
#    panel scroll resets, and the diff preview wipes. Because the commit
#    payload reads checked boxes back from the DOM, a background regen that
#    lands while the user is composing silently un-selects their files. The
#    live-update seam (_pushLiveUpdate → updateModel) exists so no code path
#    ever repaints the document after resolve; a single new `_render()` call
#    site would silently reopen the whole input-stomping class.
#
# 2. Heuristic + how it scales
#    Fail on any `_render()` invocation in src/commits/CommitToolWindow.ts.
#    The resolve-time render is the base class's `_renderOnResolve` (not in
#    this file), so the expected call-site count here is ZERO. A line carrying
#    `render-exempt: <reason>` (justification required) is skipped — sanctioned
#    only for a future override of the resolve hook itself. The guard runs in
#    two modes: DEFAULT (no args) over the tracked file; EXPLICIT PATH
#    (companion spec) over a given file.
#
# 3. Known false-positive cases
#    None today: `_renderOnResolve()` / `_pushLiveUpdate()` don't match the
#    pattern, and the file defines no method named `_render`.

set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-src/commits/CommitToolWindow.ts}"

raw=$(grep -nE '\b_render\(\)' "$TARGET" 2>/dev/null || true)

if [ -n "$raw" ]; then
  matches=$(grep -vF 'render-exempt:' <<<"$raw" | grep -vF '_renderOnResolve' || true)
else
  matches=""
fi

if [ -n "$matches" ]; then
  echo "check-ctw-render-resolve-only: _render() call in $TARGET — the CTW's full"
  echo "document regen is resolve-only (the base class's _renderOnResolve). A post-"
  echo "resolve regen stomps composer text, checkbox selection, scroll, and the diff"
  echo "preview; route the refresh through _pushLiveUpdate() instead, or justify the"
  echo "line with 'render-exempt: <reason>'."
  echo
  echo "$matches"
  exit 1
fi

echo "check-ctw-render-resolve-only: OK"
