#!/usr/bin/env bash
#
# Structural CI guard — argv injection through a leading repo-controlled
# rev/range on a raw `gitCli.exec([...])` for a ref-taking subcommand.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    git parses any positional token that begins with `--` as a FLAG. A
#    ref-taking subcommand (`diff`, `log`, `show`, `rev-list`, ...) whose
#    LEADING positional is a repo-controlled ref / range — a branch or tag
#    name, which a cloned or hostile repository authors — can therefore be
#    weaponized: a branch literally named `--output=/tmp/pwned` passed as the
#    leading token of `git diff` writes an attacker-chosen file outside the
#    repo. This is the exact class fixed in BranchComparisonView, whose
#    `exec(['diff', `${branch1}...${branch2}`, '--', filePath])` spliced the
#    repo-controlled range as the leading token with no `--end-of-options`.
#    The uniform fix is `buildGitArgs(subcommand, flags, refs, paths)`
#    (src/git-core/gitCli.ts), which inserts `--end-of-options` BEFORE the
#    refs so they can never be parsed as flags. This guard locks that fix so
#    a raw bare-exec reintroduction cannot silently return.
#
# 2. Heuristic + how it scales
#    Fail on the narrow, high-confidence pattern of the regression:
#      `.exec([ '<ref-cmd>' , `${...`
#    i.e. a `.exec([` array whose FIRST element is a ref-taking subcommand
#    string literal and whose SECOND element (the leading positional) is a
#    template literal that STARTS with an interpolation (`` `${ ``) — a
#    repo-controlled value with no literal prefix to stop it being read as a
#    flag. The safe sinks do not match by construction:
#      * buildGitArgs('diff', [], [`${range}`], [path]) — not a `.exec([`
#        literal array; the range rides behind `--end-of-options`.
#      * exec(['diff', '--name-only', `${a}..${b}`]) — leading positional is
#        a FLAG literal, not the template (and the hashes are hex-validated).
#      * exec(['show', `:${stage}:${path}`]) / exec(['show', `HEAD:${p}`]) /
#        exec(['rev-parse', `stash@{${i}}`]) — the template has a literal
#        prefix (`:` / `HEAD:` / `stash@{`), so it can never begin with `--`.
#    A line carrying the opt-out marker `argv-guard-allow` is skipped (for a
#    leading-interp ref proven safe upstream — none today). Adding a
#    ref-taking subcommand to watch is a one-token edit to REF_CMDS. The
#    guard runs in two modes (DEFAULT git-grep over tracked `src` minus
#    `src/test`; EXPLICIT `grep -rnIE` for the companion spec's temp
#    fixtures), mirroring check-no-section-symbol.sh.
#
# 3. Known false-positive cases
#    A leading-interpolation ref that is provably safe because its value is
#    validated upstream (e.g. hex-only) would still match; mark such a line
#    `// argv-guard-allow: <why>`. None exist today — the hex-validated
#    CommitContextMenuCommands sinks pass the ref as a plain identifier or
#    behind a flag, not as a leading `` `${ `` template, so they do not match.
#
# 4. Known false-negative cases
#    The pattern is deliberately narrow to keep false-positives at zero:
#      * A leading ref passed as a plain IDENTIFIER (`exec(['diff', range])`,
#        where `range` was built elsewhere) is not matched.
#      * A `.exec([...])` split across multiple lines (subcommand and ref on
#        different lines) is not matched.
#      * A ref-taking subcommand outside REF_CMDS is not matched.
#      * A ref routed through a git-exec WRAPPER is not matched: the pattern
#        anchors on `.exec([`, so a helper whose body calls `exec(args)` with
#        a variable `args` hides the array literal from this grep. The live
#        example to watch is `ResolveConflictsDialog._execGit(args)`
#        (src/conflicts/ResolveConflictsDialog.ts) — its callers today are all
#        safe (non-ref-cmd, flag/HEAD-leading), but a future
#        `this._execGit(['diff', `${range}`, '--', f])` would reintroduce the
#        leading-rev vuln UNCAUGHT here. Broadening the regex to every wrapper
#        name over-fits (a new wrapper is invisible until named), so the
#        invariant for wrapped calls is pinned by gitArgInjection.property.test.ts
#        and the per-sink driving tests, not by this grep.
#    The deeper invariant — that a user ref never lands in a flag position —
#    is pinned by gitArgInjection.property.test.ts and the per-sink driving
#    tests (e.g. branchComparisonView.test.ts drives the sink with a
#    `--output=` branch and asserts `--end-of-options` precedes it). This
#    grep is the cheap structural backstop for the leading-template
#    regression shape.
#
# 5. Retirement criteria
#    Retire when a typed Ref/Range value (constructible only via buildGitArgs)
#    makes a raw leading-rev `.exec([...])` unrepresentable by construction.
#
# Exit: 0 on clean, 1 if any unmarked leading-rev bare-exec is found.
#
# Manual repro of the red:
#   printf '%s\n' "await c.exec(['diff', \`\${b1}...\${b2}\`, '--', f]);" > /tmp/x.ts
#   bash scripts/check-exec-leading-rev-eoo.sh /tmp/x.ts   # exits 1

set -euo pipefail

# Ref-taking subcommands whose leading positional can be a rev/range that
# must never be parseable as a flag.
REF_CMDS='diff|log|show|rev-list|shortlog|whatchanged|range-diff|cherry|blame|format-patch|describe|merge-base|rev-parse|cherry-pick'

# `.exec([ '<ref-cmd>' , `${  ` — a ref subcommand immediately followed by a
# leading-interpolation template literal (no literal prefix).
PATTERN="\.exec\(\[[[:space:]]*['\"](${REF_CMDS})['\"][[:space:]]*,[[:space:]]*\`\\\$\{"
MARKER='argv-guard-allow'

if [ "$#" -eq 0 ]; then
  raw=$(git grep -nIE "$PATTERN" -- 'src' ':!src/test' 2>/dev/null || true)
else
  raw=$(grep -rnIE --include='*.ts' "$PATTERN" "$@" 2>/dev/null || true)
fi

if [ -n "$raw" ]; then
  hits=$(grep -vF "$MARKER" <<<"$raw" || true)
else
  hits=""
fi

if [ -n "$hits" ]; then
  echo "exec-leading-rev guard FAILED — a repo-controlled rev/range is the LEADING token of a raw gitCli.exec([...])." >&2
  echo "  git reads a positional that begins with '--' as a flag, so a branch named" >&2
  echo "  '--output=/tmp/pwned' would execute as a flag. Route the ref through" >&2
  echo "  buildGitArgs('<cmd>', flags, refs, paths) (src/git-core/gitCli.ts) so" >&2
  echo "  --end-of-options is spliced ahead of the refs. Offending lines:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "exec-leading-rev guard OK (no leading repo-controlled rev/range on a raw exec)."
