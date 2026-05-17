#!/usr/bin/env bash
# ============================================================
# check-vsix-clean.sh — asserts `vsce ls` would not include any
# forbidden file in the published .vsix.
#
# Maintenance contract (per ADR-007 §"Guard maintenance contract"):
#
# 1. Bug class
#    `.vscodeignore` regression silently shipping internal files
#    (.agent/ coordination notes, AGENT_WORKSPACE.md, IDE configs,
#    test JS, source `.ts`, .map files, dev scripts) into the
#    Marketplace .vsix. The original Wave 135 R0 .vscodeignore had a
#    `!out/**/*.js` re-include that overrode `out/test/**`, leaking
#    365 files / 1.54 MB before being noticed. Drift class is real
#    and recurring.
#
# 2. Heuristic + how it scales
#    Run `vsce ls` (the same listing logic vsce uses for `vsce
#    package`) and grep for a hand-curated list of forbidden POSIX
#    extended-regex patterns covering: test JS, .map files, source
#    `.ts`, `.agent/`, `AGENT_WORKSPACE`, `.idea/`, `.kiro/`,
#    `.vscode-test/`, `docs/`, `scripts/`, `src/`, `tsconfig.json`,
#    `eslintrc`/`prettierrc`/`mocharc`, `package-lock.json`,
#    `CONTRIBUTING.md`, `.DS_Store`. Each pattern targets a known
#    bug class. Adding a new pattern is one line in
#    FORBIDDEN_PATTERNS plus a one-sentence rationale. Scales
#    linearly with bundle size; current tree is ~107 files / <100ms.
#
# 3. Known false-positive cases
#    None today. Patterns are anchored or distinctive enough that
#    legitimate bundle contents never match. If a future legitimate
#    file collides (e.g. ships a `docs/` markdown intentionally),
#    suppress by anchoring the pattern more tightly (e.g. `^docs/`
#    is safe; `docs/` would catch anything containing the word).
#
# 4. Known false-negative cases
#    - vsce version drift: the @vscode/vsce package's `vsce ls`
#      output format could change between versions and silently
#      mask regressions. Mitigated by pinning to a specific vsce
#      version below (M3 fix); update + re-test when bumping.
#    - New "forbidden" file class not in FORBIDDEN_PATTERNS:
#      e.g. `.idea/sonar.config` ships fine if `.idea/` was missed
#      from .vscodeignore (it isn't — but the bug class would
#      bypass this guard until added).
#    - Bundling tools: if a future webpack/esbuild step inlines
#      everything into `out/extension.js`, the original test files
#      no longer exist in `out/` and the guard becomes
#      tautologically GREEN; that's actually fine — it means the
#      bug class is unreachable.
#
# 5. Retirement criteria
#    Retire when ALL of: (a) extension is bundled (webpack/esbuild)
#    so the forbidden-pattern set is unreachable by construction,
#    OR (b) vsce gains a "deny by default" mode upstream, OR (c) a
#    safer ignore-file format (e.g. JSON Schema-validated) makes
#    re-include regressions architecturally impossible. Replace
#    with the bundler's manifest verification.
# ============================================================

set -euo pipefail

cd "$(dirname "$0")/.."

# Pin vsce version (M3 fix) for reproducible `vsce ls` output. Bump
# when adopting a new vsce minor; re-run RED inversion test after.
VSCE_VERSION="2.24.0"

# Patterns that MUST NOT appear in `vsce ls` output. POSIX-extended
# regex; pipe-separated alternatives.
FORBIDDEN_PATTERNS='(\.test\.js$|^out/test/|/\.agent/|^\.agent/|AGENT_WORKSPACE|^\.idea/|^\.kiro/|^\.vscode-test/|^docs/|^scripts/|^src/|tsconfig\.json|^\.eslintrc|^\.prettierrc|^\.prettierignore|^\.mocharc|^package-lock\.json$|^CONTRIBUTING\.md$|\.DS_Store|\.map$|\.ts$)'

# Capture stderr to a temp file so we can surface vsce errors on
# FAIL (M4 fix). Old behavior swallowed real errors as
# "Did compile fail?".
STDERR_LOG="$(mktemp -t check-vsix-clean.XXXXXX)"
trap 'rm -f "$STDERR_LOG"' EXIT

# `vsce ls` invokes the `vscode:prepublish` script (which runs the
# placeholder guard) before listing. The guard intentionally fails
# while v0 placeholders are in tree — but for THIS structural check,
# we want to exercise vsce's file-listing pass, not its publish
# guard. Use the internal-dryrun bypass
# (INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1) which is reserved for
# structural guards that need `vsce ls` output without packaging.
#
# NOTE — coupling acknowledged (tech-lead-R3-M2 path C):
# This guard structurally REQUIRES knowledge of the placeholder
# bypass mechanism in `prepublish-guard.mjs`. If a future refactor
# changes the bypass mechanism, this script must be updated in
# lockstep. The `[prepublish-guard] BYPASSED for INTERNAL DRYRUN`
# warning visible in stderr during a successful run is the audit
# trail proving the bypass was scoped to this subprocess only — DO
# NOT suppress it. The internal-dryrun bypass uses a single, narrow
# env-var name (INTELLIG_INTERNAL_PREPUBLISH_DRYRUN) distinct from
# the dogfood path so the two cannot be conflated.
# Path A (`vsce ls --no-dependencies`) was rejected — verified that
# vsce@2.24.0 still runs `vscode:prepublish` even with
# --no-dependencies. Path B (split prepublish into two scripts) was
# rejected — would not decouple this guard from the placeholder
# guard. Path C (document the coupling) is the chosen approach.
set +e
LISTING="$(INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1 \
  npx --yes "@vscode/vsce@${VSCE_VERSION}" ls 2>"$STDERR_LOG")"
VSCE_EXIT=$?
set -e

if [ "$VSCE_EXIT" -ne 0 ] || [ -z "$LISTING" ]; then
  echo "[check:vsix-clean] FAIL: vsce ls exited $VSCE_EXIT with no listing."
  if [ -s "$STDERR_LOG" ]; then
    echo "[check:vsix-clean] vsce stderr:"
    sed 's/^/  /' "$STDERR_LOG"
  else
    echo "[check:vsix-clean] (no stderr captured — try \`npx @vscode/vsce@${VSCE_VERSION} ls\` manually to diagnose)"
  fi
  exit 1
fi

VIOLATIONS="$(echo "$LISTING" | grep -E "$FORBIDDEN_PATTERNS" || true)"

# Note (senior-R3-LOW-2): the captured stderr always contains
# `[prepublish-guard] BYPASSED for INTERNAL DRYRUN` because we set
# INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1 above. That warning is the
# expected audit trail proving the bypass was scoped to this
# subprocess only — a CI run that DOESN'T see it indicates the
# bypass mechanism has changed and may need a revisit. We do NOT
# suppress the warning even on success.

if [ -n "$VIOLATIONS" ]; then
  echo "[check:vsix-clean] FAIL — forbidden files would ship in .vsix:"
  echo "$VIOLATIONS" | sed 's/^/  - /'
  echo ""
  echo "[check:vsix-clean] Audit the .vscodeignore. The 365→108 regression"
  echo "  on 2026-05-15 was caused by an '!out/**/*.js' re-include silently"
  echo "  overriding 'out/test/**'. See the leading comment block in"
  echo "  .vscodeignore for the ordering contract."
  exit 1
fi

FILE_COUNT="$(echo "$LISTING" | wc -l | tr -d ' ')"
echo "[check:vsix-clean] OK — vsce@${VSCE_VERSION} ls scanned $FILE_COUNT file(s); no forbidden patterns."
