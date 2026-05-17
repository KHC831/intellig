#!/usr/bin/env bash
# ============================================================
# check-100-gate.sh — when package.json.version >= 1.0.0, asserts
# every `[ ]` in the CONTRIBUTING.md "1.0.0 gate checklist" has
# been ticked, AND substantively verifies gate condition (2)
# (experimental flags graduated) by inspecting package.json.
#
# Maintenance contract (per ADR-007 §"Guard maintenance contract"):
#
# 1. Bug class
#    Shipping a 1.0.0 release while one of the four 1.0.0 gate
#    conditions (LICENSE finalized / experimental flags graduated /
#    .git-as-file decision / quarterly feedback cycle) is still
#    open. The CONTRIBUTING.md "1.0.0 gate checklist" is the
#    primary tracker, and a maintainer can tick a box without
#    actually doing the work. For gate (2) specifically — the
#    only mechanizable condition — TL-96 adds a STRUCTURAL check
#    against package.json: the experimental flags
#    (`intellig.useCommitToolWindow`, `intellig.useTabbedGitToolWindow`)
#    must either be REMOVED entirely or have BOTH `default: true`
#    and a description that no longer mentions "Experimental".
#    Marking the markdown checkbox does not bypass the structural
#    check. Gates (1)/(3)/(4) stay markdown-only by their nature
#    (legal text, scope decision, time-bounded user-feedback cycle).
#
# 2. Heuristic + how it scales
#    - Read package.json.version.
#    - If major version < 1 (i.e. 0.x), the guard is a no-op
#      (early-return exit 0). Pre-1.0 releases iterate freely.
#    - If major version >= 1:
#      a. Scan CONTRIBUTING.md from "### 1.0.0 gate checklist"
#         heading until the next H2/H3 and assert no `- [ ]`
#         (unticked) bullet remains.
#      b. STRUCTURAL gate-(2) check: for each experimental flag,
#         assert either (i) the schema entry is absent, OR (ii)
#         `default !== false` AND neither `description` nor
#         `markdownDescription` contains "Experimental"
#         (case-insensitive). Both flags must satisfy this.
#    Scales O(file size of CONTRIBUTING.md) for (a) and O(1) for
#    (b); negligible.
#
#    Override hooks (for testing only):
#      INTELLIG_100_GATE_VERSION_OVERRIDE — substitute for
#        package.json.version. Used by the structural-test fixture
#        (see scripts/check-100-gate-flags.test or coder TDD).
#      INTELLIG_100_GATE_PACKAGE_JSON — alternate path to the
#        package.json being inspected.
#
# 3. Known false-positive cases
#    - A `- [ ]` bullet in CONTRIBUTING.md text OUTSIDE the gate
#      section would NOT be flagged because the scan is bounded by
#      the next `## ` heading. If a future contributor adds
#      `- [ ]` examples to the gate section as illustration, mark
#      them with a leading marker (e.g. `> - [ ] (example)`) to
#      keep the scan honest.
#    - Gate-(2) structural check looks for the literal substring
#      "Experimental" (case-insensitive). A real, graduated flag
#      whose description happens to contain the word "Experimental"
#      in unrelated context (e.g. "previously known as the
#      Experimental Foo flag") would false-positive. Mitigation:
#      reword the description; the goal is an unambiguous user-
#      facing schema.
#
# 4. Known false-negative cases
#    - Section rename: if the heading is renamed away from
#      "1.0.0 gate checklist", the markdown scan will not find the
#      anchor and the guard will exit 1 (FAIL: cannot locate …).
#      The structural check still runs because it doesn't depend
#      on the markdown anchor.
#    - A `- [x]` (ticked) bullet doesn't VERIFY the underlying
#      condition for gates (1)/(3)/(4) — it just asserts the
#      maintainer ticked it. This is intentional; those conditions
#      aren't mechanically checkable. Gate (2) IS now checked
#      structurally so ticking-without-doing is no longer enough.
#    - User edits the gate to remove unchecked items rather than
#      ticking them. Same class as above; honor system applies.
#    - A future graduate-then-rollback workflow that lowers a flag
#      back to `default: false` would be flagged as "still
#      experimental" even if the description was scrubbed.
#      Mitigation: Rollback per the experimental-flag graduation
#      sub-protocol means the project is NOT 1.0.0-ready for that
#      condition; the FAIL is correct.
#
# 5. Retirement criteria
#    Retire after 1.0.0 ships AND the next major (2.0.0) lands
#    with its own gate checklist. At that point this guard's
#    definition of "the 1.0.0 gate" is historical; replace with a
#    parameterized "check-major-gate.sh" or delete + recreate per
#    major. The structural flag-graduation check has independent
#    value (it asserts the schema exposes no experimental flags)
#    and could move into a separate `check-no-experimental-flags.sh`
#    if a future major also wants it.
# ============================================================

