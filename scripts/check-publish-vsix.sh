#!/usr/bin/env bash
# ============================================================
# check-publish-vsix.sh — refuses to upload a `*-dogfood.vsix`
# file. Filename-based safety net (TL-95).
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    A maintainer accidentally uploads a dogfood-built .vsix
#    (produced via `npm run package:dogfood`, with the placeholder
#    bypass active) to the VS Code Marketplace. Today the dogfood
#    triple-env-gate
#    (INTELLIG_ALLOW_PLACEHOLDERS + INTELLIG_DOGFOOD_BUILD +
#     INTELLIG_DOGFOOD_INVOCATION) protects PACKAGING, but the
#    OUTPUT artifact is unmarked: `intellig-0.1.0.vsix` is the same
#    filename whether produced by `vsce package` (real, guard
#    asserted clean) or `npm run package:dogfood` (bypass active).
#    A user could mistakenly upload either. The fix: `package:dogfood`
#    writes `intellig-<version>-dogfood.vsix`, and this guard
#    refuses to publish anything whose basename matches
#    `*-dogfood.vsix`.
#
# 2. Heuristic + how it scales
#    For each argument, take the basename and case-insensitively
#    match the suffix `-dogfood.vsix`. A match is FAIL with a clear
#    error pointing at the real `vsce package` path. No-arg
#    invocation is a no-op (exit 0) — the script is wired into the
#    publish flow as a safety net, not a required step. Non-existent
#    files are ALSO no-op exit 0: this guard only validates
#    filenames, not file existence (the real publisher / `vsce
#    publish` checks existence). Scales O(args); always small.
#
# 3. Known false-positive cases
#    - A legitimately-named `something-dogfood.vsix` (e.g. an
#      extension whose actual name is `something-dogfood`) would be
#      flagged. We don't ship under that name and don't expect to;
#      if a future ext name collides, the guard pattern can be
#      tightened to `*-dogfood.vsix` AND publisher prefix check.
#
# 4. Known false-negative cases
#    - A maintainer who renames the dogfood vsix back to
#      `intellig-0.1.0.vsix` before uploading defeats the filename
#      check. Mitigation: the noisy "BYPASSED" line in vsce stdout
#      from the prepublish-guard is the primary defence; this
#      filename check is a SECOND line of defence specifically
#      against the "forgot which terminal I built in" mistake.
#    - Actual upload still happens via `vsce publish`, which this
#      guard cannot intercept. The check is run as part of the
#      publish-flow npm script, not a vsce hook. A human who runs
#      `vsce publish` directly and bypasses the npm script bypasses
#      this guard. Documented in docs/RELEASING.md.
#
# 5. Retirement criteria
#    Retire when the Marketplace gains attestation / signed
#    artifacts that bind the .vsix to the real (non-bypassed)
#    build, OR when dogfood and real builds use disjoint
#    publishers. Until then, filename-based filtering is the
#    cheapest safety net we have.
# ============================================================

set -euo pipefail

# No-op if no args. Wired into the publish flow as a safety net.
if [ "$#" -eq 0 ]; then
  echo "[check:publish-vsix] OK — no vsix paths supplied; nothing to validate."
  exit 0
fi

violations=()

# Case-insensitive suffix match for the loop body. macOS bash 3.2 and
# Linux bash 4+ both honour `nocasematch`. (R1 senior-L1 — moved out
# of the loop so we don't toggle the shopt on every iteration; it
# makes no functional difference but is fractionally faster and
# easier to read.)
shopt -s nocasematch
for arg in "$@"; do
  # basename strips path components so the check works on relative
  # or absolute paths consistently.
  base="$(basename -- "$arg")"
  if [[ "$base" == *-dogfood.vsix ]]; then
    violations+=("$arg")
  fi
done
shopt -u nocasematch

if [ "${#violations[@]}" -gt 0 ]; then
  echo "[check:publish-vsix] FAIL: refusing to publish dogfood-tagged vsix:"
  for v in "${violations[@]}"; do
    echo "  - $v"
  done
  echo ""
  echo "[check:publish-vsix] These artifacts were produced by"
  echo "  \`npm run package:dogfood\`, which engages the placeholder bypass"
  echo "  and is for LOCAL DOGFOOD ONLY. Build a real .vsix via"
  echo "  \`npx --yes @vscode/vsce@2.24.0 package\` (no env vars set)"
  echo "  before publishing. See docs/RELEASING.md section 'Publishing to the"
  echo "  Marketplace' for the full flow."
  exit 1
fi

echo "[check:publish-vsix] OK — none of the $# supplied path(s) match *-dogfood.vsix."
