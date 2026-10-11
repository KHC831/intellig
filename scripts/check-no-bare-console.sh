#!/usr/bin/env bash
#
# Structural CI guard — task 15.2 (logging-and-src-restructure).
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Bare `console.<method>` calls in production code. Requirement 6.7
#    (and the section 6 service sweep, section 9 `console.*` sweep) replaced every
#    scattered `console.log` / `console.error` / `console.warn` call
#    site with the structured Logger (`getLogger().{trace,debug,info,
#    warn,error}`), whose `OutputChannelSink` writes to the
#    user-visible `IntelliG` output channel. A stray `console.<method>`
#    in shipped code is invisible to a user running the published
#    extension (no devtools, no extension-host console) and bypasses
#    the Logger's sanitization + level + correlation conventions
#    (Requirements 1-5). This guard fails the build if any non-test
#    production file under `src/` references `console.<method>`.
#
#    The ONE sanctioned production reference to `console.*` is the
#    developer-only mirror `src/utils/logger/sinks/ConsoleSink.ts`
#    (Requirement 3.3) — it is allowlisted below.
#
# 2. Heuristic + how it scales
#    `find src -type f -name '*.ts'` + `grep -nE` for the pattern
#    `console\.(log|error|warn|info|debug|trace)` against the full
#    `src/` tree (matching the project convention established by
#    check-test-only-surface.sh). The method alternation is pinned to
#    the Logger's level set (trace|debug|info|warn|error) plus the
#    legacy `log` alias — the exact verbs the section 9 sweep migrated. For
#    each hit, three classes of reference are NOT violations and are
#    filtered out:
#
#      - The single allowlisted file
#        `src/utils/logger/sinks/ConsoleSink.ts` (the sanctioned
#        ConsoleSink mirror — see its file-level JSDoc).
#      - Any file under `src/test/**` (tests deliberately exercise
#        and stub `console.*` to assert the production path no longer
#        uses it).
#      - Pure comment lines (`//` line comments and JSDoc / block
#        bodies `* …`, `/* …`, `*/`, `/** …`) — many files reference
#        `console.error` in prose describing the legacy path that was
#        migrated.
#
#    Every remaining hit is a production `console.<method>` call and a
#    violation. Pinning the verb alternation (rather than matching any
#    `console.<ident>`) deliberately excludes the webview message-type
#    protocol strings `'console.clear'` / `'console.filter'` used by
#    the Git tool-window tab router (`type.startsWith('console.')`),
#    which are routing keys, not console calls.
#
# 3. Known false-positive cases
#    - A webview `<script>` payload that embeds a literal
#      `console.log(...)` JS string for the *browser* context (e.g.
#      the BaseWebviewView pattern). None exist on the current tree;
#      the in-repo examples all live in JSDoc (`*`-prefixed) comment
#      blocks and are filtered. If such a payload is ever shipped on a
#      non-comment line it would trip the guard — refactor the script
#      out of the inline string, or move the example into a comment.
#    - An inline trailing comment on a code line, e.g.
#      `doX(); // console.log fallback` — the line does not *start*
#      with `//`, so the comment filter (which keys off the first
#      significant token, matching check-test-only-surface.sh) would
#      not exempt it. Rare; rephrase as a full-line comment.
#
# 4. Known false-negative cases
#    - Bracket-notation dispatch `console[method](...)` (the shape
#      ConsoleSink itself uses) is not matched — by design the dot
#      pattern targets the bare-call idiom the sweep removed, and the
#      one legitimate bracket-notation site is the allowlisted
#      ConsoleSink anyway. A production file that reached for
#      `console['log']` would slip; mitigated by code review + the
#      Logger being the obvious, documented surface.
#    - A `console.<method>` constructed dynamically (string concat /
#      `globalThis.console`) would evade the literal pattern. Rare and
#      itself a code smell; out of scope for this structural guard.
#    - A verb outside the pinned alternation (e.g. `console.table`,
#      `console.dir`) would not match. The section 9 sweep only encountered
#      log/error/warn/info/debug; extend CONSOLE_METHODS if a new verb
#      enters the codebase.
#
# 5. Retirement criteria
#    Retire when (a) an ESLint `no-console` rule with a per-file
#    allowlist for ConsoleSink.ts is wired into `npm run lint` (making
#    this grep redundant), OR (b) the `console` global is made
#    unreachable from production modules by construction (e.g. a lint
#    `no-restricted-globals` boundary or a typed wrapper), OR (c) the
#    Logger's ConsoleSink is removed and the developer-mirror need is
#    served another way.
#
# Companion specs (per ADR-007 section "Per-FILE representative spec floor"):
#    src/test/property/loggerConsoleMirror.property.test.ts and
#    src/test/property/loggerSinkMulticast.property.test.ts pin the one
#    sanctioned console.* site's behaviour (level→method mapping,
#    trace→console.debug, console-enabled gating) through the real
#    ConsoleSink, anchoring the bug class with a behavioural witness for
#    the allowlisted file.
#
# Exit: 0 on clean, 1 if any production file references console.<method>.

