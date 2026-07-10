#!/usr/bin/env bash
#
# Structural CI guard — TL-72 (Wave 9) + TL-78/TL-79 (Wave 9 R3).
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Credential / home-path leak via toast. Error messages from
#    `git` stderr can embed credentials in remote URLs
#    (`https://x-access-token:ghp_…@github.com/...`) and absolute
#    home paths (`/Users/<name>/…`); piping that into a toast
#    `vscode.window.show*Message(...)` leaks tokens + usernames
#    into the user's notification history (and any user-shared
#    bug-report screenshots). The fix is uniform: route the raw
#    string through `sanitizeGitError(...)` before the toast
#    renders.
#
# 2. Heuristic + how it scales
#    awk-checks every `show(Error|Warning|Information)Message(...)`
#    call in `src/` (excluding `src/test/`) for either:
#      a. `${VAR}` where VAR ∈ SUSPICIOUS_VARS allowlist of
#         error-derived names (m, msg, errMsg, errorMessage,
#         message, raw, reason, abort/force/stash-prefixed
#         variants).
#      b. `${...}` containing `.message` anywhere inside —
#         catches inline `${error instanceof Error ? error.message
#         : ...}` ternaries and property access on captured
#         exceptions.
#    A call is exempt only when annotated with
#    `// sanitize-exempt: <CATEGORY>: <reason>` where CATEGORY ∈
#    EXEMPT_CATEGORIES allowlist (user-input / sha-prefix /
#    pre-sanitized / non-error-data). Multi-line toasts are joined
#    by paren-depth tracking. Adding a new variable / category is a
#    one-line addition to the corresponding allowlist plus a
#    rationale paragraph in the categories section.
#
# 3. Known false-positive cases
#    - Whitelisted variable names that legitimately carry sanitised
#      data (e.g. `${pre-sanitised-headline}`).
#      Suppressed via `// sanitize-exempt: pre-sanitized: <reason>`.
#    - SHA fragments + user-typed query strings + ID strings —
#      bounded character sets, can't embed credentials. Suppressed
#      via `// sanitize-exempt: sha-prefix:` / `user-input:`.
#    - Multi-line toast calls don't false-positive on inner
#      function-call arg lists because we paren-count rather than
#      string-split.
#
# 4. Known false-negative cases
#    - A new variable name conventional for error-derived values
#      that is NOT in SUSPICIOUS_VARS would be invisible. Mitigated
#      by the per-site spec floor: every shipped `show*Message`
#      call has a corresponding TL-72 unit test asserting the
#      sanitised path is exercised, so a new name without a guard
#      entry would surface during PR review of the new spec.
#    - Indirect leakage: if `sanitizeGitError(x)` itself becomes
#      buggy (e.g. accidentally returns input unchanged), this
#      guard wouldn't notice — that's covered by the
#      `gitError.test.ts` spec suite.
#    - String concatenation outside template literals (`'...' +
#      errMsg + '...'`) is currently not pattern-matched. The
#      codebase uses template literals exclusively; flagging
#      concatenation requires a pattern extension if the style
#      ever drifts.
#
# 5. Retirement criteria
#    Retire when (a) `git` runtime gains a built-in credential
#    redactor for stderr that we can rely on instead of
#    sanitiseGitError, OR (b) a typed Result<T, SanitizedError>
#    wrapper makes raw error strings unreachable from the toast
#    surface by construction, OR (c) the credential / home-path
#    leak class becomes unreachable via Marketplace-level
#    privacy attestation.
#
# Closes the credential-leak boundary on every user-visible toast surface.
# Per Wave 4-9, error messages from `git` stderr can embed credentials in
# remote URLs (`https://x-access-token:ghp_…@github.com/...`) and absolute
# home paths (`/Users/<name>/…`); piping that into a
# `vscode.window.showErrorMessage` / `showWarningMessage` /
# `showInformationMessage` toast leaks the token + username into the
# user's notification history (and into any user-shared bug-report
# screenshots). The fix is uniform: route the raw string through
# `sanitizeGitError(...)` (see `src/git-core/gitError.ts`) before the
# toast is rendered.
#
# This script awk-checks every `show(Error|Warning|Information)Message(...)`
# call in `src/` (excluding `src/test/`) and flags any that:
#
#   1. Use template-literal interpolation `${VAR}` where VAR matches a
#      known err-derived variable name (see SUSPICIOUS_VARS below).
#   2. Use template-literal interpolation that contains `.message`
#      anywhere inside the `${...}` (TL-72 R4 rule — catches inline
#      ternaries `${error instanceof Error ? error.message : ...}`,
#      property access on captured exceptions, and any other shape
#      that funnels Error.message into the toast without naming it).
#   3. Do NOT pipe that VAR / expression through `sanitizeGitError(...)`
#      OR `formatActionFailureToast(...)` inside the same call.
#   4. Are NOT explicitly exempted via a structured `// sanitize-exempt:
#      <category>: <reason>` comment on the same line OR the
#      immediately-preceding line.
#
# ## TL-78 (Wave 9 R3) — info-toasts now in scope
#
# Earlier rounds of the guard only inspected error + warning toasts.
# Tech-lead-wave9 review flagged that `showInformationMessage` is the
# same credential-leak class — a `git push` success path that echoes
# `git`'s stdout / stderr as confirmation can equally embed credentials.
# This revision extends the toast-verb regex to include
# `showInformationMessage`. As of Wave 9 R3 the codebase has zero
# err-derived interpolations on info-toasts (174 total info-toast
# calls; none use `${m | msg | errMsg | …}`) — the extension is purely
# future-proofing against drift.
#
# ## TL-79 (Wave 9 R3) — structured exempt taxonomy
#
# Earlier rounds accepted `// sanitize-exempt: <free-form-reason>`
# which let `// sanitize-exempt: idk` slip through. Tech-lead-wave9
# noted this lacks the discipline of a controlled vocabulary. This
# revision constrains the exempt syntax to a category-prefixed form:
#
#     // sanitize-exempt: <category>: <reason>
#
# where `<category>` MUST be one of the values in EXEMPT_CATEGORIES
# (see below). Novel categories require updating this script — making
# the addition a conscious code review decision rather than a free-
# form note. The `<reason>` half is still free-form so authors can
# explain the specifics.
#
# ### Categories
#
#   - `user-input`     — value is a user-typed string echoed back to
#                        the user (e.g. `${query.trim()}` in
#                        "No commit found matching '${query.trim()}'").
#                        Not derived from git stderr; cannot carry a
#                        credential.
#   - `sha-prefix`     — value is a 7- or 40-char hex SHA fragment
#                        (e.g. `${shortHash}`). Bounded character set;
#                        cannot embed a URL or file path.
#   - `pre-sanitized`  — value is the result of an earlier
#                        sanitizeGitError(...) call (e.g.
#                        `const sanitized = sanitizeGitError(raw);`
#                        followed by `…: ${sanitized}`). The sanitiser
#                        already ran on this var; re-wrapping is dead
#                        weight.
#   - `non-error-data` — value is structured non-error data such as a
#                        refresh-result error field that was sanitised
#                        on the producer side (e.g.
#                        `${refreshResult.error}` where `refresh()`
#                        per ADR-006 returns a sanitised error string).
#                        Use sparingly — prefer `pre-sanitized` if the
#                        sanitisation is locally visible.
#
# ## Multi-line handling
#
# Prettier often splits long toast calls across multiple lines, e.g.
#
#     void vscode.window.showErrorMessage(
#       `Failed to X: ${sanitizeGitError(errorMessage)}`
#     );
#
# To handle this without a full TypeScript parser, the script joins
# every `show(Error|Warning|Information)Message(` opener with subsequent
# lines until parenthesis depth returns to zero, then runs the bug-
# class regex on the joined string. This is sufficient for the
# codebase's current style (no nested function-call args inside the
# toast template); if a future contributor adds deeply nested calls,
# the brace-tracking will still terminate correctly because we count
# unescaped parens only.
#
# ## Heuristic notes
#
#   - We deliberately whitelist by *variable name* rather than flagging
#     ALL `${...}` interpolations. Many legitimate toasts include
#     non-error data (`${shortHash}`, `${query.trim()}`, `${id}`) that's
#     not a credential-leak vector. Flagging every `${...}` would have
#     ~40+ false positives. Instead, we maintain a tight allowlist of
#     "error variable names" derived from `error.message` / `err.message`
#     / `String(err)` ternaries. If a future contributor introduces a
#     new variable name, the guard might miss it — but the per-site
#     unit tests added in Wave 9 R1 (`TL-72 — error toast sanitization`
#     describe blocks across stashView/branchComparisonView/pullDialog/
#     mergeDialog/resetDialog/RebaseEditor/branchPopup/commitDialog/
#     shelfView/RebaseProgressView tests) keep the most common names
#     covered. Add the new name to SUSPICIOUS_VARS when you see it.
#
# Exit: 0 on clean, 1 on any unsanitized + non-exempted hit OR any
#       exempt comment with an unknown category.

