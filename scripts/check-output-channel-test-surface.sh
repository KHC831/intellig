#!/usr/bin/env bash
#
# Structural CI guard — TL-58 (Cluster C).
#
# Maintenance contract (per ADR-007 §"Guard maintenance contract"):
#
# 1. Bug class
#    `__resetOutputChannelForTest()` (in src/utils/outputChannel.ts) is a
#    test-only seam that drops the module-level singleton so a fresh
#    test can re-init from a clean slate. Production code MUST NOT call
#    it — doing so would tear down the OutputChannel mid-flight and any
#    safeFireAndForget calls from init/watcher paths that route through
#    the cached channel would crash on a disposed instance.
#
#    The TestSurface idiom (`__*ForTest` prefix; see docs/testing.md §3)
#    encodes this contract in the function name. This guard asserts no
#    file outside `src/test/**` references the test-only seam.
#
# 2. Heuristic + how it scales
#    `git grep -n` for the literal `__resetOutputChannelForTest` against
#    the full `src/` tree, filter out the legitimate definition site
#    (src/utils/outputChannel.ts) and any test files (src/test/**).
#    Every remaining hit is a violation.
#
#    Adding a new TestSurface seam in another module would not invalidate
#    this guard — the literal-name match is precise. If a future file
#    introduces another `__*ForTest` symbol it gets its own guard.
#
# 3. Known false-positive cases
#    - JSDoc / comment lines outside `src/test/**` that mention the name
#      in prose (e.g. "see __resetOutputChannelForTest in tests"). Any
#      such reference would block release; rephrase with markdown link
#      to the test-only file or use a code reference like
#      `outputChannel.ts §test-only seam`.
#
# 4. Known false-negative cases
#    - A caller that constructs the function name dynamically (e.g.
#      `const name = '__reset' + 'OutputChannelForTest'; (m as any)[name]()`).
#      Rare and would itself be a code smell; not in scope for this
#      structural guard.
#    - A wrapper export that re-exports the function under a different
#      name from src/test/**. The wrapper's own callers would be in
#      src/test/** so still legal. If a wrapper appears in production
#      code, this guard catches its construction call (the import) but
#      not the indirected invocation; a code review at PR time covers it.
#
# 5. Retirement criteria
#    Retire when the OutputChannel singleton is replaced by an injectable
#    service (no module-level state to reset for tests), OR when ESLint
#    grows a TestSurface-aware rule that fails the same invariant.
#
# Companion spec (per ADR-007 §"Per-FILE representative spec floor"):
#    src/test/unit/utils/outputChannelTestSurface.test.ts
#    (the "outputChannel — TestSurface rename (TL-58)" describe block;
#    pins the new export shape + legacy-name regression guard).
#
# Exit: 0 on clean, 1 if any production file calls the seam.

set -euo pipefail

NAME='__resetOutputChannelForTest'
DEFINITION_FILE='src/utils/outputChannel.ts'

# Discover candidate files via `find src -type f -name '*.ts'` to match
# the existing structural guards (e.g. check-action-toasts-sanitized.sh).
# `git grep`'s `'src/**/*.ts'` pathspec relies on glob magic that not
# every git version handles uniformly without `:(glob)`; falling back to
# `find | xargs grep` is portable, recursive by construction, and matches
# the project convention.
matches=$(find src -type f -name '*.ts' -print0 \
  | xargs -0 grep -n "$NAME" /dev/null 2>/dev/null || true)

violations=0
violation_lines=()

while IFS= read -r line; do
  if [ -z "$line" ]; then
    continue
  fi
  # Format: <file>:<lineno>:<content>
  file="${line%%:*}"

  # Allow the definition site.
  if [ "$file" = "$DEFINITION_FILE" ]; then
    continue
  fi

  # Allow any file under src/test/.
  case "$file" in
    src/test/*)
      continue
      ;;
  esac

  violations=$((violations + 1))
  violation_lines+=("$line")
done <<<"$matches"

if [ "$violations" -gt 0 ]; then
  echo "TL-58 structural guard FAILED — production code references __resetOutputChannelForTest:" >&2
  for v in "${violation_lines[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "  __resetOutputChannelForTest is a test-only seam (TestSurface idiom)." >&2
  echo "  Production code must not call it — it tears down the OutputChannel" >&2
  echo "  singleton mid-flight. See src/utils/outputChannel.ts." >&2
  exit 1
fi

echo "TL-58 structural guard OK (no production callers of __resetOutputChannelForTest)."
