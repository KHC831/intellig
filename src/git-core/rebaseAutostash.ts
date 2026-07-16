/**
 * Parked-autostash detection for terminal rebase transitions.
 *
 * A rebase run with `--autostash` lets git own saving/restoring the dirty
 * working tree: the stash commit's SHA lives in the
 * `.git/rebase-merge/autostash` marker file while the rebase is in
 * progress, and git reapplies it at every terminal state (`--continue` to
 * completion, `--abort`, terminal git included). When that reapply
 * conflicts, git resets the tree and PARKS the entry as a normal stash —
 * data-safe, but announced only on git's stdout, which the user never sees
 * (and prose parsing is a localization bug). This module detects the parked
 * outcome from git state instead:
 *
 *  - marker existed before the op → parked iff its SHA is now in
 *    `git stash list` (git only lists it when the apply conflicted);
 *  - no marker observable before the op (the `executeRebase` case, where
 *    the autostash is created AND parked inside one git command) → parked
 *    iff the `refs/stash` tip changed during the op. Accepted residual: a
 *    user stash pushed concurrently mid-rebase reads as a tip change and
 *    produces one spurious (harmless) warning.
 *
 * Detection never throws and degrades to `false` on any fault. vscode-free:
 * it returns data; the UI seams own the single warning copy below.
 */

import * as fs from 'fs';
import * as path from 'path';
import { GitCli } from './gitCli';
import { resolveWorktreeGitDir } from './repo/RepositoryDiscovery';
import { REBASE_MERGE_DIR } from './gitDirMarkers';
import { getLogger } from '../utils/logger';

/** The one warning copy every parked-autostash toast site shares. */
export const AUTOSTASH_PARKED_WARNING =
  'Your uncommitted changes conflicted with the result and were kept in the stash — pop them when ready.';

/** Snapshot taken by {@link beginAutostashWatch} before a terminal transition. */
export interface IAutostashWatchToken {
  /** SHA from the `.git/rebase-merge/autostash` marker, when present. */
  markerSha: string | undefined;
  /** `refs/stash` tip at begin time (absent OK). */
  stashTip: string | undefined;
}

/**
 * Read the autostash marker SHA for a paused rebase. Resolves the REAL git
 * dir via {@link resolveWorktreeGitDir} — `.git` is a pointer FILE in a
 * linked worktree, so a raw `.git` path join would miss the marker.
 */
export function readAutostashSha(repoRoot: string): string | undefined {
  try {
    const marker = path.join(resolveWorktreeGitDir(repoRoot), REBASE_MERGE_DIR, 'autostash');
    const content = fs.readFileSync(marker, 'utf8').trim();
    return content.length > 0 ? content : undefined;
    // eslint-disable-next-line no-restricted-syntax -- an absent/unreadable marker file means "no autostash"; absence is the expected common case.
  } catch {
    return undefined;
  }
}

async function readStashTip(gitCli: GitCli, cwd: string): Promise<string | undefined> {
  const res = await gitCli.exec(['rev-parse', '--verify', '--quiet', 'refs/stash'], { cwd });
  if (res.exitCode !== 0) {
    return undefined;
  }
  const tip = res.stdout.trim();
  return tip.length > 0 ? tip : undefined;
}

/** Snapshot the autostash marker + stash tip before a terminal rebase op. Never throws. */
export async function beginAutostashWatch(
  gitCli: GitCli,
  cwd: string
): Promise<IAutostashWatchToken> {
  try {
    return { markerSha: readAutostashSha(cwd), stashTip: await readStashTip(gitCli, cwd) };
  } catch (error) {
    getLogger().debug('autostash watch: begin snapshot failed', {
      err: error instanceof Error ? error.message : String(error),
    });
    return { markerSha: undefined, stashTip: undefined };
  }
}

/**
 * True iff the op parked the autostash as a stash entry (see module doc for
 * the two detection signals). Silent `false` when neither signal fires or on
 * any detection fault; never throws.
 */
export async function finishAutostashWatch(
  gitCli: GitCli,
  cwd: string,
  token: IAutostashWatchToken
): Promise<boolean> {
  try {
    if (token.markerSha !== undefined) {
      const list = await gitCli.exec(['stash', 'list', '--format=%H'], { cwd });
      if (list.exitCode !== 0) {
        return false;
      }
      return list.stdout
        .split('\n')
        .map((line) => line.trim())
        .includes(token.markerSha);
    }
    const tip = await readStashTip(gitCli, cwd);
    return tip !== undefined && tip !== token.stashTip;
  } catch (error) {
    getLogger().debug('autostash watch: detection failed', {
      err: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Convenience wrapper for sites whose terminal transition is a single call
 * (continue/abort execs). An op throw propagates unwatched — the caller's
 * error path owns it.
 */
export async function withAutostashParked<T>(
  gitCli: GitCli,
  cwd: string,
  op: () => Promise<T>
): Promise<{ result: T; autostashParked: boolean }> {
  const token = await beginAutostashWatch(gitCli, cwd);
  const result = await op();
  return { result, autostashParked: await finishAutostashWatch(gitCli, cwd, token) };
}
