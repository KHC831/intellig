#!/usr/bin/env bash
#
# Structural CI guard — repo-relative paths come from repoRelativePath, never
# a string `.replace(<root>...)` strip.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Deriving a repo-relative path by string-replacing the repo root out of
#    an fsPath (`fileUri.fsPath.replace(repoRoot + '/', '')`) is wrong three
#    ways: `String.replace` with a string pattern replaces the FIRST
#    occurrence anywhere (a path that repeats the root segment mangles), the
#    match is not anchored to the start, and neither end is symlink-
#    canonicalized (macOS `/var` -> `/private/var` leaves the path absolute,
#    so the downstream git op targets the wrong key). The shared
#    `repoRelativePath(repoRootFsPath, fileFsPath)`
#    (src/utils/repoRelativePath.ts) exists precisely for this; the sibling
#    guard check-pathspec-canonicalized.sh bans raw `path.relative(` but
#    missed this string-replace variant, which is how the class re-entered
#    once (markFileResolved). This guard closes the variant.
#
# 2. Heuristic + how it scales
#    Fail on `.replace(` whose first argument mentions a root-ish
#    identifier (`repoRoot`, `rootUri.fsPath`, `rootFsPath`) under
#    git-tracked `src/`. Path derivations must route through
#    repoRelativePath; anything else marks the line
#    `path-replace-exempt: <reason>`.
#
# 3. Known false-positive cases
#    A non-path string transformation that happens to name a variable
#    `repoRoot` would match; mark it `path-replace-exempt:` with the
#    justification. None exist today.

set -euo pipefail
cd "$(dirname "$0")/.."

matches=$(git grep -nE '\.replace\((repoRoot|rootFsPath|[A-Za-z_$][A-Za-z0-9_$]*\.rootUri\.fsPath)' -- 'src/**/*.ts' \
  | grep -v 'path-replace-exempt:' || true)

if [ -n "$matches" ]; then
  echo "check-anchored-repo-paths: string-replacing the repo root out of a path"
  echo "is unanchored and skips symlink canonicalization. Use"
  echo "repoRelativePath(repo.rootUri.fsPath, fileFsPath)"
  echo "(src/utils/repoRelativePath.ts), or mark the line"
  echo "'path-replace-exempt: <reason>' if it is not a path derivation."
  echo
  echo "$matches"
  exit 1
fi

echo "check-anchored-repo-paths: OK"
