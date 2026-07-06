#!/usr/bin/env bash
# ============================================================
# minify-js.sh — production minify pass for the three bundles
# (extension host, GIT_SEQUENCE_EDITOR entry, merge-window webview).
# Runs as the last step of `vscode:prepublish`.
#
# No-op under INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1: that env var is
# the internal bypass check-vsix-clean.sh sets to obtain a `vsce ls`
# listing WITHOUT actually packaging. The listing's file SET is
# identical minified or not, so minifying there is pure waste — it
# re-runs three esbuild passes on every `npm test` and leaves dist/ in
# a minified state for the next run. Real packaging (`vsce package`)
# never sets the var, so its prepublish minifies exactly as before.
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${INTELLIG_INTERNAL_PREPUBLISH_DRYRUN:-}" = "1" ]; then
  echo "[minify:js] skipped — INTELLIG_INTERNAL_PREPUBLISH_DRYRUN=1 (structural listing does not depend on minified bundles)."
  exit 0
fi

npm run build:extension -- --minify
npm run build:sequence-editor -- --minify
npm run build:webview -- --minify