set -euo pipefail

cd "$(dirname "$0")/.."

PACKAGE_JSON="${INTELLIG_100_GATE_PACKAGE_JSON:-package.json}"

# Version extraction with two seams (R1 senior-M2 fix):
#
#   - When INTELLIG_100_GATE_VERSION_OVERRIDE is SET AND NON-EMPTY,
#     trust it verbatim (test-fixture override path).
#   - Otherwise (unset OR empty-string), read from the configured
#     PACKAGE_JSON via Node. We use readFileSync + JSON.parse rather
#     than `require('./...')` so absolute paths work; the previous
#     `require('./${PACKAGE_JSON}')` produced opaque ENOENT crashes
#     when callers pointed at an out-of-tree fixture.
#
# Treating empty-string as "unset" matches POSIX convention and
# avoids the confusing behaviour that callers got when they
# accidentally set the var to "" expecting "use the default" —
# bash's `${VAR:-fallback}` would have fallen back to the inner
# node -e, which then crashed on the absolute fixture path.
if [ -n "${INTELLIG_100_GATE_VERSION_OVERRIDE:-}" ]; then
  VERSION="$INTELLIG_100_GATE_VERSION_OVERRIDE"
else
  VERSION="$(
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      process.stdout.write(String(pkg.version || ''));
    " "$PACKAGE_JSON"
  )"
  if [ -z "$VERSION" ]; then
    echo "[check:100-gate] FAIL: cannot read \`version\` from $PACKAGE_JSON."
    exit 1
  fi
fi

# Strip pre-release tag (`-rc.1`, `-pre-1`, …) before MAJOR
# extraction (R1 senior-L4 fix). semver allows `1.0.0-rc.1`; its
# MAJOR component is still `1`, but `cut -d. -f1` against
# `0.9.0-pre-1` previously returned `0` only by coincidence. Strip
# the tag so MAJOR is unambiguously the first numeric component.
BASE="${VERSION%%-*}"
MAJOR="${BASE%%.*}"

# Defensive: if MAJOR is non-numeric (bogus version string), FAIL
# with a clear message rather than letting `[ ... -lt 1 ]` emit the
# bash integer-expression error.
case "$MAJOR" in
  ''|*[!0-9]*)
    echo "[check:100-gate] FAIL: cannot parse MAJOR from version=\"$VERSION\" (extracted=\"$MAJOR\"). Expected NN.NN.NN[-tag]."
    exit 1
    ;;
esac

if [ "$MAJOR" -lt 1 ]; then
  echo "[check:100-gate] OK — pre-1.0 (version=$VERSION); gate not enforced."
  exit 0
fi

CONTRIBUTING="CONTRIBUTING.md"
if [ ! -f "$CONTRIBUTING" ]; then
  echo "[check:100-gate] FAIL: $CONTRIBUTING is missing."
  exit 1
fi

# Extract the section starting at "### 1.0.0 gate checklist" (an
# H3 under "## Versioning policy") until the next H2 OR H3 heading.
# awk preserves order.
SECTION="$(awk '
  /^### 1\.0\.0 gate checklist[[:space:]]*$/ { in_section = 1; next }
  in_section && /^##[#[:space:]]/ { in_section = 0 }
  in_section { print }
' "$CONTRIBUTING")"

if [ -z "$SECTION" ]; then
  echo "[check:100-gate] FAIL: cannot locate '### 1.0.0 gate checklist' heading in $CONTRIBUTING."
  echo "[check:100-gate]        Restore the heading literal or update this guard."
  exit 1
