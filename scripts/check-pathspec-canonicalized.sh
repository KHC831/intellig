#!/usr/bin/env bash
#
# Structural CI guard — git pathspecs must be derived through repoRelativePath,
# never a raw `path.relative(...)`.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    A git command runs with `cwd = repo.rootUri.fsPath`, so any file
#    argument must be REPO-root-relative. Deriving that with a raw
#    `path.relative(repo.rootUri.fsPath, <uri>.fsPath)` is wrong on a
#    symlinked checkout: `getRepository` reports a realpath-CANONICALIZED
#    root (macOS `/var` -> `/private/var`, from `git rev-parse
#    --show-toplevel`) while the editor / working-tree URI keeps the
#    symlink. `path.relative` between the two divergent resolution states
#    returns an escaping `../...` pathspec, so git blames / reads / stages a
#    bogus path (the conflict-staging case silently fails to `git add` the
#    resolved file). The fix is uniform: route through
#    `repoRelativePath(repoRootFsPath, fileFsPath)` (src/utils/repoRelativePath.ts),
#    which canonicalizes BOTH ends with `fs.realpathSync.native` and returns a
#    POSIX-separated repo-root-relative path. Six sites carried this bug
#    (blame editor/menu, inline + gutter blame, changed-line HEAD read,
#    conflict staging); this guard locks the fix so it cannot silently return.
#
# 2. Heuristic + how it scales
#    Fail on the presence of any real `path.relative(` CALL under `src/`
#    (the `src/test` subtree is out of scope — fixtures legitimately compose
#    paths). Prose mentions of the API in comments carry no `(` and so never
#    match. A line carrying the opt-out marker `pathspec-guard-allow` is
#    skipped: the only sanctioned raw `path.relative` calls are the two
#    CONTAINMENT `..`-checks in RepositoryDiscovery.ts (is-this-path-inside-
#    that-root), which compute a topology relationship, not a git argument —
#    both are marked. Any NEW raw `path.relative(` (no marker) fails the
#    gate, which is the intended review gate: either it is a git pathspec
#    (use repoRelativePath) or another containment check (add the marker
#    with a justification). The guard runs in two modes:
#      * DEFAULT (no path args — the real gate): `git grep --untracked` over
#        tracked AND new-but-uncommitted files under `src`, excluding
#        `src/test`. Gitignored scratch is still never scanned.
#      * EXPLICIT PATHS (used by the companion spec): plain recursive
#        `grep -rnIE` over the given paths (fixtures live in temp, non-git
#        dirs, so git-based scanning cannot apply there).
#
# 3. Known false-positive cases
#    A future legitimate non-pathspec `path.relative(` (e.g. another
#    containment check) trips the gate until the author adds the
#    `pathspec-guard-allow` marker with a one-line justification — the
#    intended review touchpoint, not a defect.
#
# 4. Known false-negative cases
#    Only the literal `path.relative(` API is banned. A pathspec derived a
#    different wrong way is not matched here:
#      * `vscode.workspace.asRelativePath(<uri>)` fed to a git arg is
#        WORKSPACE-FOLDER-relative (wrong for nested / multi-root repos).
#        It has legitimate display-only uses, so it cannot be banned
#        wholesale by grep without false-positives; that class is pinned by
#        contextMenuRepoResolution.guard.test.ts instead.
#      * A relative path computed by hand (string sl. slicing,
#        `uri.fsPath.replace(root, '')`) is not matched.
#    These deeper invariants are covered by the nested-repo e2e suites and
#    the symlink-canonicalization unit tests; this grep is the cheap
#    structural backstop for the exact `path.relative` regression.
#
# 5. Retirement criteria
#    Retire when a typed RepoRelativePath value (branded string produced only
#    by repoRelativePath) makes a raw `path.relative` pathspec unrepresentable
#    by construction.
#
# Exit: 0 on clean, 1 if any unmarked raw `path.relative(` call is found.
#
# Manual repro of the red:
#   echo 'const r = path.relative(repo.rootUri.fsPath, uri.fsPath);' > /tmp/x.ts
#   bash scripts/check-pathspec-canonicalized.sh /tmp/x.ts   # exits 1

set -euo pipefail

# A real `path.relative(` call, not a longer identifier ending in `path`
# (e.g. `pathImpl.relative`) and not a paren-less prose mention.
PATTERN='(^|[^A-Za-z0-9_])path\.relative[[:space:]]*\('
MARKER='pathspec-guard-allow'

if [ "$#" -eq 0 ]; then
  raw=$(git grep --untracked -nIE "$PATTERN" -- 'src' ':!src/test' 2>/dev/null || true)
else
  raw=$(grep -rnIE --include='*.ts' "$PATTERN" "$@" 2>/dev/null || true)
fi

# Drop the allow-listed containment-check lines.
if [ -n "$raw" ]; then
  hits=$(grep -vF "$MARKER" <<<"$raw" || true)
else
  hits=""
fi

if [ -n "$hits" ]; then
  echo "pathspec-canonicalized guard FAILED — raw path.relative(...) used for a git pathspec." >&2
  echo "  git runs with cwd = repo.rootUri.fsPath; derive the repo-relative path with" >&2
  echo "  repoRelativePath(repo.rootUri.fsPath, fileFsPath) (src/utils/repoRelativePath.ts)," >&2
  echo "  which canonicalizes both ends so a symlinked checkout does not yield an escaping" >&2
  echo "  '../' pathspec. If this is a containment check (not a git arg), append the marker" >&2
  echo "  '// ${MARKER}: <why>' to the line. Offending lines:" >&2
  echo "$hits" >&2
  exit 1
fi

echo "pathspec-canonicalized guard OK (no raw path.relative pathspec derivation)."
