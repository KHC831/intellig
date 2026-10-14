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
# One rule (4, below) reads FILE CONTENT rather than a listing, so
# only publish.sh can evaluate it: check-vsix-clean has a listing and
# no bytes, and it runs the prepublish chain with minification
# skipped, so the bundles it would read are not the ones that ship.
# The rule lives here anyway to keep every "what may ship" decision in
# one file.
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
#   4. UNLINKED — vsix_sourcemap_link_violations: no first-party bundle
#      may carry a sourceMappingURL comment (artifact-only; see above).
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
  'NOTICE'
  'THIRD_PARTY_NOTICES.md'
  'SECURITY.md'
  'package.json'
)

# Vendored third-party JS: shipped as prebuilt bytes, not built from
# src/. Monaco's AMD build links its own maps (loader.js, editor.main.js,
# the nls.messages.* bundles …); those comments are upstream's business
# and reveal no IntelliG source, so rule 4 exempts this tree. Everything
# else is treated as first-party and IS checked — a new bundle is covered
# the day it ships, without touching this file.
VSIX_VENDORED_JS_PREFIX='media/monaco/'

# Required manifest — every entry MUST appear in the listing. Missing
# a bundle/asset = activation-dead (0.2.3 class); missing an icon =
# a visually-broken package that ships undetected; missing a license or
# notice file = a package that breaks its Apache-2.0, MIT or CC-BY terms.
VSIX_REQUIRED_FILES=(
  'LICENSE'
  'NOTICE'
  'THIRD_PARTY_NOTICES.md'
  'media/monaco/LICENSE'
  'media/monaco/ThirdPartyNotices.txt'
  'dist/extension.js'
  'dist/rebaseTodoEditor.js'
  'media/mergeWindow.js'
  'media/webview/shelveDialog.js'
  'media/webview/newBranchDialog.js'
  'media/webview/mergeDialog.js'
  'media/webview/commitMessageDialog.js'
  'media/webview/resetDialog.js'
  'media/webview/rebaseDialog.js'
  'media/webview/applyPatchDialog.js'
  'media/webview/resolveConflictsDialog.js'
  'media/webview/pushDialog.js'
  'media/webview/defineRemoteDialog.js'
  'media/webview/rebaseProgressView.js'
  'media/webview/rebaseEditor.js'
  'media/webview/commitDialog.js'
  'media/webview/commitToolWindow.js'
  'media/webview/gitToolWindow.js'
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

# Take a built .vsix path as $1; print each first-party bundle whose
# bytes carry a sourceMappingURL comment. Empty output = clean.
#
# The publish build emits maps with `--sourcemap=external` (map file, no
# link comment), so a hit here means the minify path lost that flag and
# the shipped bundle now advertises `<bundle>.js.map` — a file the
# deny-list keeps out of the package, leaving a comment that resolves to
# nothing. The map itself is the real prize (esbuild embeds
# `sourcesContent`, i.e. every src/*.ts file verbatim), so this rule is
# the second lock behind `\.map$`: the map must not ship AND nothing that
# ships may point at one.
vsix_sourcemap_link_violations() {
  local vsix="$1" rel
  unzip -Z1 "$vsix" | vsix_normalize_zip_entries | while IFS= read -r rel; do
    case "$rel" in
      "$VSIX_VENDORED_JS_PREFIX"*) continue ;;
      *.js) ;;
      *) continue ;;
    esac
    if unzip -p "$vsix" "extension/$rel" 2>/dev/null | grep -q 'sourceMappingURL'; then
      printf '%s\n' "$rel"
    fi
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
