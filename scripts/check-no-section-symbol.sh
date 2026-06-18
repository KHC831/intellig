#!/usr/bin/env bash
#
# Structural CI guard — the section-sign glyph (U+00A7) is banned in shipped
# source and build scripts; write the word "section" instead.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Comments and doc-section citations that reach for the U+00A7 glyph
#    ("ADR-009 <glyph>6") instead of the plain word ("ADR-009 section 6").
#    The glyph is a house-style violation: it is hard to type, easy to
#    mojibake across encodings, and inconsistent with the prose the rest
#    of the codebase uses. Left ungated it creeps back one citation at a
#    time. The fix is uniform: spell it "section".
#
# 2. Heuristic + how it scales
#    grep the scanned paths for the raw U+00A7 byte. The glyph is built
#    at runtime with printf so this script's own source carries no literal
#    occurrence and never self-matches. Default scope is production source
#    (src, excluding the src/test tree) plus build scripts; pass explicit
#    paths to scan a fixture (used by the companion spec). Adding a new
#    source root is a one-word edit to the default PATHS.
#
# 3. Known false-positive cases
#    None in shipped code. The src/test tree and docs/ are deliberately out
#    of scope: test describe/it titles and doc-content assertions cite doc
#    sections that still use the glyph, and several couple to ADR text; that
#    surface is a separate, doc-coupled cleanup, not this guard's remit.
#
# 4. Known false-negative cases
#    Escaped spellings of the same glyph (the &sect; named entity, the
#    &#167; numeric entity, or a \xc2\xa7 byte escape) are not matched —
#    only the literal byte. None appear in the codebase; if a contributor
#    introduced one it would read as an escape, not the glyph.
#
# 5. Retirement criteria
#    Retire if the house style ever adopts the glyph, or when an editor-level
#    lint rule enforces it everywhere by construction.
#
# Exit: 0 when clean, 1 if the glyph appears in any scanned path.

set -euo pipefail

# U+00A7 (section sign) as its UTF-8 bytes, assembled at runtime.
GLYPH=$(printf '\xc2\xa7')

PATHS=("$@")
if [ "${#PATHS[@]}" -eq 0 ]; then
  PATHS=("src" "scripts")
fi

hits=$(grep -rn --exclude-dir=test "$GLYPH" "${PATHS[@]}" 2>/dev/null || true)

if [ -n "$hits" ]; then
  echo "section-symbol guard FAILED — the U+00A7 glyph is banned in shipped source and build scripts." >&2
  echo "  Write the word \"section\" instead (e.g. \"ADR-009 section 6\"). Offending lines:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "section-symbol guard OK (no U+00A7 glyph in production source or build scripts)."
