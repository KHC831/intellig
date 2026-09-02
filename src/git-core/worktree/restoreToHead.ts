/**
 * The single "make these paths match HEAD" writer — git4idea
 * `GitRollbackEnvironment` counterpart.
 *
 * "Restore a path to its committed state" had four inline implementations
 * (rollback, revertFile, cherry-pick file-subset drop, drop-selected-changes),
 * and the naive ones corrupted or failed on the cases the careful ones
 * handled: a file ADDED in the change has no HEAD blob, so
 * `git checkout HEAD -- <path>` fatals ("pathspec did not match") — it must be
 * unindexed instead; a RENAMED file's new path is absent from HEAD while its
 * old path holds the content to bring back.
 *
 * This writer discovers each path's HEAD membership itself (authoritative)
 * rather than trusting a caller-supplied status, and applies the correct
 * command per partition in a safe order: unindex added/renamed-to paths, delete
 * the opted-in working-tree copies (strictly inside the repo), then restore
 * every HEAD-tracked path (and rename sources) in ONE batched checkout so a
 * mixed selection can't be left half-applied.
 */

import { promises as fsp } from 'fs';
import * as nodePath from 'path';
import { GitCli, literalPathspec } from '../gitCli';

/** One path to bring back to its HEAD state. */
export interface IRestoreToHeadRequest {
  /** The path as it exists now (the rename DESTINATION for a rename). */
  path: string;
  /**
   * For a rename, the path the file had in HEAD. When the current `path` is
   * absent from HEAD but `oldPath` is present, the writer restores `oldPath`
   * (bringing the pre-rename file back) and unindexes/removes `path`.
   */
  oldPath?: string;
  /**
   * Whether `path` is present in HEAD, when the caller already knows
   * authoritatively (e.g. from a `git status` porcelain read). Omit to let the
   * writer probe (`git cat-file -e HEAD:<path>`) — the right choice when the
   * caller has no reliable status (e.g. after a `cherry-pick -n`).
   */
  inHead?: boolean;
  /**
   * When `path` is absent from HEAD (an added or untracked file, or a rename
   * destination), also delete its working-tree copy. Off ⇒ the file is only
   * unindexed and stays on disk as untracked (git4idea's default for a
   * rolled-back added file).
   */
  removeFromDiskIfAbsentFromHead?: boolean;
}

/** True when `HEAD:<path>` resolves to an object (the path is tracked in HEAD). */
async function existsInHead(gitCli: GitCli, cwd: string, path: string): Promise<boolean> {
  const res = await gitCli.exec(['cat-file', '-e', `HEAD:${path}`], { cwd });
  return res.exitCode === 0;
}

/**
 * Delete `relPath` from the working tree, refusing anything that resolves
 * outside the repo root (the shelf/rollback stores are attacker-deliverable,
 * and an empty/`.`/absolute/`..`-escaping path would otherwise wipe the root
 * or beyond). The PARENT directory is realpath'd before the containment
 * check: a lexical `startsWith(root)` passes for `repo/link/sub/f` even when
 * `link` is a symlink pointing outside the repo, and the delete would land
 * outside. The final component itself may be a symlink — `rm` removes the
 * link, never its target. Missing paths are a no-op — the desired end state
 * is "gone". Exported as THE delete guard for every worktree-mutation flow
 * (rollback, untracked deletes, drop-selected) so the escape class stays
 * closed in one place.
 */
export async function removeInsideRepo(cwd: string, relPath: string): Promise<void> {
  const abs = nodePath.resolve(cwd, relPath);
  const root = nodePath.resolve(cwd);
  if (abs === root || !abs.startsWith(root + nodePath.sep)) {
    throw new Error(`Refusing to delete a path outside the repository: ${relPath}`);
  }
  let realRoot: string;
  let realParent: string;
  try {
    realRoot = await fsp.realpath(root);
    realParent = await fsp.realpath(nodePath.dirname(abs));
  } catch {
    // The parent (or root) doesn't exist — nothing to delete.
    return;
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + nodePath.sep)) {
    throw new Error(`Refusing to delete a path outside the repository: ${relPath}`);
  }
  await fsp.rm(nodePath.join(realParent, nodePath.basename(abs)), {
    force: true,
    recursive: true,
  });
}

/**
 * Restore the requested paths to their HEAD state.
 *
 * @throws when git could not spawn, when the `rm --cached --ignore-unmatch`
 *   unindex batch fails for a real reason (e.g. index.lock contention), or
 *   when the final `checkout HEAD -- …` fails (a genuine restore failure).
 */
export async function restorePathsToHead(
  gitCli: GitCli,
  cwd: string,
  requests: readonly IRestoreToHeadRequest[]
): Promise<void> {
  const checkoutPaths: string[] = []; // git checkout HEAD -- <these>
  const unindexPaths: string[] = []; // git rm --cached -- <these> (added/renamed-to)
  const diskDeletes: string[] = [];

  for (const req of requests) {
    const pathInHead = req.inHead ?? (await existsInHead(gitCli, cwd, req.path));
    if (pathInHead) {
      // Tracked in HEAD (modified/deleted/copied) — restore in place.
      checkoutPaths.push(req.path);
      continue;
    }

    // Absent from HEAD: an added file, an untracked file, or a rename's new
    // path. Unindex it, restore the rename source when there is one, and delete
    // the working-tree copy only when the caller opted in. When the caller
    // supplied the `inHead` hint it also vouches for `oldPath` being the HEAD
    // source (a rename's from-path is tracked by definition), so probe it only
    // in probe mode.
    unindexPaths.push(req.path);
    if (req.oldPath !== undefined) {
      const oldInHead = req.inHead !== undefined || (await existsInHead(gitCli, cwd, req.oldPath));
      if (oldInHead) {
        checkoutPaths.push(req.oldPath);
      }
    }
    if (req.removeFromDiskIfAbsentFromHead) {
      diskDeletes.push(req.path);
    }
  }

  if (unindexPaths.length > 0) {
    // `--ignore-unmatch` handles the expected case (an untracked path or an
    // already-unstaged add is not in the index) WITHOUT tolerating real
    // failures: without it, one unmatched pathspec makes the whole batch exit
    // 128 having removed NOTHING — batch-mates silently stayed staged. With
    // it, a non-zero exit means something real (index.lock contention) and
    // must throw.
    await gitCli.exec(
      ['rm', '--cached', '-f', '--ignore-unmatch', '--', ...unindexPaths.map(literalPathspec)],
      { cwd, throwOnError: true }
    );
  }

  for (const rel of diskDeletes) {
    await removeInsideRepo(cwd, rel);
  }

  if (checkoutPaths.length > 0) {
    await gitCli.exec(['checkout', 'HEAD', '--', ...checkoutPaths.map(literalPathspec)], {
      cwd,
      throwOnError: true,
    });
  }
}
