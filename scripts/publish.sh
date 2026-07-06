#!/usr/bin/env bash
# ============================================================
# publish.sh — release flow for IntelliG.
#
# Builds the .vsix once and publishes it to BOTH the VS Code
# Marketplace and Open VSX. The same artifact lands in both
# galleries; users on VS Code, Kiro, Cursor, VSCodium and other
# Code-OSS forks all see the same version.
#
# Usage:
#   scripts/publish.sh                  # use current package.json version
#   scripts/publish.sh 0.1.2            # bump to that version, then publish
#   scripts/publish.sh patch            # npm-version style: bump patch, then publish
#   scripts/publish.sh minor            # bump minor
#   scripts/publish.sh major            # bump major
#   scripts/publish.sh --skip-ovsx      # publish only to Marketplace
#   scripts/publish.sh --skip-vsce      # publish only to Open VSX
#   scripts/publish.sh --dry-run        # build + inspect, no publish
#
# Required environment:
#   OPEN_VSX_TOKEN   — Open VSX personal access token. Generate at
#                      https://open-vsx.org/user-settings/tokens.
#                      Skipped when --skip-ovsx is passed.
#                      `vsce` reads its credentials from the cached
#                      login (~/.vsce/), so no env var needed for it.
#
# Pre-flight (this script enforces):
#   - Working tree must be clean, on main, in sync with origin.
#   - `npm run check:all` (structural guards, incl. the shared vsix
#     content rules) must pass before a byte is built.
#   - Guard-bypass env vars are unset, so a stale shell export cannot
#     silently disable the placeholder guard during a real release.
#   - The built artifact's actual contents are scanned (unzip -Z1)
#     against the same allow/deny/require rules as check-vsix-clean.
#   - The version being published must not already exist in either
#     gallery.
# ============================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Shared vsix content rules (allow/deny/require + zip normaliser),
# identical to the set check-vsix-clean.sh asserts pre-package, so the
# post-build artifact scan below cannot drift from the guard.
# shellcheck source=scripts/lib/vsix-rules.sh
source scripts/lib/vsix-rules.sh

# Sanitise guard-bypass env vars up front. A stale exported
# INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1 (or the dogfood triple) would
# silently disable the prepublish placeholder guard during a REAL
# release; the artifact carries no -dogfood suffix, so nothing
# downstream would catch it. Unset all four before any vsce runs.
# (check-vsix-clean re-sets the dryrun var in its own scoped
# subprocess, so the pre-flight guard below is unaffected.)
unset INTELLIG_INTERNAL_PREPUBLISH_DRYRUN
unset INTELLIG_ALLOW_PLACEHOLDERS
unset INTELLIG_DOGFOOD_BUILD
unset INTELLIG_DOGFOOD_INVOCATION

skip_vsce=0
skip_ovsx=0
dry_run=0
bump=""

for arg in "$@"; do
  case "$arg" in
    --skip-vsce) skip_vsce=1 ;;
    --skip-ovsx) skip_ovsx=1 ;;
    --dry-run) dry_run=1 ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    patch|minor|major|[0-9]*) bump="$arg" ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# ─── 1. Pre-flight checks ─────────────────────────────────────

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ working tree is dirty. Commit or stash before publishing." >&2
  git status --short >&2
  exit 1
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current_branch" != "main" ]]; then
  echo "✗ not on main (current: $current_branch). Refusing to publish." >&2
  exit 1
fi

git fetch origin main --quiet
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [[ "$local_sha" != "$remote_sha" ]]; then
  echo "✗ local main is not in sync with origin/main." >&2
  echo "    local:  $local_sha" >&2
  echo "    remote: $remote_sha" >&2
  echo "  Push or pull before publishing." >&2
  exit 1
fi

# Token presence is a publish-time concern, not a build-time one.
# Dry-runs (--dry-run) and explicit skips don't need the token, so
# only check when an actual publish to Open VSX would run.
if [[ "$dry_run" -eq 0 && "$skip_ovsx" -eq 0 && -z "${OPEN_VSX_TOKEN:-}" ]]; then
  echo "✗ OPEN_VSX_TOKEN not set. Either export it, pass --skip-ovsx," >&2
  echo "  or use --dry-run to build the .vsix without publishing." >&2
  echo "  Generate a token at https://open-vsx.org/user-settings/tokens" >&2
  exit 1
fi

# ─── 2. Optional version bump ─────────────────────────────────

if [[ -n "$bump" ]]; then
  echo "→ bumping version: $bump"
  npm version "$bump" --no-git-tag-version >/dev/null
  new_version="$(node -p 'require("./package.json").version')"
  echo "  new version: $new_version"
  echo
  echo "  package.json was updated. Commit + push it before re-running:"
  echo "    git add package.json"
  echo "    git commit -m \"chore: $new_version release\""
  echo "    git push origin main"
  echo "  Then run scripts/publish.sh (without an argument) to publish."
  exit 0
fi

version="$(node -p 'require("./package.json").version')"
vsix="intellig-$version.vsix"

# ─── 2b. Structural gate pre-flight ───────────────────────────
# Run the headless structural guards before building. This is the
# same check:all the merge gate runs; the vsix content rules it
# includes are the pre-package half of the belt-and-braces with the
# post-build artifact scan in step 5.

echo "→ running check:all pre-flight"
npm run check:all

# ─── 3. Build ─────────────────────────────────────────────────

