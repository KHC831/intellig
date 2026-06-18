#!/usr/bin/env bash
# ============================================================
# with-real-node-modules.sh — run a command with a REAL node_modules
# even when the repo's node_modules is a symlink.
#
# Usage: with-real-node-modules.sh <command> [args...]
#   Operates on `./node_modules` in the current working directory.
#
# Why this exists:
#   In a `git worktree`, node_modules is commonly a symlink to the
#   primary checkout's install (to avoid a second multi-hundred-MB
#   install). `vsce ls`/`vsce package` run
#   `npm list --production --depth=99999` to compute the dependency
#   files to bundle. npm rejects a SYMLINKED node_modules root: it
#   cannot reconcile the symlink-target tree against the worktree's
#   manifest, so every dependency is reported `extraneous`
#   (ELSPROBLEMS) and npm — and therefore vsce — exits non-zero. The
#   net effect is that the vsix structural guards cannot run in a
#   worktree, which has historically led to those lanes being skipped
#   as "symlink noise" — exactly the blind spot a packaging guard is
#   meant to close.
#
# What it does:
#   If `./node_modules` is a symlink, materialise a copy-on-write
#   clone of its target as a real `./node_modules`, run the command so
#   npm reconciles the install natively (identical listing to a fresh
#   `npm install`), then restore the original symlink. APFS
#   (`cp -c`) and reflink-capable filesystems (`cp --reflink=auto`)
#   make the clone near-instant and near-zero-space; a plain copy is
#   the portable fallback.
#
# Safety:
#   - The swap is guarded by an atomic mkdir-based lock so two
#     concurrent runs in the same worktree serialise instead of
#     racing (portable; `flock` is absent on macOS). A lock left by a
#     dead owner is reclaimed via a PID-liveness check.
#   - The original symlink is moved aside to a backup that survives the
#     whole run; signal traps (INT/TERM/HUP) and the EXIT trap restore
#     it even if the wrapped command is interrupted.
#   - On a hard kill (SIGKILL/power loss) no trap runs, leaving a
#     detached clone plus an orphaned `node_modules.link.*` backup. The
#     NEXT run detects that fingerprint at startup and self-heals
#     (restores the symlink, discards the stale clone) before doing
#     anything else, so a worktree never silently scans a stale clone
#     or loses its symlink permanently.
#
# Fidelity (why this does NOT weaken the guard):
#   The clone is a byte-for-byte copy of the real install (inner
#   symlinks preserved as symlinks across every copy strategy), so the
#   wrapped `vsce ls` listing — including production dependency files
#   that genuinely ship in the .vsix — is identical to what a native
#   checkout produces. Unlike `--no-dependencies`, nothing is dropped
#   from the scan. The wrapped command's exit code is propagated
#   verbatim, so a real packaging problem still fails the guard.
#
# In a normal checkout (real node_modules, or none) this is a
# transparent pass-through: the command runs unchanged.
# ============================================================

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "[with-real-node-modules] usage: with-real-node-modules.sh <command> [args...]" >&2
  exit 2
fi

NODE_MODULES="node_modules"
CLONE="${NODE_MODULES}.real.$$"     # this run's clone, swapped into place
LINK_BAK="${NODE_MODULES}.link.$$"  # this run's symlink backup
LOCK="${NODE_MODULES}.swap.lock"    # mkdir-based swap lock (a directory)

# True if any crashed-swap residue (a backup symlink or a stale clone)
# is present. A read-only glance used to decide whether the swap/lock
# machinery is needed at all. Globs that match nothing stay literal and
# fail the file tests, so this is safe under `set -u`.
residue_present() {
  local f
  for f in "${NODE_MODULES}".link.*; do
    [ -L "$f" ] && return 0
  done
  for f in "${NODE_MODULES}".real.*; do
    [ -e "$f" ] && return 0
  done
  return 1
}

# Fast path: a genuine real (or absent) node_modules with no residue —
# nothing to clone or restore. `exec` replaces this process so the
# command's exit code is returned verbatim. This is the normal-checkout
# behaviour, unchanged.
if [ ! -L "$NODE_MODULES" ] && ! residue_present; then
  exec "$@"
fi

# --- From here we may mutate node_modules: take the lock first. ---