fi

# Find unticked checkboxes. Match `- [ ]` (with leading whitespace
# tolerated). Anchored regex avoids `[x]` ticks.
UNCHECKED="$(echo "$SECTION" | grep -nE '^[[:space:]]*-[[:space:]]+\[[[:space:]]\]' || true)"

MARKDOWN_FAIL=0
if [ -n "$UNCHECKED" ]; then
  echo "[check:100-gate] FAIL — version=$VERSION but unticked items remain in the 1.0.0 gate checklist:"
  echo "$UNCHECKED" | sed 's/^/  /'
  echo ""
  echo "[check:100-gate] Tick every condition in CONTRIBUTING.md '### 1.0.0 gate checklist'"
  echo "  before publishing a 1.0.0 release."
  MARKDOWN_FAIL=1
fi

# ----- TL-96: structural check for gate (2) — experimental flags
# graduated. Independent of markdown checkbox state.
#
# Each flag must EITHER be absent from the schema entirely (fully
# removed) OR have:
#   - default !== false
#   - description does not match /experimental/i
#   - markdownDescription does not match /experimental/i
#
# Implemented in Node.js for clean JSON access; the shell script
# captures stdout/exit code.
set +e
FLAG_CHECK_OUTPUT="$(
  INTELLIG_100_GATE_PACKAGE_JSON="$PACKAGE_JSON" \
  node -e '
    const fs = require("fs");
    const path = process.env.INTELLIG_100_GATE_PACKAGE_JSON || "package.json";
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
    const props =
      (pkg.contributes && pkg.contributes.configuration &&
        pkg.contributes.configuration.properties) || {};
    const flags = ["intellig.useCommitToolWindow", "intellig.useTabbedGitToolWindow"];
    const violations = [];
    for (const f of flags) {
      const entry = props[f];
      if (!entry) {
        // Fully removed → graduated. OK.
        continue;
      }
      const reasons = [];
      if (entry.default === false) {
        reasons.push("default=false");
      }
      const desc = typeof entry.description === "string" ? entry.description : "";
      const mdDesc = typeof entry.markdownDescription === "string" ? entry.markdownDescription : "";
      if (/experimental/i.test(desc)) {
        reasons.push("description mentions \"Experimental\"");
      }
      if (/experimental/i.test(mdDesc)) {
        reasons.push("markdownDescription mentions \"Experimental\"");
      }
      if (reasons.length > 0) {
        violations.push({ flag: f, reasons });
      }
    }
    if (violations.length === 0) {
      process.stdout.write("OK\n");
      process.exit(0);
    }
    for (const v of violations) {
      process.stdout.write("FAIL " + v.flag + " :: " + v.reasons.join("; ") + "\n");
    }
    process.exit(1);
  '
)"
FLAG_CHECK_EXIT=$?
set -e

FLAG_FAIL=0
if [ "$FLAG_CHECK_EXIT" -ne 0 ] && [ -n "$FLAG_CHECK_OUTPUT" ]; then
  echo ""
  echo "[check:100-gate] FAIL — version=$VERSION but 1.0.0 gate (2) violation:"
  echo "$FLAG_CHECK_OUTPUT" | while IFS= read -r line; do
    case "$line" in
      FAIL\ *)
        # FAIL <flag> :: <reasons>
        rest="${line#FAIL }"
        flag="${rest%% :: *}"
        reasons="${rest#* :: }"
        echo "  - $flag is still experimental ($reasons). Graduate it"
        echo "    via the experimental-flag graduation sub-protocol in"
        echo "    CONTRIBUTING.md (default-flip, quarterly feedback,"
        echo "    decision: Remove / Keep / Rollback) before bumping"
        echo "    to 1.0.0."
        ;;
      *) ;;
    esac
  done
  FLAG_FAIL=1
fi

if [ "$MARKDOWN_FAIL" -eq 1 ] || [ "$FLAG_FAIL" -eq 1 ]; then
  exit 1
fi

echo "[check:100-gate] OK — version=$VERSION, all checklist items ticked, and gate (2) experimental flags structurally graduated."
