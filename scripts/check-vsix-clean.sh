#!/usr/bin/env bash
# ============================================================
# check-vsix-clean.sh — asserts `vsce ls` would package NOTHING
# outside the allow-list and NOTHING matching a forbidden pattern,
# and that the runtime manifest is complete.
#
# The three rule sets (deny / allow / require) live in
# scripts/lib/vsix-rules.sh, shared verbatim with publish.sh's
# post-build artifact scan so the pre-package guard and the
# post-build gate can never drift.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    `.vscodeignore` regression silently shipping internal files
#    (.agent/ coordination notes, .husky/ hooks, AGENT_WORKSPACE.md,
#    IDE configs, test JS, source `.ts`, .map files, dev scripts)
#    into the Marketplace .vsix. A prior .vscodeignore had a
#    `!out/**/*.js` re-include that overrode `out/test/**`, leaking
#    365 files / 1.54 MB; `.husky/**` (18 files) shipped in 0.3.1
#    because the deny-list had no husky pattern. Drift class is real
#    and recurring — a deny-list alone can only catch classes it
#    already knows.
#
# 2. Heuristic + how it scales
#    Run `vsce ls` (the same listing logic vsce uses for `vsce
#    package`), FILTER the captured stdout down to real listing lines
#    (npm/script echoes from the vscode:prepublish chain are dropped —
#    every genuine listing entry is a repo-relative file that exists
#    on disk), then check THREE directions via vsix-rules.sh:
#      - ALLOW (primary): every listed entry MUST fall under an
#        allowed prefix (dist/ media/ resources/) or be an exact root
#        file (images/icon.png, README/CHANGELOG/SECURITY .md,
#        LICENSE, package.json). Anything else fails — this closes the
#        leak class the deny-list alone cannot (an unknown internal
#        file matches nothing allowed).
#      - FORBIDDEN (second net): a hand-curated pattern list covering
#        test JS, .map, source `.ts`, node_modules/ out/ out-test/
#        (the extension is BUNDLED — dist/extension.js carries every
#        runtime dep), .husky/, .agent/, AGENT_WORKSPACE, CLAUDE.md,
#        coverage/, IDE configs, docs/, scripts/, src/, configs.
#      - REQUIRED: the runtime manifest — dist/extension.js (bundle),
#        dist/rebaseTodoEditor.js (the GIT_SEQUENCE_EDITOR entry
#        RebaseService spawns as a __dirname sibling),
#        media/mergeWindow.js (webview bundle), media/codicon.ttf
#        (webview font), media/monaco/vs/loader.js (Monaco AMD build),
#        resources/git-icon-branch.svg (panel icon) and
#        images/icon.png (gallery icon). A missing entry is the 0.2.3
#        class (activation-dead / visually-broken package) caught at
#        the gate instead of on install.
#    Adding a rule is one line in vsix-rules.sh plus a rationale.
#
# 3. Known false-positive cases
#    A new legitimate top-level file or directory that vsce packages
#    (e.g. a deliberately-shipped `NOTICE`) fails the allow-list until
#    added to VSIX_ALLOWED_EXACT / VSIX_ALLOWED_PREFIXES. That is the
#    intended fail-closed behaviour: a human decides each new class of
#    shipped file.
#
# 4. Known false-negative cases
#    - vsce version drift: the @vscode/vsce package's `vsce ls`
#      output format could change between versions and silently
#      mask regressions. Mitigated by pinning to a specific vsce
#      version below; update + re-test when bumping.
#    - REQUIRED verifies presence in the listing, not that the file's
#      CONTENT is a working build — a zero-byte dist/extension.js
#      still passes. The ext-host activation lane owns that contract.
#
# 5. Retirement criteria
#    The original criteria fired: the extension is now bundled, and
#    this guard became the bundler's manifest verification (REQUIRED)
#    plus the ignore-regression net (ALLOW + FORBIDDEN). Retire only
#    if vsce gains a deny-by-default packaging mode that can also
#    assert required entries.
# ============================================================

set -euo pipefail

cd "$(dirname "$0")/.."

# Shared rule sets (FORBIDDEN / ALLOW / REQUIRE), also sourced by
# publish.sh so the two content checks can never drift.
# shellcheck source=scripts/lib/vsix-rules.sh
source scripts/lib/vsix-rules.sh

# Pin vsce version for reproducible `vsce ls` output. Bump when
# adopting a new vsce minor; re-run the RED inversion test after.
VSCE_VERSION="2.24.0"

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

