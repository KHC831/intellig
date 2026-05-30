#!/usr/bin/env bash
#
# Structural CI guard — TL-58 (Cluster C), generalized in task 15.1.
#
# Maintenance contract (per ADR-007 §"Guard maintenance contract"):
#
# 1. Bug class
#    This guard pins the TestSurface idiom (`__*ForTest` prefix; see
#    docs/testing.md §3) for the two module-level test-only reset
#    seams the logging stack exposes:
#
#      a. `__resetOutputChannelForTest()` (defined in
#         src/utils/outputChannel.ts) drops the OutputChannel
#         module-level singleton so a fresh test re-inits from a
#         clean slate. Production code MUST NOT call it — doing so
#         tears down the OutputChannel mid-flight and any
#         safeFireAndForget calls from init/watcher paths that route
#         through the cached channel would crash on a disposed
#         instance.
#
#      b. `__resetLoggerForTest()` (defined in
#         src/utils/logger/logger.ts) drops the cached root Logger,
#         detaches every registered Log_Sink, clears the
#         LogLevelResolver caches, and resets the init idempotency
#         flag. Production code MUST NOT call it — it would detach
#         the sinks an in-flight `getLogger().error(...)` is about
#         to write to (Requirement 8.3, 8.4).
#
#    Both names encode the contract in the symbol itself. This guard
#    asserts no file outside `src/test/**` *invokes* either seam.
#
# 2. Heuristic + how it scales
#    `find src -type f -name '*.ts'` + `grep -n` for each literal
#    name against the full `src/` tree. For each hit, three classes
#    of reference are NOT violations and are filtered out:
#
#      - The legitimate definition site for each symbol
#        (`src/utils/outputChannel.ts` for the OutputChannel reset,
#        `src/utils/logger/logger.ts` for the Logger reset).
#      - Any file under `src/test/**` (the only legal caller side).
#      - Pure comment lines (`//` or JSDoc `*` continuation) and
#        re-export lines (`export { … } from …`) — a barrel that
#        re-exports the seam for tests to import (e.g.
#        `src/utils/logger/index.ts`) is not itself a caller; its
#        own callers all live under `src/test/**`.
#
#    Every remaining hit is a production *invocation* and a
#    violation. The literal-name match is precise: adding a third
#    TestSurface seam in another module would not invalidate this
#    guard — extend the NAMES / DEFINITION map below and add the new
#    definition site.
#
# 3. Known false-positive cases
#    - A production file that names either symbol in prose outside a
#      `//`-comment or JSDoc `*` line (e.g. a string literal that is
#      not a call). Rare; rephrase as a comment or move under
#      `src/test/**`. The re-export / comment filter covers the
#      common cases (barrel re-export + doc references) that exist
#      on the current tree.
#
# 4. Known false-negative cases
#    - A caller that constructs the function name dynamically (e.g.
#      `const n = '__reset' + 'LoggerForTest'; (m as any)[n]()`).
#      Rare and itself a code smell; out of scope for this
#      structural guard.
#    - A wrapper export that re-exports a seam under a different name
#      from `src/test/**`. The wrapper's own callers stay under
#      `src/test/**`, so still legal; a production wrapper's
#      construction call (the import) is caught, the indirected
#      invocation is covered by PR review.
#
# 5. Retirement criteria
#    Retire when both singletons are replaced by injectable services
#    (no module-level state to reset for tests), OR when ESLint grows
#    a TestSurface-aware rule that fails the same invariant.
#
# Companion specs (per ADR-007 §"Per-FILE representative spec floor"):
#    src/test/unit/utils/outputChannelTestSurface.test.ts
#      (the "outputChannel — TestSurface rename (TL-58)" block; pins
#      the OutputChannel reset export shape + legacy-name regression).
#    src/test/unit/utils/logger/loggerSurface.test.ts
#    src/test/unit/utils/logger/lifecycle.test.ts
#      (pin the `__resetLoggerForTest` export shape + reset behaviour).
#
# Exit: 0 on clean, 1 if any production file invokes either seam.

set -euo pipefail

# Test-only seam symbols and their single legitimate definition site.
# Keep the two arrays index-aligned: NAMES[i] is defined in
# DEFINITION_FILES[i].
NAMES=(
  '__resetOutputChannelForTest'
  '__resetLoggerForTest'
)
DEFINITION_FILES=(
  'src/utils/outputChannel.ts'
  'src/utils/logger/logger.ts'
)

# Discover candidate files via `find src -type f -name '*.ts'` to match
# the existing structural guards (e.g. check-action-toasts-sanitized.sh).
# `git grep`'s `'src/**/*.ts'` pathspec relies on glob magic that not
# every git version handles uniformly without `:(glob)`; falling back to
# `find | xargs grep` is portable, recursive by construction, and matches
# the project convention.

violations=0
violation_lines=()

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  definition_file="${DEFINITION_FILES[$i]}"

  matches=$(find src -type f -name '*.ts' -print0 \
    | xargs -0 grep -n "$name" /dev/null 2>/dev/null || true)

  while IFS= read -r line; do
    if [ -z "$line" ]; then
      continue
    fi
    # Format: <file>:<lineno>:<content>
    file="${line%%:*}"
    rest="${line#*:}"
    content="${rest#*:}"

    # Allow the definition site for this symbol.
    if [ "$file" = "$definition_file" ]; then
      continue
    fi

    # Allow any file under src/test/.
    case "$file" in
      src/test/*)
        continue
        ;;
    esac

    # Trim leading whitespace from the line content so the comment /
    # re-export classification below sees the first significant token.
    trimmed="${content#"${content%%[![:space:]]*}"}"

    # Allow pure comment lines: `//` line comments and JSDoc / block
    # comment bodies (`* …`, `/* …`, `*/`, `/**`). These reference the
    # seam in prose, not as a call.
    case "$trimmed" in
      //*|\**|/\**|\*/*)
        continue
        ;;
    esac

    # Allow re-export lines: a barrel that re-exports the seam for
    # tests to import (e.g. `export { …, __resetLoggerForTest } from
    # './logger';`) is not a caller. Its own callers live under
    # src/test/**.
    case "$trimmed" in
      export\ *from\ *|export\ {*)
        continue
        ;;
    esac

    violations=$((violations + 1))
    violation_lines+=("$line")
  done <<<"$matches"
done

if [ "$violations" -gt 0 ]; then
  echo "Test-only-surface structural guard FAILED — production code references a test-only reset seam:" >&2
  for v in "${violation_lines[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "  __resetOutputChannelForTest (src/utils/outputChannel.ts) and" >&2
  echo "  __resetLoggerForTest (src/utils/logger/logger.ts) are test-only" >&2
  echo "  seams (TestSurface idiom). Production code must not call them —" >&2
  echo "  they tear down the OutputChannel / Logger singletons mid-flight." >&2
  echo "  Allowed: the definition sites, any file under src/test/**, and" >&2
  echo "  barrel re-export / comment references." >&2
  exit 1
fi

echo "Test-only-surface structural guard OK (no production callers of __resetOutputChannelForTest or __resetLoggerForTest)."
