#!/usr/bin/env bash
# ============================================================
# check-vsix-clean.sh — asserts `vsce ls` would not include any
# forbidden file in the published .vsix.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    `.vscodeignore` regression silently shipping internal files
#    (.agent/ coordination notes, AGENT_WORKSPACE.md, IDE configs,
#    test JS, source `.ts`, .map files, dev scripts) into the
#    Marketplace .vsix. A prior .vscodeignore had a
#    `!out/**/*.js` re-include that overrode `out/test/**`, leaking
#    365 files / 1.54 MB before being noticed. Drift class is real
#    and recurring.
#
# 2. Heuristic + how it scales
#    Run `vsce ls` (the same listing logic vsce uses for `vsce
#    package`) and check BOTH directions:
#      - FORBIDDEN: grep for a hand-curated list of POSIX
#        extended-regex patterns covering: test JS, .map files,
#        source `.ts`, `node_modules/` and `out/` (the extension is
#        BUNDLED — dist/extension.js carries every runtime dep, so
#        nothing from either tree may ship), `.agent/`,
#        `AGENT_WORKSPACE`, `CLAUDE.md`, `coverage/` (35 MB shipped
#        unnoticed in 0.2.10), `tsconfig.test.json`, IDE configs,
#        `docs/`, `scripts/`, `src/`, lint/format configs,
#        `package-lock.json`, `CONTRIBUTING.md`, `.DS_Store`.
#      - REQUIRED: the runtime manifest — dist/extension.js (the
#        bundle), dist/rebaseTodoEditor.js (the GIT_SEQUENCE_EDITOR
#        entry RebaseService spawns as a __dirname sibling),
#        media/mergeWindow.js (webview bundle),
#        media/codicon.ttf (webview font), media/monaco/vs/loader.js
#        (merge-window Monaco AMD build, copied from monaco-editor
#        at compile time). A missing entry is the 0.2.3 class
#        (activation-dead package) caught at the gate instead of on
#        install.
#    Each pattern targets a known bug class. Adding one is one line
#    plus a one-sentence rationale.
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
#      version below; update + re-test when bumping.
#    - New "forbidden" file class not in FORBIDDEN_PATTERNS:
#      e.g. `.idea/sonar.config` ships fine if `.idea/` was missed
#      from .vscodeignore (it isn't — but the bug class would
#      bypass this guard until added).
#    - REQUIRED_FILES verifies presence in the listing, not that the
#      file's CONTENT is a working build — a zero-byte
#      dist/extension.js still passes. The ext-host activation lane
#      owns that deeper contract.
#
# 5. Retirement criteria
#    The original criteria fired: the extension is now bundled, and
#    this guard became the bundler's manifest verification (the
#    REQUIRED side) plus the ignore-regression net (the FORBIDDEN
#    side). Retire only if vsce gains a deny-by-default packaging
#    mode that can also assert required entries.
# ============================================================

set -euo pipefail

cd "$(dirname "$0")/.."

# Pin vsce version for reproducible `vsce ls` output. Bump when
# adopting a new vsce minor; re-run the RED inversion test after.
VSCE_VERSION="2.24.0"

# Patterns that MUST NOT appear in `vsce ls` output. POSIX-extended
# regex; pipe-separated alternatives.
FORBIDDEN_PATTERNS='(\.test\.js$|^node_modules/|^out/|^test/|^workspace-notes/|^coverage/|^CLAUDE\.md$|tsconfig\.test\.json|/\.agent/|^\.agent/|AGENT_WORKSPACE|^\.idea/|^\.kiro/|^\.vscode-test/|^docs/|^scripts/|^src/|tsconfig\.json|^\.eslintrc|^\.prettierrc|^\.prettierignore|^\.mocharc|^package-lock\.json$|^CONTRIBUTING\.md$|\.DS_Store|\.map$|\.ts$)'

# Runtime manifest — every entry MUST appear in `vsce ls`, or the
# package is activation-dead / feature-dead on install (the 0.2.3
# missing-dependency class, now expressed as a missing bundle or a
# missing build-copied asset).
REQUIRED_FILES=(
  'dist/extension.js'
  'dist/rebaseTodoEditor.js'
  'media/mergeWindow.js'
  'media/codicon.ttf'
  'media/monaco/vs/loader.js'
)

# Capture stderr to a temp file so we can surface vsce errors on FAIL
# rather than swallowing them behind a generic message.
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
# NOTE — coupling acknowledged:
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
#
# `vsce ls` runs `npm list --production --depth=99999`, which rejects a
# SYMLINKED node_modules root (the git-worktree dev setup): every dep
# is reported `extraneous` (ELSPROBLEMS) and vsce exits 1. Route the
# invocation through with-real-node-modules.sh, which transparently
# materialises a real node_modules clone when (and only when)
# node_modules is a symlink — so this guard runs faithfully in a
# worktree instead of being skipped, and is unchanged in a normal
# checkout. `--no-dependencies` was NOT used here: it would drop the
# production-dependency files (which genuinely ship in the .vsix) from
# the scan and weaken the guard.
set +e
LISTING="$(INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1 \
  bash scripts/lib/with-real-node-modules.sh \
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

# Note: the captured stderr always contains
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

MISSING=""
for required in "${REQUIRED_FILES[@]}"; do
  if ! echo "$LISTING" | grep -qx "$required"; then
    MISSING="${MISSING}  - ${required}\n"
  fi
done
if [ -n "$MISSING" ]; then
  echo "[check:vsix-clean] FAIL — runtime manifest entries missing from the .vsix:"
  printf '%b' "$MISSING"
  echo ""
  echo "[check:vsix-clean] The package would be activation-dead or feature-dead"
  echo "  on install. Run \`npm run compile\` (builds dist/ + media assets) and"
  echo "  check .vscodeignore hasn't excluded a required path."
  exit 1
fi

FILE_COUNT="$(echo "$LISTING" | wc -l | tr -d ' ')"
echo "[check:vsix-clean] OK — vsce@${VSCE_VERSION} ls scanned $FILE_COUNT file(s); no forbidden patterns; runtime manifest complete."