set -euo pipefail

# Variable names that signal an error-message-derived value. Pre-Wave-9
# audit identified these as the catch-block conventions used codebase-
# wide. If a future change introduces a new name, add it here and add
# a per-site spec mirroring the Wave 9 TDD pattern.
SUSPICIOUS_VARS=(
  "m"
  "msg"
  "errMsg"
  "errorMessage"
  "errMessage"
  "message"
  "raw"
  "reason"
  "abortMsg"
  "forceMsg"
  "stashMsg"
)

# Allowed exempt categories. To add a new category, update this list AND
# document the rationale in the script header. Treat new categories as
# a conscious review decision — not a free-form bypass.
EXEMPT_CATEGORIES=(
  "user-input"
  "sha-prefix"
  "pre-sanitized"
  "non-error-data"
)

# Files to scan: production sources only. Tests are exempt — they
# deliberately exercise the un-sanitised path to assert the fix on the
# production side.
FILES=$(find src -type f -name '*.ts' \
  -not -path 'src/test/*' \
  -not -path 'src/test/**/*' \
  | sort)

VAR_ALT=$(IFS='|'; echo "${SUSPICIOUS_VARS[*]}")
CAT_ALT=$(IFS='|'; echo "${EXEMPT_CATEGORIES[*]}")

violations=0
violation_details=""
bad_exempt_count=0
bad_exempt_details=""