# The captured stdout mixes the real `vsce ls` listing with npm/script
# echoes from the vscode:prepublish chain (`> intellig@… prepublish`,
# `[check:…] OK`, esbuild/tsc command echoes). Filter to REAL listing
# lines: every genuine vsce entry is a repo-relative path that exists
# on disk (dist/ + media/ are built by the compile step this guard
# runs after); build-log lines are not files. This is what makes an
# allow-list assertion possible — grepping raw log text would both
# miscount and false-positive on any log line ending `.ts` etc.
# Worktree-only scaffolding to normalise out — never present in a
# real (non-worktree) package, produced purely by HOW this guard runs
# in a git worktree: `.git` is a gitdir POINTER FILE in a linked
# worktree (a directory, hence unlisted, in a normal checkout), and
# `node_modules.real.*` / `node_modules.link.*` / `node_modules.swap.lock`
# are the swap clone/backup/lock with-real-node-modules.sh creates
# while vsce reconciles the install. Both anchors are exact enough that
# a genuine `.git/config` leak (`^\.git/`, still caught) or a real
# `node_modules/` leak (`^node_modules/`, still caught) is unaffected.
FILTERED=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in
    .git | node_modules.real.* | node_modules.link.* | node_modules.swap.lock*) continue ;;
  esac
  if [ -f "$line" ]; then
    FILTERED="${FILTERED}${line}"$'\n'
  fi
done <<< "$LISTING"
FILTERED="${FILTERED%$'\n'}"

if [ -z "$FILTERED" ]; then
  echo "[check:vsix-clean] FAIL: no real listing lines survived filtering."
  echo "[check:vsix-clean] raw vsce stdout was:"
  echo "$LISTING" | sed 's/^/  /'
  exit 1
fi

# Note: the captured stderr always contains
# `[prepublish-guard] BYPASSED for INTERNAL DRYRUN` because we set
# INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1 above. That warning is the
# expected audit trail proving the bypass was scoped to this
# subprocess only — a CI run that DOESN'T see it indicates the
# bypass mechanism has changed and may need a revisit. We do NOT
# suppress the warning even on success.

NOT_ALLOWED="$(printf '%s\n' "$FILTERED" | vsix_allowlist_violations)"
if [ -n "$NOT_ALLOWED" ]; then
  echo "[check:vsix-clean] FAIL — files outside the allow-list would ship in .vsix:"
  printf '%s\n' "$NOT_ALLOWED" | sed 's/^/  - /'
  echo ""
  echo "[check:vsix-clean] Every packaged entry must fall under dist/, media/,"
  echo "  resources/, or the exact root set (images/icon.png, README.md,"
  echo "  CHANGELOG.md, LICENSE, SECURITY.md, package.json). Audit .vscodeignore;"
  echo "  if the file legitimately ships, add it to VSIX_ALLOWED_* in"
  echo "  scripts/lib/vsix-rules.sh."
  exit 1
fi

VIOLATIONS="$(printf '%s\n' "$FILTERED" | vsix_forbidden_violations)"
if [ -n "$VIOLATIONS" ]; then
  echo "[check:vsix-clean] FAIL — forbidden files would ship in .vsix:"
  printf '%s\n' "$VIOLATIONS" | sed 's/^/  - /'
  echo ""
  echo "[check:vsix-clean] Audit the .vscodeignore. The 365→108 regression"
  echo "  on 2026-05-15 was caused by an '!out/**/*.js' re-include silently"
  echo "  overriding 'out/test/**'. See the leading comment block in"
  echo "  .vscodeignore for the ordering contract."
  exit 1
fi

MISSING="$(printf '%s\n' "$FILTERED" | vsix_missing_required)"
if [ -n "$MISSING" ]; then
  echo "[check:vsix-clean] FAIL — runtime manifest entries missing from the .vsix:"
  printf '%s\n' "$MISSING" | sed 's/^/  - /'
  echo ""
  echo "[check:vsix-clean] The package would be activation-dead or feature-dead"
  echo "  on install. Run \`npm run compile\` (builds dist/ + media assets) and"
  echo "  check .vscodeignore hasn't excluded a required path."
  exit 1
fi

FILE_COUNT="$(printf '%s\n' "$FILTERED" | wc -l | tr -d ' ')"
echo "[check:vsix-clean] OK — vsce@${VSCE_VERSION} ls scanned $FILE_COUNT file(s); allow-list + deny-list clean; runtime manifest complete."
