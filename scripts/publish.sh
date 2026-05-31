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
# Pre-flight:
#   - Working tree must be clean (committed + pushed).
#   - npm test:unit and npm run lint must pass.
#   - The version being published must not already exist in either
#     gallery.
# ============================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

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

if [[ "$skip_ovsx" -eq 0 && -z "${OPEN_VSX_TOKEN:-}" ]]; then
  echo "✗ OPEN_VSX_TOKEN not set. Either export it, or pass --skip-ovsx." >&2
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

# ─── 3. Build ─────────────────────────────────────────────────

echo "→ cleaning out/ and building intellig-$version.vsix"
rm -f "$vsix"
rm -rf out
npx --yes tsc -p ./
npx --yes @vscode/vsce@2.24.0 package --out "$vsix"

# ─── 4. Refuse to upload a *-dogfood.vsix as a safety net ─────

bash scripts/check-publish-vsix.sh "$vsix"

# ─── 5. Inspect the manifest before pushing bytes ─────────────

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

# ─── 6. Publish ───────────────────────────────────────────────

if [[ "$skip_vsce" -eq 0 ]]; then
  echo
  echo "→ publishing to VS Code Marketplace"
  npx --yes @vscode/vsce@2.24.0 publish --packagePath "$vsix"
fi

if [[ "$skip_ovsx" -eq 0 ]]; then
  echo
  echo "→ publishing to Open VSX"
  npx --yes ovsx@latest publish "$vsix" -p "$OPEN_VSX_TOKEN"
fi

echo
echo "✓ published $version"
echo "  VS Code Marketplace:"
echo "    https://marketplace.visualstudio.com/items?itemName=KaHoChan.intellig"
echo "  Open VSX:"
echo "    https://open-vsx.org/extension/KaHoChan/intellig"