for file in $FILES; do
  # awk pass: join multi-line show*Message calls into one logical
  # buffer keyed by the opener's line number, then test the buffer
  # against the bug-class regex. Tracks `// sanitize-exempt:` markers
  # on the line directly above (or inline). Validates exempt category
  # against the allowlist; an unknown category itself is a violation.
  awk_output=$(awk -v VARS="$VAR_ALT" -v CATS="$CAT_ALT" '
    BEGIN {
      var_pattern = "\\$\\{(" VARS ")\\}"
      # TL-72 R4 — `.message` / `.stderr` rule. Catches inline ternaries
      # like `${error instanceof Error ? error.message : ...}`,
      # property access on captured exceptions (`${err.message}`,
      # `${err.cause.message}`), and direct git CLI result interpolations
      # (`${result.stderr}`, `${result.stdout}`) — any shape that funnels
      # an Error / git-result field into the toast without naming it as
      # a single allowlisted variable. Pattern: any `${...}`
      # interpolation whose body contains `.message`, `.stderr`, or
      # `.stdout`.
      #
      # `.stdout` is included because `git` echoes credentials in stdout
      # for some commands (e.g. `git remote -v`). `.stderr` is the more
      # common leak surface but `.stdout` deserves the same guard.
      # `.error` covers result-object error fields (`${result.error}`,
      # `${outcome.error}`) — several IResult contracts carry the failure
      # text in an `error` property, the same leak surface under a
      # different name. Pre-sanitized producers use a sanitize-exempt.
      message_pattern = "\\$\\{[^}]*\\.(message|stderr|stdout|error)[^}]*\\}"
      # Structured exempt: `// sanitize-exempt: <category>: <reason>`
      # where category matches the allowlist + reason is non-empty.
      good_exempt_pattern = "//[[:space:]]*sanitize-exempt:[[:space:]]*(" CATS ")[[:space:]]*:[[:space:]]*[^[:space:]]"
      # Any exempt marker (used to detect malformed exempts so we can
      # report them as a separate failure mode).
      any_exempt_pattern = "//[[:space:]]*sanitize-exempt:"
      hits = 0
      bad_exempts = 0
      buf_active = 0
      buf = ""
      buf_line = 0
      depth = 0
      prev_was_exempt = 0          # any exempt (good or bad) on prev line
      prev_was_good_exempt = 0     # well-formed exempt on prev line
      buf_has_good_exempt = 0
      buf_has_any_exempt = 0
    }

    {
      line = $0
      this_line_any_exempt = (line ~ any_exempt_pattern)
      this_line_good_exempt = (line ~ good_exempt_pattern)

      # Detect malformed exempt markers as their own violation. An exempt
      # comment with an unknown category (or no category at all, e.g.
      # `// sanitize-exempt: idk`) MUST be caught at CI time so we don'\''t
      # silently bypass the guard via free-form reasons.
      if (this_line_any_exempt && !this_line_good_exempt) {
        # Extract the category portion to surface it in the diagnostic.
        bad_line = line
        gsub(/^[[:space:]]+/, "", bad_line)
        print "BADEXEMPT|" FILENAME "|" NR "|" bad_line
        bad_exempts++
      }

      # Skip JSDoc / block-comment continuation lines — they often
      # contain example code that would otherwise trip the `${...}`
      # detection. A continuation line begins with optional whitespace
      # then `* ` (the JSDoc convention). Single-line `//` comments are
      # already handled implicitly because they cant contain a real
      # show*Message( call without it being valid TS.
      if (line ~ /^[[:space:]]*\*[[:space:]]/ || line ~ /^[[:space:]]*\*$/) {
        next
      }

      if (!buf_active) {
        # Look for a show(Error|Warning|Information)Message( opener
        # anywhere on the line. TL-78 added `Information` to the verb
        # alternation.
        if (match(line, /show(Error|Warning|Information)Message[[:space:]]*\(/)) {
          buf_active = 1
          buf = line
          buf_line = NR
          buf_has_good_exempt = (this_line_good_exempt || prev_was_good_exempt)
          buf_has_any_exempt = (this_line_any_exempt || prev_was_exempt)
          stripped = strip_strings(line)
          opens = gsub(/\(/, "&", stripped)
          closes = gsub(/\)/, "&", stripped)
          depth = opens - closes
          if (depth <= 0) {
            evaluate_buf()
            buf_active = 0
            buf = ""
            depth = 0
            buf_has_good_exempt = 0
            buf_has_any_exempt = 0
          }
        }
      } else {
        buf = buf "\n" line
        if (this_line_good_exempt) {
          buf_has_good_exempt = 1
        }
        if (this_line_any_exempt) {
          buf_has_any_exempt = 1
        }
        stripped = strip_strings(line)
        opens = gsub(/\(/, "&", stripped)
        closes = gsub(/\)/, "&", stripped)
        depth += opens - closes
        if (depth <= 0) {
          evaluate_buf()
          buf_active = 0
          buf = ""
          depth = 0
          buf_has_good_exempt = 0
          buf_has_any_exempt = 0
        }
      }

      # Track exempt status for the NEXT line. We require the exempt
      # marker on the IMMEDIATELY-preceding line; reset on any other.
      prev_was_exempt = this_line_any_exempt
      prev_was_good_exempt = this_line_good_exempt
    }

    function evaluate_buf() {
      # Fire the bug-class regex on the joined buffer. Two detection
      # rules:
      #   (a) allowlist rule — `${VAR}` for VAR in SUSPICIOUS_VARS.
      #   (b) `.message` rule (TL-72 R4) — any `${...}` containing
      #       `.message` (catches inline ternaries + property access).
      # Both rules accept either `sanitizeGitError(...)` or
      # `formatActionFailureToast(...)` as the sanitisation seam — the
      # helper internally calls `sanitizeGitError` so it covers the
      # invariant.
      has_suspicious = (buf ~ var_pattern)
      has_message = (buf ~ message_pattern)
      has_sanitizer = (buf ~ /sanitizeGitError[[:space:]]*\(/) ||
                      (buf ~ /formatActionFailureToast[[:space:]]*\(/)
      # We only honour WELL-FORMED exempts. A malformed exempt was
      # already reported as BADEXEMPT above; it does NOT suppress the
      # primary violation here, so the author gets feedback on both.
      if ((has_suspicious || has_message) && !has_sanitizer && !buf_has_good_exempt) {
        snippet = buf
        gsub(/\n[[:space:]]*/, " ", snippet)
        print "BUG|" FILENAME "|" buf_line "|" snippet
        hits++
      }
    }

    # Strip string + template literals from a line for paren-counting.
    function strip_strings(s,    out) {
      out = s
      gsub(/"[^"]*"/, "\"\"", out)
      gsub(/\047[^\047]*\047/, "\047\047", out)
      return out
    }

    END {
      # Exit non-zero if EITHER class of failure appears. The shell
      # outside re-checks counts via the BUG/BADEXEMPT prefix lines so
      # this awk return is just a fast-path.
      exit ((hits + bad_exempts) > 0 ? 1 : 0)
    }
  ' "$file") || awk_fail=1

  while IFS='|' read -r kind awk_file awk_line awk_snippet; do
    [ -z "$kind" ] && continue
    if [ "$kind" = "BUG" ]; then
      violation_details="${violation_details}${awk_file}:${awk_line}: ${awk_snippet}
"
      violations=$((violations + 1))
    elif [ "$kind" = "BADEXEMPT" ]; then
      bad_exempt_details="${bad_exempt_details}${awk_file}:${awk_line}: ${awk_snippet}
"
      bad_exempt_count=$((bad_exempt_count + 1))
    fi
  done <<< "$awk_output"
done

if [ "$bad_exempt_count" -gt 0 ]; then
  echo "TL-72 structural guard FAILED — malformed sanitize-exempt comment(s):" >&2
  echo "" >&2
  printf '%s' "${bad_exempt_details}" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Exempt syntax requires a category from the allowlist:" >&2
  echo "" >&2
  for cat in "${EXEMPT_CATEGORIES[@]}"; do
    echo "    // sanitize-exempt: ${cat}: <reason>" >&2
  done
  echo "" >&2
  echo "If you believe a new category is warranted, update" >&2
  echo "EXEMPT_CATEGORIES in scripts/check-action-toasts-sanitized.sh" >&2
  echo "AND document the rationale in the script header. Novel" >&2
  echo "categories should be a conscious review decision, not a" >&2
  echo "free-form bypass." >&2
  echo "" >&2
fi

if [ "$violations" -gt 0 ]; then
  echo "TL-72 structural guard FAILED — unsanitized error toast(s) detected:" >&2
  echo "" >&2
  printf '%s' "${violation_details}" | sed 's/^/  /' >&2
  echo "" >&2
  echo "Each call routes a known err-derived variable into a toast template" >&2
  echo "without going through sanitizeGitError(...). git stderr can embed" >&2
  echo "credentials in remote URLs and absolute home paths in errno-style" >&2
  echo "errors — surfacing those raw leaks tokens + usernames into the" >&2
  echo "user's notification history." >&2
  echo "" >&2
  echo "Fix options:" >&2
  echo "  1. Wrap the variable: \`\${sanitizeGitError(VAR)}\`" >&2
  echo "  2. If the value genuinely is not an error string (e.g. a SHA" >&2
  echo "     prefix or user-typed query), exempt the call with a" >&2
  echo "     structured comment on the line above OR same line:" >&2
  for cat in "${EXEMPT_CATEGORIES[@]}"; do
    echo "       // sanitize-exempt: ${cat}: <reason>" >&2
  done
  echo "" >&2
  echo "See scripts/check-action-toasts-sanitized.sh header for full rationale." >&2
fi

if [ "$violations" -gt 0 ] || [ "$bad_exempt_count" -gt 0 ]; then
  exit 1
fi

echo "TL-72 structural guard OK (no unsanitized error-toast templates in src/)."
