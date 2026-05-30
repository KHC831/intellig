#!/usr/bin/env bash
#
# Structural CI guard — TL-74 (Wave 8 R2).
#
# Maintenance contract (per ADR-007 §"Guard maintenance contract"):
#
# 1. Bug class
#    Per ADR-006, the three QuickPick / dialog / non-rendering
#    view-STATE interfaces (IShelfViewState, IStashViewState,
#    IBranchComparisonViewState) deliberately carry no `error`
#    field — refresh failures travel through the
#    `Promise<{ error? }>` return value of `refresh()` (and
#    siblings), never via a sideband on view state. This guard
#    asserts the invariant against drift.
#
# 2. Heuristic + how it scales
#    awk state machine. Enter "tracked" mode when we hit
#    `interface I<Name>ViewState {`; leave on the matching closing
#    brace. Inside tracked mode, an `error?: string` (or
#    `error: string | undefined`) field-shape line triggers the
#    guard. Brace-depth tracking handles nested anonymous types.
#    Adding a fourth tracked view-state interface is a one-line
#    addition to the TARGETS array.
#
# 3. Known false-positive cases
#    - Result-shape interfaces in the same files (e.g.
#      `IStashActionResult`, `IShelfActionResult`,
#      `IBranchComparisonActionResult`) are ALLOWED to carry
#      `error?: string` — those are method-return shapes, not view
#      state. The interface-name match in TARGETS disambiguates.
#    - A comment line like `// error?: string is forbidden` inside
#      the tracked block would NOT trigger because the awk pattern
#      anchors on field-shape, not arbitrary text.
#
# 4. Known false-negative cases
#    - A new view-STATE interface that introduces an `error` field
#      under a NAME not in TARGETS is invisible to this guard.
#      Mitigated by ADR-006 review at PR time and the
#      per-FILE representative spec floor.
#    - Indirect leakage: e.g. a state interface that embeds another
#      type which carries `error`. The guard reads only the
#      direct interface body. New embedding cases require an ADR-006
#      revision.
#    - Renames of a tracked interface: the script will fail loudly
#      on the missing-file error rather than silently passing.
#
# 5. Retirement criteria
#    Retire when ADR-006 is superseded (e.g. a unified
#    error-channel design supersedes view-state vs return-value
#    separation), OR when typecheck-level enforcement (a
#    branded-type opaque wrapper) makes the bug class unreachable
#    by construction.
#
# Exit: 0 on clean, 1 on any reacquisition.

set -euo pipefail

# Map file → state-interface name to track. Each entry:
#   "<path>:<interface-name>"
#
# If a future refactor splits one of these interfaces into a different
# shape, update this list — the rule is "the state-shape interface for
# these three QuickPick views must not carry an error field," not
# "these three filenames must exist forever."
TARGETS=(
  "src/shelf/interfaces/IShelfView.ts:IShelfViewState"
  "src/shelf/interfaces/IStashView.ts:IStashViewState"
  "src/branches/interfaces/IBranchComparisonView.ts:IBranchComparisonViewState"
)

violations=0
for entry in "${TARGETS[@]}"; do
  file="${entry%%:*}"
  iface="${entry##*:}"

  if [ ! -f "$file" ]; then
    echo "ERROR: $file not found — has the interface been moved?" >&2
    echo "       Update scripts/check-quickpick-state-no-error.sh TARGETS list." >&2
    exit 1
  fi

  # awk pass:
  #   - INTERFACE_RE matches `interface <iface> {` — set tracking on, depth=1
  #   - Inside tracking, count `{` / `}` to know when block closes
  #   - At each line inside tracking, check for an `error?: string` field
  #
  # Field pattern: leading whitespace + `error` + optional `?` + `:` +
  # `string` (with optional `| undefined`) + `;`. Permits `error?: string;`,
  # `error: string;`, `error: string | undefined;`, `error?: string|undefined;`.
  # Excludes prose (JSDoc lines start with `*`, comments with `//`).
  matches=$(awk -v IFACE="$iface" '
    BEGIN {
      tracking = 0
      depth = 0
      hits = 0
    }

    # Detect interface entry. Match `interface <name> {` allowing for
    # `extends` clauses on the same line.
    {
      if (!tracking) {
        if (match($0, "interface[[:space:]]+" IFACE "[[:space:]]") || \
            match($0, "interface[[:space:]]+" IFACE "[[:space:]]*\\{")) {
          tracking = 1
          # Count opening brace on this line (if present) to seed depth.
          depth = gsub(/\{/, "&", $0) - gsub(/\}/, "&", $0)
          if (depth <= 0) depth = 1
          next
        }
      }
    }

    tracking {
      # Field-shape match — only fires inside the tracked interface body.
      # Skip comment-prefixed lines.
      if ($0 ~ /^[[:space:]]*\*/ || $0 ~ /^[[:space:]]*\/\//) {
        # Adjust depth for braces in comments? Block comments inside an
        # interface are unusual; ignore brace counts on comment lines to
        # avoid false depth shifts.
      } else {
        if (match($0, /^[[:space:]]+error\??:[[:space:]]*(string([[:space:]]*\|[[:space:]]*undefined)?|undefined)[[:space:]]*;/)) {
          print NR ": " $0
          hits++
        }
        # Track depth on non-comment lines.
        opens = gsub(/\{/, "&", $0)
        closes = gsub(/\}/, "&", $0)
        depth += opens - closes
        if (depth <= 0) {
          tracking = 0
        }
      }
    }

    END { exit (hits > 0 ? 1 : 0) }
  ' "$file") || awk_fail=1

  if [ -n "${matches:-}" ]; then
    echo "TL-74 violation — $file declares an 'error' field on $iface (a QuickPick view-state interface)." >&2
    echo "  Matching line(s):" >&2
    echo "$matches" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  Per ADR-006 (docs/adr/ADR-006-error-state-binding-by-view-type.md)," >&2
    echo "  QuickPick views surface refresh failures through the Promise<{ error? }>" >&2
    echo "  return value of refresh()/setBranches()/swapBranches(), not a state sideband." >&2
    echo "" >&2
    violations=$((violations + 1))
  fi
done

if [ "$violations" -gt 0 ]; then
  echo "TL-74 structural guard FAILED ($violations interface(s) with violations)." >&2
  exit 1
fi

echo "TL-74 structural guard OK (none of the ${#TARGETS[@]} QuickPick view-state interfaces declare an 'error' field)."
