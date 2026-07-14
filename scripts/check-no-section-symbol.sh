#!/usr/bin/env bash
#
# Structural CI guard — the section-sign glyph (U+00A7) is banned across the
# source, test, script, and documentation tree; write the word "section"
# instead.
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
#    Search for the raw U+00A7 byte, text content only (binary files are
#    skipped — see case 3). The glyph is built at runtime with printf so
#    this script's own source carries no literal occurrence and never
#    self-matches. The guard runs in two modes:
#      * DEFAULT (no path args — the real gate): `git grep` over the
#        git-TRACKED files in scope (src incl. the src/test subtree,
#        scripts, docs, and the root-level *.md). Scanning only tracked
#        files means untracked/gitignored scratch files (the teammates'
#        AGENT_WORKSPACE.md coordination notes, local *.md) are NEVER
#        flagged — they are out of scope by construction. Adding a new
#        source root is a one-pathspec edit to the git-grep call.
#      * EXPLICIT PATHS (used by the companion spec): plain recursive
#        `grep -rnI` over the given paths. The spec's fixtures live in
#        temp, non-git directories, so git-based scanning cannot apply
#        there — this mode keeps the fixture tests working.
#
# 3. Known false-positive cases
#    None in shipped code. The src/test tree, docs/, and root .md are all
#    IN scope: test describe/it titles, doc-content assertions, and ADR
#    cross-references all spell the word "section" rather than the glyph,
#    so there is no doc-coupled surface left to carve out. The default mode
#    runs `git grep --untracked`, so new-but-uncommitted files are in scope
#    (a violation fails the gate before it lands, not after). Gitignored files
#    stay out, so a glyph in a local coordination note (AGENT_WORKSPACE.md,
#    workspace-notes/, both gitignored) cannot fail the gate.
#    Binary files are skipped via the -I flag: gitignored binaries that
#    macOS Finder scatters through scanned dirs (notably .DS_Store) can
#    carry a raw 0xA7 byte and would otherwise false-fail the gate; -I
#    treats them as non-matching so only text source is searched.
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

if [ "$#" -eq 0 ]; then
  # Default (the real gate): `--untracked` puts tracked AND new-but-uncommitted
  # files in scope, so a violation in a freshly-added file fails the gate before
  # it is committed. Gitignored paths stay out (git grep never searches those),
  # so local coordination scratch (AGENT_WORKSPACE.md, workspace-notes/, both
  # gitignored) is still excluded by construction.
  hits=$(git grep --untracked -nFI "$GLYPH" -- src test scripts docs '*.md' 2>/dev/null || true)
else
  # Explicit paths (companion-spec fixtures live in temp, non-git dirs):
  # plain recursive text scan.
  hits=$(grep -rnI "$GLYPH" "$@" 2>/dev/null || true)
fi

if [ -n "$hits" ]; then
  echo "section-symbol guard FAILED — the U+00A7 glyph is banned across source, tests, scripts, and docs." >&2
  echo "  Write the word \"section\" instead (e.g. \"ADR-009 section 6\"). Offending lines:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "section-symbol guard OK (no U+00A7 glyph in source, tests, scripts, or docs)."
