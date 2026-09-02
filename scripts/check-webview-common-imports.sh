#!/usr/bin/env bash
#
# Structural CI guard — DOM-only shared modules stay out of host code.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    src/webview-common/ holds two kinds of module. contextMenu.ts and
#    placeNearPointer.ts are webview code: they carry
#    `/// <reference lib="dom" />` and reach for `document` and `window` as
#    soon as anything in them is CALLED. contextMenuItem.ts and
#    contextMenuStyles.ts are plain types and a plain string, and host modules
#    legitimately import them (stylesBuilder.ts, commitToolWindowStyles.ts,
#    commitToolWindow.types.ts). Nothing about the directory name says which is
#    which. A host module importing the DOM half TYPECHECKS — the reference
#    directive pulls the DOM lib into that compilation unit, so `document`
#    resolves for every file it reaches — and then dies with "document is not
#    defined" the first time the extension host runs the code, which surfaces
#    as a broken command rather than a compile error. Importing alone does not
#    throw: the module body is declarations only, so nothing fails until a
#    call, which is what makes this worth fencing rather than catching in a
#    smoke test.
#
# 2. Heuristic
#    Only webview code may import the DOM-only modules. Webview code is a file
#    under a `webview/` directory, or webview-common itself. Everything else in
#    src is host code, including a module sitting directly beside a `webview/`
#    directory: conflicts/merge-window/ holds the host MergeWindowPanel.ts next
#    to the client under merge-window/webview/. Exemptions are matched on the
#    path RELATIVE to the scan root, so they hold under a fixture tree too.
#
# 3. Known false-positive cases
#    - A dynamic `await import()` built from a variable evades the match.
#    - A host module importing the DOM half INDIRECTLY, through a webview
#      module that re-exports it, is invisible here. Code review covers it.
#
# 4. Retirement criteria
#    Retire if the build gains separate tsconfig programs for host and webview
#    source, which would turn this into a compile error.
#
# 5. Anti-vacuity
#    Every module named in DOM_ONLY must exist, and each must actually be
#    imported somewhere — otherwise a rename leaves this guard scanning for a
#    path nothing references and passing forever. DOM_ONLY is resolved
#    against SCAN_ROOT (never a hard-coded `src/` prefix), so the companion
#    spec's fixture tree stands in for the real one completely: a fixture
#    that omits an owner file exercises this arm for real instead of always
#    stat-ing the actual source tree underneath it.
#
# Exit: 0 on clean, 1 if host code imports a DOM-only shared module.

set -euo pipefail

# Optional scan root so the companion spec can point the guard at a fixture
# tree. Defaults to the real source tree.
SCAN_ROOT="${1:-src}"

DOM_ONLY=("$SCAN_ROOT/webview-common/contextMenu.ts" "$SCAN_ROOT/webview-common/placeNearPointer.ts")

violations=()

for owner in "${DOM_ONLY[@]}"; do
  if [ ! -f "$owner" ]; then
    echo "webview-common-imports structural guard FAILED — a module it fences is gone:" >&2
    echo "  $owner does not exist. Update DOM_ONLY, or this guard fences nothing." >&2
    exit 1
  fi
  base=$(basename "$owner" .ts)
  # Matches both the cross-directory form (…/webview-common/<base>) and the
  # sibling form (./<base>) the widget itself uses.
  # Both quote styles and an optional .js specifier: prettier writes single
  # quotes, but the gate runs eslint alone, so a double-quoted import reaches
  # main whenever the pre-commit hook is bypassed.
  importers=$(grep -rlE "from ['\"](\./|[^'\"]*/)${base}(\.js)?['\"]" "$SCAN_ROOT" --include='*.ts' 2>/dev/null || true)
  if [ -z "$importers" ]; then
    echo "webview-common-imports structural guard FAILED — nothing imports $base:" >&2
    echo "  it was probably renamed or inlined. Update DOM_ONLY here." >&2
    exit 1
  fi
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    # Match on the path RELATIVE to the scan root, so the exemptions mean the
    # same thing whether the guard runs over src or over a fixture tree. An
    # absolute-path pattern silently stops matching under any other root, which
    # leaves the exemptions untestable and lets a hole in one go unnoticed.
    rel="${file#"$SCAN_ROOT"/}"
    case "$rel" in
      webview/*|*/webview/*|webview-common/*) continue ;;
    esac
    violations+=("$file -> $base")
  done <<<"$importers"
done

if [ "${#violations[@]}" -gt 0 ]; then
  echo "webview-common-imports structural guard FAILED — host code imports a DOM-only module:" >&2
  for v in "${violations[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "  contextMenu.ts and placeNearPointer.ts run in a webview and touch" >&2
  echo "  document. A host module importing them typechecks and then fails at" >&2
  echo "  activation with 'document is not defined'." >&2
  echo "  Host code may import webview-common/contextMenuItem (types) and" >&2
  echo "  webview-common/contextMenuStyles (a string) only." >&2
  echo "" >&2
  echo "See scripts/check-webview-common-imports.sh header for full rationale." >&2
  exit 1
fi

echo "webview-common-imports structural guard OK (DOM-only modules stay in webview code)."