acquire_lock() {
  local tries=0 owner
  while ! mkdir "$LOCK" 2>/dev/null; do
    # Reclaim a lock whose owner process is gone (crashed mid-swap).
    owner=""
    [ -f "$LOCK/pid" ] && owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$LOCK" 2>/dev/null || true
      continue
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt 300 ]; then # ~30s
      echo "[with-real-node-modules] ERROR: timed out waiting for the swap lock ($LOCK). If no other run is active, remove it and retry." >&2
      exit 1
    fi
    sleep 0.1
  done
  printf '%s\n' "$$" >"$LOCK/pid"
}

release_lock() {
  rm -rf "$LOCK" 2>/dev/null || true
}

# Restore THIS run's symlink (if the backup exists) and drop its clone.
# Idempotent: safe to call from both a signal trap and the EXIT trap.
restore_swap() {
  if [ -L "$LINK_BAK" ] || [ -e "$LINK_BAK" ]; then
    rm -rf "$NODE_MODULES" 2>/dev/null || true
    mv "$LINK_BAK" "$NODE_MODULES"
  fi
  rm -rf "$CLONE" 2>/dev/null || true
}

release_all() {
  restore_swap
  release_lock
}

# Self-heal residue from a prior run that was hard-killed before its
# trap could restore. Runs UNDER the lock, so any backup/clone it finds
# is necessarily orphaned (no live run owns it).
reconcile_crash() {
  if [ ! -L "$NODE_MODULES" ]; then
    local bak found=""
    for bak in "${NODE_MODULES}".link.*; do
      [ -L "$bak" ] || continue
      found="$bak"
      break
    done
    if [ -n "$found" ]; then
      echo "[with-real-node-modules] WARNING: a previous run was interrupted mid-swap; restoring the node_modules symlink from ${found} and discarding the stale clone." >&2
      rm -rf "$NODE_MODULES" 2>/dev/null || true
      mv "$found" "$NODE_MODULES"
    fi
  fi
  # Sweep any leftover clones/backups (not this run's).
  local f
  for f in "${NODE_MODULES}".real.*; do
    [ "$f" = "$CLONE" ] && continue
    [ -e "$f" ] && rm -rf "$f" 2>/dev/null || true
  done
  for f in "${NODE_MODULES}".link.*; do
    [ "$f" = "$LINK_BAK" ] && continue
    [ -L "$f" ] && rm -f "$f" 2>/dev/null || true
  done
}

# Copy-on-write where available, plain copy as the portable fallback.
# All three strategies copy inner symlinks AS symlinks (no `-L`): npm's
# hoisted-dep and `.bin` links are relative, so they stay valid in the
# clone and the listing matches a native install exactly.
clone_tree() {
  local src="$1" dst="$2"
  cp -Rc "$src" "$dst" 2>/dev/null && return 0                # macOS APFS clonefile
  cp -R --reflink=auto "$src" "$dst" 2>/dev/null && return 0  # GNU coreutils reflink
  cp -R "$src" "$dst"                                         # portable full copy
}

acquire_lock
trap 'release_all' EXIT
trap 'trap - EXIT; release_all; exit 130' INT
trap 'trap - EXIT; release_all; exit 143' TERM
trap 'trap - EXIT; release_all; exit 129' HUP

reconcile_crash

# Re-evaluate after reconciliation. If node_modules is a symlink, swap
# in a real clone; otherwise (a genuine real dir restored/recovered) run
# the command as-is.
if [ -L "$NODE_MODULES" ]; then
  # A dangling symlink can't be cloned — fail with a clear message
  # rather than a cryptic `cd`/`set -e` abort.
  if [ ! -e "$NODE_MODULES" ]; then
    echo "[with-real-node-modules] ERROR: node_modules is a dangling symlink (target missing: $(readlink "$NODE_MODULES" 2>/dev/null)). Re-create it (e.g. ln -s <checkout>/node_modules ./node_modules) or run npm install." >&2
    exit 1
  fi

  echo "[with-real-node-modules] node_modules is a symlink; cloning the target into a real node_modules so npm/vsce can reconcile the install (restored afterwards)." >&2

  REAL_TARGET="$(cd "$NODE_MODULES" && pwd -P)"
  clone_tree "$REAL_TARGET" "$CLONE"
  mv "$NODE_MODULES" "$LINK_BAK" # move the symlink aside (instant)
  mv "$CLONE" "$NODE_MODULES"    # swap the real clone into place (instant)
fi

# Run the wrapped command, preserving its exit code. `set +e` so a
# non-zero status does not abort before we capture it; the traps restore
# the symlink and release the lock regardless.
set +e
"$@"
status=$?
set -e

exit "$status"
