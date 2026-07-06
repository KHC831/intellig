#!/usr/bin/env bash
# ============================================================
# check-rev-parse-verified.sh — no FLAGLESS `rev-parse` through
# buildGitArgs.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    `buildGitArgs('rev-parse', [], [rev])` produces
#    `rev-parse --end-of-options <rev>`, and a flagless rev-parse ECHOES
#    the literal `--end-of-options` as its first stdout line (observed on
#    git 2.50). The `stdout.trim()` idiom then returns
#    `"--end-of-options\n<sha>"` — a two-line token that silently corrupts
#    every downstream argument built from it. Three production sites had
#    exactly this (blame annotate-previous, multi-commit diff base, the
#    rebase-from-here parent fallback); the class re-enters whenever a new
#    single-rev resolve is hand-rolled.
#
# 2. Heuristic + how it scales
#    Grep src/**/*.ts for `buildGitArgs('rev-parse', []` (a flagless
#    rev-parse argv build). Zero hits expected: single-rev resolves go
#    through `revParseVerified` (gitCli.ts), whose `--verify` makes
#    rev-parse consume the terminator and emit exactly one sha. A
#    legitimate multi-rev or specialty rev-parse passes a real flag
#    (`--short`, `--verify`, `--abbrev-ref`, …), which never matches this
#    pattern. Adding an exempt line = trailing
#    `// rev-parse-flagless-exempt: <reason>`.
#
# 3. Known false-positive cases
#    None today — the pattern is exact. A future caller that genuinely
#    needs flagless rev-parse (none known; every current need has a flag)
#    uses the exempt comment.
#
# 4. Known false-negative cases
#    - A flagless rev-parse argv built WITHOUT buildGitArgs (raw array
#      literal) is not matched — but that shape already fails
#      check:exec-leading-rev for user-controlled revs.
#    - The echo behavior may differ across git versions; the guard fences
#      the calling pattern, not the runtime behavior.
#
# 5. Retirement criteria
#    Retire if git guarantees flagless rev-parse consumes
#    `--end-of-options` (and the project's floor rises past that version),
#    or if buildGitArgs stops emitting the terminator for rev-parse.
# ============================================================

set -euo pipefail

cd "$(dirname "$0")/.."

VIOLATIONS="$(grep -rn "buildGitArgs('rev-parse', \[\]" src --include='*.ts' \
  | grep -v 'rev-parse-flagless-exempt:' || true)"

if [ -n "$VIOLATIONS" ]; then
  echo "check-rev-parse-verified: FAIL — flagless rev-parse via buildGitArgs:"
  echo "$VIOLATIONS" | sed 's/^/  - /'
  echo ""
  echo "  A flagless \`rev-parse --end-of-options <rev>\` echoes the literal"
  echo "  --end-of-options into stdout, corrupting the resolved rev. Use"
  echo "  revParseVerified (src/git-core/gitCli.ts) for single-rev resolves,"
  echo "  pass a real flag, or mark the line"
  echo "  '// rev-parse-flagless-exempt: <reason>'."
  exit 1
fi

echo "check-rev-parse-verified: OK"
