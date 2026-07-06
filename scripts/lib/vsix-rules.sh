# ============================================================
# vsix-rules.sh — the single source of truth for what may and may
# NOT appear in the published .vsix. SOURCE this file; do not run it.
#
# Both consumers evaluate the SAME rules against a listing so they
# can never drift:
#   - check-vsix-clean.sh scans `vsce ls` output (the listing vsce
#     would package) as a pre-package structural guard.
#   - publish.sh scans `unzip -Z1` of the built artifact as a
#     post-build gate over the actual bytes about to be uploaded.
#
# The listing is checked in THREE directions:
#   1. DENY  — vsix_forbidden_violations: a hand-curated pattern net
#      for known-bad classes (test JS, source .ts, .map, node_modules/
#      out/ out-test/, .husky/, coordination notes, IDE configs …).
#      Second line of defence behind the allow-list.
#   2. ALLOW — vsix_allowlist_violations: every listed entry MUST fall
#      under an allowed prefix (dist/ media/ resources/) or be one of a
#      small exact root set (icon, docs, LICENSE, package.json). This
#      closes the leak class the deny-list alone could not: an internal
#      file with no matching forbidden pattern (e.g. .husky/** shipped
#      in 0.3.1) is caught because it matches nothing ALLOWED.
#   3. REQUIRE — vsix_missing_required: the runtime manifest (bundles,
#      webview assets, icons) must be present, or the package is
#      activation-dead / visually broken on install.
#
# Adding a rule is one line + a one-sentence rationale, per the
# ADR-007 guard-maintenance contract in check-vsix-clean.sh.
# ============================================================

# Patterns that MUST NOT appear in a listing. POSIX-extended regex;
# pipe-separated alternatives. `^\.husky/` and `^out-test/` are the
# leak classes proven live in 0.3.1 / missed by `^out/`.
VSIX_FORBIDDEN_PATTERNS='(\.test\.js$|^node_modules/|^out/|^out-test/|^test/|^workspace-notes/|^coverage/|^\.husky/|^CLAUDE\.md$|tsconfig\.test\.json|/\.agent/|^\.agent/|AGENT_WORKSPACE|^\.idea/|^\.kiro/|^\.vscode-test/|^docs/|^scripts/|^src/|tsconfig\.json|^\.eslintrc|^\.prettierrc|^\.prettierignore|^\.mocharc|^package-lock\.json$|^CONTRIBUTING\.md$|\.DS_Store|\.map$|\.ts$)'

# Allowed listing entries: known-good directory prefixes …
VSIX_ALLOWED_PREFIXES=(
  'dist/'
  'media/'
  'resources/'
)

# … plus the exact root files vsce always packages. `LICENSE.txt` is
# accepted alongside `LICENSE` because vsce lists whichever name is on
# disk.
VSIX_ALLOWED_EXACT=(
  'images/icon.png'
  'README.md'
  'CHANGELOG.md'
  'LICENSE'
  'LICENSE.txt'
  'SECURITY.md'
  'package.json'
)

# Runtime manifest — every entry MUST appear in the listing. Missing
# a bundle/asset = activation-dead (0.2.3 class); missing an icon =
# a visually-broken package that ships undetected.
VSIX_REQUIRED_FILES=(
  'dist/extension.js'
  'dist/rebaseTodoEditor.js'
  'media/mergeWindow.js'
  'media/codicon.ttf'
  'media/monaco/vs/loader.js'
  'resources/git-icon-branch.svg'
  'images/icon.png'
)

# Read a listing on stdin; print each line matching a forbidden
# pattern. Empty output = clean.
vsix_forbidden_violations() {
  grep -E "$VSIX_FORBIDDEN_PATTERNS" || true
}

# Read a listing on stdin; print each non-empty line that matches no
# allowed prefix and no allowed exact entry. Empty output = clean.
vsix_allowlist_violations() {
  local line prefix exact ok
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    ok=0
    for prefix in "${VSIX_ALLOWED_PREFIXES[@]}"; do
      case "$line" in "$prefix"*) ok=1; break ;; esac
    done
    if [ "$ok" -eq 0 ]; then
      for exact in "${VSIX_ALLOWED_EXACT[@]}"; do
        [ "$line" = "$exact" ] && { ok=1; break; }
      done
    fi
    [ "$ok" -eq 0 ] && printf '%s\n' "$line"
  done
  return 0
}

# Read `unzip -Z1 <vsix>` output on stdin; print the extension's
# content entries as repo-relative listing lines so they can feed the
# same forbidden/allow/require checks as a `vsce ls` listing. vsce
# packs extension content under an `extension/` prefix and adds two
# package-metadata files at the archive root (`extension.vsixmanifest`,
# `[Content_Types].xml`) that are not extension content; directory
# entries carry a trailing slash. Strip the prefix, drop the metadata
# files and directory entries.
vsix_normalize_zip_entries() {
  local line
  while IFS= read -r line; do
    case "$line" in
      extension.vsixmanifest | '[Content_Types].xml') continue ;;
      */) continue ;;
    esac
    case "$line" in
      extension/*) printf '%s\n' "${line#extension/}" ;;
    esac
  done
}

# Read a listing on stdin; print each required entry NOT present.
# Empty output = complete.
vsix_missing_required() {
  local listing required
  listing="$(cat)"
  for required in "${VSIX_REQUIRED_FILES[@]}"; do
    if ! printf '%s\n' "$listing" | grep -qx "$required"; then
      printf '%s\n' "$required"
    fi
  done
}