set -euo pipefail

# shellcheck source=scripts/lib/grep-hit.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/grep-hit.sh"

# The single sanctioned production reference to console.* — the
# developer-only ConsoleSink mirror (Requirement 3.3).
ALLOWLISTED_FILE='src/utils/logger/sinks/ConsoleSink.ts'

# console methods the structured Logger replaced. Pinned to the
# Logger's level set (trace|debug|info|warn|error) plus the legacy
# `log` alias — the verbs the section 9 `console.*` sweep migrated. Pinning
# the alternation excludes the webview `console.clear` / `console.filter`
# message-type routing strings.
CONSOLE_METHODS='log|error|warn|info|debug|trace'

# Discover candidate files via `find src -type f -name '*.ts'` to match
# the existing structural guards (e.g. check-test-only-surface.sh).
# `find | xargs grep` is portable, recursive by construction, and keys
# off /dev/null so grep always prints the filename even for a lone file.
matches=$(find src -type f -name '*.ts' -print0 \
  | xargs -0 grep -nE "console\.(${CONSOLE_METHODS})" /dev/null 2>/dev/null || true)

violations=0
violation_lines=()

while IFS= read -r line; do
  if [ -z "$line" ]; then
    continue
  fi
  # Format: <file>:<lineno>:<content>
  split_grep_hit "$line"
  file=$HIT_FILE content=$HIT_TEXT

  # Allow the single sanctioned ConsoleSink definition site.
  if [ "$file" = "$ALLOWLISTED_FILE" ]; then
    continue
  fi

  # Allow any file under src/test/.
  case "$file" in
    src/test/*)
      continue
      ;;
  esac

  # Trim leading whitespace so the comment classification below sees
  # the first significant token.
  trimmed="${content#"${content%%[![:space:]]*}"}"

  # Allow pure comment lines: `//` line comments and JSDoc / block
  # comment bodies (`* …`, `/* …`, `*/`, `/** …`). These reference
  # console.* in prose describing the migrated legacy path.
  case "$trimmed" in
    //*|\**|/\**|\*/*)
      continue
      ;;
  esac

  violations=$((violations + 1))
  violation_lines+=("$line")
done <<<"$matches"

if [ "$violations" -gt 0 ]; then
  echo "no-bare-console structural guard FAILED — production code references console.<method>:" >&2
  for v in "${violation_lines[@]}"; do
    echo "  $v" >&2
  done
  echo "" >&2
  echo "  Requirement 6.7: production code must route through the structured" >&2
  echo "  Logger (getLogger().{trace,debug,info,warn,error}) — never bare" >&2
  echo "  console.*. Bare console calls are invisible in the published" >&2
  echo "  extension and bypass the Logger's sanitization / level /" >&2
  echo "  correlation conventions." >&2
  echo "" >&2
  echo "  The ONLY sanctioned console.* site is" >&2
  echo "    ${ALLOWLISTED_FILE}" >&2
  echo "  (the developer-only ConsoleSink mirror, Requirement 3.3)." >&2
  echo "  Tests under src/test/** are exempt." >&2
  echo "" >&2
  echo "See scripts/check-no-bare-console.sh header for full rationale." >&2
  exit 1
fi

echo "no-bare-console structural guard OK (no production console.<method> references outside ConsoleSink)."
