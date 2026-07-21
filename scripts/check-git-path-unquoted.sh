#!/usr/bin/env bash
#
# Structural CI guard — a path read back from git output must survive git's
# own quoting, either by asking for NUL-delimited output (`-z`) or by
# decoding the C-quoted token through `unquoteCStylePath`.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    git does not hand back raw path bytes. A name carrying whitespace is
#    printed bare (so a whitespace-delimited `(\S+)` capture splits it), and
#    a name carrying non-ASCII bytes or a double quote is printed C-quoted
#    ("caf\303\251 q.txt"). Sites that grabbed a `(\S+)` token out of a
#    `diff --git` header FUSED two distinct files onto one name, and sites
#    that split `--name-only` / `ls-tree` output on newlines surfaced the
#    literal escaped spelling to the user — one of them feeding the
#    restore-to-HEAD writer, i.e. a delete of the wrong path. The class fix
#    is the ordered header cascade in PatchService (git4idea GitPatchParser
#    parity), the exported `unquoteCStylePath` decoder in gitParser, and
#    `-z` on every path-listing git invocation. This guard stops a new site
#    from re-introducing either half.
#
# 2. Heuristic + how it scales
#    Fail a non-comment line that either:
#      (a) carries a whitespace-token capture group (`(\S+)`, `(\S*)`, or the
#          `([^\s]…)` spelling) alongside a git path-output PROSE fragment on
#          the same line (diff --git, Checking patch, Applied patch, patching
#          file); or
#      (b) invokes git with a path-LISTING subcommand or flag without `-z`.
#          Covered: `--name-only`, `--name-status`, `--numstat`,
#          `--porcelain`, `ls-tree`, `ls-files`, `diff-tree` — every one emits
#          C-quoted paths for names with non-ASCII bytes or a double quote,
#          and bare (space-splittable) names otherwise.
#    The `-z` for (b) is looked up over the WHOLE enclosing `[ … ]` argv
#    literal, not just the flag's own physical line, so a prettier-wrapped
#    element-per-line array whose `-z` sits on a sibling line still passes —
#    and one that genuinely omits `-z` still fails. `ls-tree` / `--name-only`
#    are (b) subcommands only: a capture co-located with them is already
#    caught by (b), so listing them under (a) too would be an untestable
#    duplicate (no fixture can isolate the (a) reading), and they are not.
#    Comment-only lines are skipped so the prose in a docblock stays free.
#    Scope: git-tracked (and new) TS under src/. Escape hatch:
#    `// git-path-quote-exempt: <reason>` on the same or preceding line —
#    sanctioned where the captured token is provably NOT a path (a ref name
#    from `name-rev --name-only`), where the output is tested only for
#    emptiness and never parsed, or for the deliberate last-resort
#    whitespace-token pattern that upstream also keeps as its final cascade
#    arm.
#    Two modes: DEFAULT (no args) over the tracked tree; EXPLICIT PATHS
#    (companion spec) over the given dirs, so fixtures exercise the teeth.
#
# 3. Known false-positive cases
#    `name-rev --name-only` yields a REF name, never a path, and a
#    `--name-only` run whose output is only length-checked carries no path
#    to mis-decode. Both trip the gate until marked — the intended review
#    touchpoint. `--porcelain` is the widest of the newly-covered set: it
#    also names commands whose porcelain carries no path this class can
#    corrupt. Three are marked today, each measured rather than assumed:
#    `blame --porcelain` (twice) DOES C-quote its `filename` line, but that
#    line is never read — only hunks and commit metadata are; and
#    `worktree list --porcelain` prints worktree paths verbatim, spaces and
#    non-ASCII included. `diff --numstat` DOES quote, and its one site reads
#    only the byte-count columns. All are marked, not excluded: a future site
#    that starts parsing the path must delete the marker to pass review.
#
# 4. Known false-negative cases
#    Accepted gaps, not oversights:
#      - flags held in a variable (`const args = ['ls-files', '-z']`) are
#        judged on the DECLARATION line, so the guard verdict is right but
#        the reported line is not the invocation;
#      - a path capture using a shape other than the recognised whitespace
#        tokens (a split on whitespace, `.split(/\s+/)`, a named group) is
#        not recognised;
#      - a `-z` run whose output is then split on '\n' rather than '\0'
#        passes, since only the invocation is inspected;
#      - the enclosing-array `-z` lookup counts `[`/`]` naively, so an
#        unbalanced bracket inside a STRING literal on a nearby line can widen
#        or narrow the scanned span; balanced `[...]` on a line nets zero, so
#        ordinary indexing and type annotations do not perturb it;
#      - `diff --raw`, `diff --summary`, `whatchanged` and `check-ignore`
#        also emit quoted paths and are NOT covered. None is used in this
#        tree today — but "uncovered" and "unused" are separate claims, and
#        only the second is checked by anything, so treat this list as
#        stale until re-measured. Add to the pattern when one lands.
#    Review is the backstop for all of the above.
#
# 5. Retirement criteria
#    Retire if every git invocation routes through a typed argv builder that
#    makes `-z` structurally mandatory for path-listing subcommands, so the
#    wrong call can no longer be written.
#
# Exit: 0 on clean, 1 if any unmarked unsafe path read is found.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ "$#" -eq 0 ]; then
  files=$(git ls-files --cached --others --exclude-standard -- 'src/**/*.ts' || true)
