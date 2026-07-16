#!/usr/bin/env bash
#
# Structural CI guard — English git-prose matching lives ONLY in
# src/git-core/gitProse.ts, the module whose header carries the locale
# contract that makes prose matching safe.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Several sites classified git output by matching ENGLISH message prose
#    ("CONFLICT", "needs merge", "would be overwritten", the untracked-
#    overwrite file list). git localizes those messages; on a non-English
#    system every heuristic silently missed and the resolve dialog never
#    opened. The class fix pins the locale at the single spawn seam
#    (gitCli._spawnOnce: LC_ALL=en_US.UTF-8 + LANGUAGE=""; git4idea
#    VcsLocaleHelper parity) and centralises every prose predicate in
#    src/git-core/gitProse.ts so the locale dependency has one visible home.
#    A NEW hand-rolled prose match elsewhere would re-scatter the class and
#    hide its locale assumption; this guard forces it into the module (or
#    an explicit justification).
#
# 2. Heuristic + how it scales
#    Fail on a line that BOTH (a) calls `.includes(` / `.test(` / `.match(`
#    and (b) carries a known git-prose fragment (case-insensitive) INSIDE a
#    string or regex literal (an opening `'`/`"`/`` ` ``/`/` precedes the
#    fragment with no closer between — identifiers like
#    RESOLVE_CONFLICTS_DIALOG_… stay out): conflict, needs merge, would be
#    overwritten, please commit your changes, untracked working tree, patch
#    does not apply, patch failed. Both matching shapes are covered: the
#    fragment as the call argument (`.includes('…')`) and as a
#    regex-literal receiver (`/…/.test(x)`).
#    Comment-only lines are skipped. Scope: git-tracked (and new) TS under
#    src/, excluding the sanctioned module. Escape hatch:
#    `// git-prose-exempt: <reason>` on the same or preceding line —
#    sanctioned where the matched text is provably NOT git output (e.g. our
#    own toast copy in a webview bridge).
#    Two modes: DEFAULT (no args) over the tracked tree; EXPLICIT PATHS
#    (companion spec) over the given dirs, where every file is treated as
#    non-sanctioned so fixtures exercise the teeth.
#
# 3. Known false-positive cases
#    A `.includes('conflict')` over NON-git text (CSS class names, UI state
#    strings) trips the gate until the author adds the exempt marker — the
#    intended review touchpoint. None exist today.
#
# 4. Known false-negative cases
#    A fragment split across lines, a phrase list held in a variable and
#    spread into the call, or a novel git phrase outside the fragment set
#    slips the literal patterns. Review is the backstop; extend the fragment
#    list when a new detector class lands in gitProse.ts.
#
# 5. Retirement criteria
#    Retire if git output classification moves entirely onto structural
#    channels (porcelain codes, marker files, exit codes), or if an eslint
#    no-restricted-syntax rule takes over the pattern.
#
# Exit: 0 on clean, 1 if any unmarked prose match is found outside gitProse.ts.

set -euo pipefail
cd "$(dirname "$0")/.."

SANCTIONED='src/git-core/gitProse.ts'

if [ "$#" -eq 0 ]; then
  files=$(git ls-files --cached --others --exclude-standard -- 'src/**/*.ts' \
    | grep -v "^${SANCTIONED}$" || true)
else
  files=$(find "$@" -name '*.ts' -type f 2>/dev/null || true)
fi

# Fragment must appear inside a string/regex literal: an opening quote or
# slash precedes it with no closer between. Passed via ENVIRON so the
# character class survives awk -v backslash processing.
LITFRAG="['\"\`/][^'\"\`/]*(conflict|needs merge|would be overwritten|please commit your changes|untracked working tree|patch does not apply|patch failed)"
export LITFRAG

fail=0
for f in $files; do
  hits=$(awk '
    {
      line = $0
      lower = tolower(line)
      stripped = line
      sub(/^[ \t]*/, "", stripped)
      is_comment = (stripped ~ /^\/\// || stripped ~ /^\*/)
      calls = (line ~ /\.(includes|test|match)\(/)
      if (!is_comment && calls && lower ~ ENVIRON["LITFRAG"] \
          && line !~ /git-prose-exempt:/ && prev !~ /git-prose-exempt:/) {
        printf "%s:%d: %s\n", FILENAME, FNR, line
      }
      prev = line
    }
  ' "$f")
  if [ -n "$hits" ]; then
    if [ "$fail" -eq 0 ]; then
      echo "check-git-prose-matching: git output classified by English prose outside"
      echo "src/git-core/gitProse.ts. Prose matching is only safe under the locale"
      echo "pin (gitCli LC_ALL/LANGUAGE); add the predicate to gitProse.ts, or if"
      echo "the matched text is provably NOT git output, justify with"
      echo "'// git-prose-exempt: <reason>' on the same or preceding line."
      echo
      fail=1
    fi
    echo "$hits"
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-git-prose-matching: OK"
