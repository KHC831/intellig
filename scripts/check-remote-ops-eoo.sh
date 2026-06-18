#!/usr/bin/env bash
#
# Structural CI guard — argv-injection on remote-network git ops.
#
# Maintenance contract (per ADR-007 section "Guard maintenance contract"):
#
# 1. Bug class
#    Argv injection through a user-controlled remote / branch / refspec
#    name on the three network subcommands (`fetch`, `pull`, `push`).
#    A remote name comes from `.git/config`, which a cloned or hostile
#    repository authors; the auto-fetch loop runs `fetch` unattended.
#    A name like `--upload-pack=touch /tmp/pwned` pushed onto the argv
#    as a bare positional lands as a git flag and executes arbitrary
#    commands. The fix is uniform: assemble flags and user-controlled
#    refs separately and route them through `buildGitArgs(<cmd>, flags,
#    refs)` (src/git-core/gitCli.ts), which splices `--end-of-options`
#    ahead of the refs so they can never be parsed as flags.
#
#    A prior revision of `RemoteOps.fetch` regressed this by pushing the
#    remote name with a bare `args.push(options.remote)`; this guard
#    locks the fix so the regression cannot silently return.
#
# 2. Heuristic + how it scales
#    For each network subcommand, assert RemoteOps.ts contains a
#    `buildGitArgs('<cmd>'` call. If a future edit reverts a command to
#    a hand-rolled `args.push(...)` array, the buildGitArgs call for that
#    command disappears and this guard fails. Adding a new network
#    subcommand is a one-line addition to NET_CMDS.
#
# 3. Known false-positive cases
#    None expected — the assertion is presence of a single well-known
#    call per command. A legitimate refactor that renames buildGitArgs
#    would require updating this guard, which is the intended review gate.
#
# 4. Known false-negative cases
#    The guard checks for the call's presence, not that the *user ref*
#    actually flows into it. A contributor could call buildGitArgs with
#    an empty ref list and still push a ref positionally elsewhere. That
#    deeper invariant is pinned by gitArgInjection.property.test.ts and
#    fetchArgInjection.test.ts (which assert --end-of-options precedes
#    the user ref). This grep is the cheap structural backstop.
#
# 5. Retirement criteria
#    Retire when a typed wrapper makes raw positional refs unreachable
#    from the network ops by construction.
#
# Exit: 0 on clean, 1 if any network subcommand lacks its buildGitArgs route.

set -euo pipefail

OPS_FILE="src/git-core/ops/RemoteOps.ts"
NET_CMDS=("fetch" "pull" "push")

if [ ! -f "$OPS_FILE" ]; then
  echo "remote-ops argv guard FAILED — $OPS_FILE not found." >&2
  exit 1
fi

missing=0
for cmd in "${NET_CMDS[@]}"; do
  if ! grep -qE "buildGitArgs\([[:space:]]*'${cmd}'" "$OPS_FILE"; then
    echo "remote-ops argv guard FAILED — '${cmd}' does not route through buildGitArgs in ${OPS_FILE}." >&2
    echo "  Network subcommands MUST assemble user-controlled refs via" >&2
    echo "  buildGitArgs('${cmd}', flags, refs) so --end-of-options is spliced" >&2
    echo "  ahead of the refs (argv-injection defense). A bare" >&2
    echo "  args.push(options.remote) regresses this — see the script header." >&2
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  exit 1
fi

echo "remote-ops argv guard OK (fetch/pull/push all route through buildGitArgs)."