else
  files=$(find "$@" -name '*.ts' -type f 2>/dev/null || true)
fi

fail=0
for f in $files; do
  hits=$(awk '
    # Phase 1: buffer every line and its net [ ] bracket delta.
    {
      L[FNR] = $0
      t = $0; opens = gsub(/\[/, "[", t)
      u = $0; closes = gsub(/\]/, "]", u)
      delta[FNR] = opens - closes
      n = FNR
    }
    END {
      # depthBefore[i] = count of unclosed "[" entering line i.
      d = 0
      for (i = 1; i <= n; i++) { depthBefore[i] = d; d += delta[i] }

      for (i = 1; i <= n; i++) {
        line = L[i]
        stripped = line
        sub(/^[ \t]*/, "", stripped)
        is_comment = (stripped ~ /^\/\// || stripped ~ /^\*/ || stripped ~ /^\/\*/)
        exempt = (line ~ /git-path-quote-exempt:/ || (i > 1 && L[i-1] ~ /git-path-quote-exempt:/))

        # (a) whitespace-token capture over git path-output prose.
        token_capture = (line ~ /\(\\S[+*]|\(\[\^\\s\]/)
        path_context = (line ~ /diff --git|Checking patch|Applied patch|patching file/)
        bad_capture = (token_capture && path_context)

        # (b) path-listing invocation without NUL delimiting, -z looked up
        # over the whole enclosing [ ... ] argv literal.
        lists_paths = (line ~ /--name-only|--name-status|--numstat|--porcelain|.ls-tree.|.ls-files.|.diff-tree./)
        has_z = (line ~ /'"'"'-z'"'"'|"-z"|[ =]-z[ ,)]/)
        if (lists_paths && !has_z && depthBefore[i] > 0) {
          lo = i
          while (lo > 1 && depthBefore[lo] > 0) lo--
          hi = i
          while (hi < n && (depthBefore[hi] + delta[hi]) > 0) hi++
          for (j = lo; j <= hi; j++) {
            if (L[j] ~ /'"'"'-z'"'"'|"-z"|[ =]-z[ ,)]/) { has_z = 1; break }
          }
        }
        bad_listing = (lists_paths && !has_z)

        if (!is_comment && !exempt && (bad_capture || bad_listing)) {
          printf "%s:%d: %s\n", FILENAME, i, line
        }
      }
    }
  ' "$f")
  if [ -n "$hits" ]; then
    if [ "$fail" -eq 0 ]; then
      echo "check-git-path-unquoted: a path is read back from git output without"
      echo "surviving git's quoting. Ask for NUL-delimited output ('-z') and split"
      echo "on '\\0', or decode the C-quoted token through unquoteCStylePath"
      echo "(src/git-core/gitParser.ts). If the token is provably not a path, or"
      echo "the output is never parsed, justify with"
      echo "'// git-path-quote-exempt: <reason>' on the same or preceding line."
      echo
      fail=1
    fi
    echo "$hits"
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-git-path-unquoted: OK"
