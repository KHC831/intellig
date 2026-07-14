#!/usr/bin/env bash
#
# Structural CI guard — `.git`-relative paths are built through the
# worktree-aware gitdir resolver, never by joining a literal `.git` onto
# a repo root.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    In a LINKED WORKTREE (and a submodule) `<root>/.git` is a pointer
#    FILE, not a directory. `path.join(root, '.git', <marker>)` therefore
#    reads/writes a path INSIDE a file: state probes read false (a live
#    rebase/merge is invisible, hiding continue/abort affordances) and
#    writes throw ENOTDIR (interactive rebase/squash dead). RebaseService
#    and the rebase-todo exec line shipped exactly this while
#    GitService/conflicts/shelf/changelists already resolved the gitdir.
#    The two resolvers own the ONE correct `.git` join:
#      - resolveWorktreeGitDir  (sync)  — repo/RepositoryDiscovery.ts
#      - resolveGitDir          (async) — gitDirMarkers.ts
#    Every other module must route `.git` access through them.
#
# 2. Heuristic + how it scales
#    Fail on either dangerous shape under git-tracked `src/`, outside the
#    two resolver modules:
#      - a `path.join(…, '.git'…)` literal join, or
#      - a relative `.git/<…>` path baked into a string/exec line.
#    Comment lines (prose references — this file's own class notes, the
#    resolver docstrings) are skipped. A justified exception marks the
#    line `git-dir-resolve-exempt: <reason>`. O(files); always small.
#
# 3. Known false-positive cases
#    - The `'**/.git'` new-repo watcher glob (GitService) and the `.git`
#      ignored-folder NAME in repoScan are not path builds: neither has a
#      quoted `'.git'` join arg nor a trailing `.git/`, so neither matches.
#    - A future legitimate literal join can be marked with the exempt
#      comment.
#
# 4. Known false-negative cases
#    - A `.git` path assembled via string concatenation or a variable
#      segment (`root + '/.git'`) evades both patterns. The codebase uses
#      path.join throughout; add a pattern if that idiom appears.
#
# 5. Retirement criteria
#    Retire if the two resolvers are collapsed into a single lint-enforced
#    accessor that structurally cannot be bypassed.

set -euo pipefail
cd "$(dirname "$0")/.."

# The resolver modules that legitimately hold the `.git` join.
RESOLVERS='src/git-core/repo/RepositoryDiscovery.ts|src/git-core/gitDirMarkers.ts'

matches=$(git grep --untracked -nE "(\.join\([^)]*['\"]\.git['\"]|['\" ]\.git/)" -- 'src/**/*.ts' \
  | grep -vE "^($RESOLVERS):" \
  | grep -vE ':[0-9]+: *(\*|//|/\*)' \
  | grep -v 'git-dir-resolve-exempt:' || true)

if [ -n "$matches" ]; then
  echo "check-git-dir-resolved: a '.git'-relative path is built outside the"
  echo "gitdir resolver. In a linked worktree <root>/.git is a FILE, so a"
  echo "literal join reads/writes inside a file (ENOTDIR / invisible state)."
  echo "Route through resolveWorktreeGitDir (repo/RepositoryDiscovery.ts) or"
  echo "resolveGitDir (gitDirMarkers.ts), or mark the line"
  echo "'git-dir-resolve-exempt: <reason>'."
  echo
  echo "$matches"
  exit 1
fi

echo "check-git-dir-resolved: OK"