echo "→ cleaning dist/ and building intellig-$version.vsix"
rm -f "$vsix"
# `rm -rf` occasionally fails with ENOTEMPTY on macOS even when the
# directory has no content the user is touching — likely a TS
# watcher / Spotlight indexer race. Retry once; if the second
# attempt still fails, abort with a clear error.
if ! rm -rf dist 2>/dev/null; then
  sleep 1
  rm -rf dist
fi
if [ -d dist ]; then
  echo "✗ failed to remove dist/ — close any process holding it open and retry." >&2
  exit 1
fi
# `vsce package` runs vscode:prepublish, which compiles (typecheck +
# dist bundle + webview + monaco assets) and minifies.
npx --yes @vscode/vsce@2.24.0 package --out "$vsix"

# ─── 4. Refuse to upload a *-dogfood.vsix as a safety net ─────

bash scripts/check-publish-vsix.sh "$vsix"

# ─── 5. Scan the ACTUAL artifact contents ─────────────────────
# The uploaded zip is the one artifact never content-checked before —
# the .husky leak rode through a green pre-package gate into the
# published 0.3.1. Scan the real bytes (unzip -Z1) against the SAME
# allow/deny/require rules check-vsix-clean uses, so a divergence
# between "what vsce ls said" and "what was actually packed" fails
# here before a byte is uploaded.

echo
echo "→ scanning built artifact contents"
zip_listing="$(unzip -Z1 "$vsix" | vsix_normalize_zip_entries)"

not_allowed="$(printf '%s\n' "$zip_listing" | vsix_allowlist_violations)"
forbidden="$(printf '%s\n' "$zip_listing" | vsix_forbidden_violations)"
missing="$(printf '%s\n' "$zip_listing" | vsix_missing_required)"

if [[ -n "$not_allowed" || -n "$forbidden" || -n "$missing" ]]; then
  echo "✗ built artifact failed the content scan — refusing to publish." >&2
  if [[ -n "$not_allowed" ]]; then
    echo "  files outside the allow-list:" >&2
    printf '%s\n' "$not_allowed" | sed 's/^/    - /' >&2
  fi
  if [[ -n "$forbidden" ]]; then
    echo "  forbidden files present:" >&2
    printf '%s\n' "$forbidden" | sed 's/^/    - /' >&2
  fi
  if [[ -n "$missing" ]]; then
    echo "  required runtime-manifest entries missing:" >&2
    printf '%s\n' "$missing" | sed 's/^/    - /' >&2
  fi
  exit 1
fi
echo "  ✓ artifact contents clean (allow-list + deny-list + manifest)."

# ─── 6. Inspect the manifest before pushing bytes ─────────────

echo
echo "→ artifact:"
ls -la "$vsix"
echo
echo "→ manifest spot-check:"
unzip -p "$vsix" extension.vsixmanifest \
  | grep -E "Identity|Description|GalleryFlags|Source|Support" \
  || true

if [[ "$dry_run" -eq 1 ]]; then
  echo
  echo "✓ dry-run complete. Built $vsix; nothing published."
  exit 0
fi

# ─── 7. Publish ───────────────────────────────────────────────

published_vsce=0
published_ovsx=0

if [[ "$skip_vsce" -eq 0 ]]; then
  echo
  if [[ -n "${VSCE_PAT:-}" ]]; then
    echo "→ publishing to VS Code Marketplace (using \$VSCE_PAT)"
    npx --yes @vscode/vsce@2.24.0 publish --packagePath "$vsix" --pat "$VSCE_PAT"
    published_vsce=1
  else
    # Try the cached `vsce login` credential. `vsce publish` exits
    # non-zero with a clear error if no credential is available, so
    # we run it through `if` rather than letting `set -e` kill the
    # whole script — a missing Marketplace credential is now a
    # skip-with-note, matching the GitHub Action's optional VSCE_PAT
    # behavior. Open VSX still proceeds.
    echo "→ publishing to VS Code Marketplace (using cached vsce login)"
    if npx --yes @vscode/vsce@2.24.0 publish --packagePath "$vsix"; then
      published_vsce=1
    else
      echo
      echo "ℹ Marketplace publish skipped — no VSCE_PAT in env, no cached"
      echo "  vsce login for KaHoChan, or vsce login expired."
      echo "  To publish to the Marketplace from this run, either:"
      echo "    - export VSCE_PAT=<your Azure DevOps PAT> and re-run, OR"
      echo "    - npx vsce login KaHoChan       (caches the PAT for future runs), OR"
      echo "    - upload $vsix manually at"
      echo "      https://marketplace.visualstudio.com/manage/publishers/KaHoChan"
    fi
  fi
fi

if [[ "$skip_ovsx" -eq 0 ]]; then
  echo
  echo "→ publishing to Open VSX"
  npx --yes ovsx@latest publish "$vsix" -p "$OPEN_VSX_TOKEN"
  published_ovsx=1
fi

echo
echo "✓ run complete for $version"
if [[ "$published_vsce" -eq 1 ]]; then
  echo "  VS Code Marketplace: published"
  echo "    https://marketplace.visualstudio.com/items?itemName=KaHoChan.intellig"
else
  echo "  VS Code Marketplace: not published this run"
fi
if [[ "$published_ovsx" -eq 1 ]]; then
  echo "  Open VSX: published"
  echo "    https://open-vsx.org/extension/KaHoChan/intellig"
else
  echo "  Open VSX: not published this run"
fi
echo "  Local artifact: $vsix"
