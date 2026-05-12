/**
 * Atomic file write helper.
 *
 * Replaces ad-hoc `fs.writeFileSync(path, content)` calls in services that
 * persist JSON state (ChangelistService, ShelfService) and shell scripts
 * (RebaseService). A direct write is vulnerable to two well-known failure
 * modes:
 *
 *   1. **Crash-during-write** — if the process is killed between the open
 *      and the last byte flush, the file is left truncated and the user
 *      loses their state. Reading the half-written JSON on next launch
 *      surfaces as a parse failure that the service then "gracefully"
 *      falls back out of by treating all state as empty.
 *
 *   2. **Partial-write visibility to concurrent readers** — when another
 *      observer of the file (a second VS Code window, an editor running a
 *      git hook, an external tool) reads while a direct `writeFileSync`
 *      is mid-flight, it can see truncated content. Rename-based writes
 *      guarantee the reader sees either the old or the new complete file,
 *      never a half-written intermediate state.
 *
 * The fix is the same pattern `git` itself uses when rewriting index/refs
 * files: write content to a sibling temp file in the same directory, then
 * rename it over the target. `rename(2)` is atomic within a single
 * filesystem on every platform we support — Windows (NTFS/ReFS) guarantees
 * it when the target file is not locked, and POSIX systems are atomic
 * unconditionally. Node's `fs.renameSync` handles the cross-platform
 * semantics (silent overwrite on POSIX; atomic replace on modern Windows).
 *
 * ### Temp-file cleanup
 *
 * On a thrown error the helper best-effort-unlinks the temp file so the
 * directory doesn't accrete `.tmp-<pid>-<rand>` garbage across crashes.
 * If the unlink itself fails (e.g. the crash happened between write and
 * rename — there's a temp file left behind) we swallow the secondary
 * error: the original write error is always the more-useful one to the
 * caller, and the temp-file mess is purely cosmetic because the sibling
 * name is pid-scoped + 8 base36 chars of entropy (≈ 41 bits), so
 * collisions between concurrent writers in the same directory are
 * vanishingly unlikely.
 *
 * ### Open-file-handle (Windows locked-file) caveat
 *
 * On Windows, if another process holds an **exclusive** handle on the
 * target file, the rename will throw `EBUSY`/`EPERM`. The caller surfaces
 * this to the user. This matches the old `writeFileSync` behavior (which
 * would also throw `EBUSY`), so callers don't need to special-case it.
 * The important invariant is that **no partial write is ever visible at
 * the target path** — either the rename succeeds and the new content is
 * live, or it fails and the old content remains intact.
 *
 * ### Limitations
 *
 * - **Not a concurrent-writer serializer.** Protection is against partial
 *   content visibility at `targetPath`, NOT against two writers racing.
 *   If window A and window B both read the file, mutate their copies,
 *   and call `atomicWriteFileSync` close in time, the last rename wins
 *   and the earlier writer's changes are silently overwritten
 *   (last-writer-wins). Callers that serve multiple VS Code windows and
 *   need read-modify-write atomicity must coordinate externally — e.g.
 *   via an OS file lock or by funnelling writes through VS Code's
 *   workspace state.
 *
 * - **Node-process-crash safe, not OS-crash safe.** Between a successful
 *   `renameSync` return and the OS flushing page cache to disk, a power
 *   loss or kernel panic can leave the rename metadata referring to a
 *   zero-length or truncated inode. For this codebase's use cases
 *   (JSON state files, rebase todo scripts) that window is acceptably
 *   narrow and the cost of `fsync(fd)` on the temp fd plus (POSIX)
 *   `fsync` on the containing directory is not justified. If stronger
 *   durability is ever needed, add an `fsync(fd)` before rename and a
 *   directory fsync after; both have meaningful per-call latency on
 *   spinning disks.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Options for {@link atomicWriteFileSync}.
 */
export interface IAtomicWriteOptions {
  /**
   * File mode to apply to the final file. Passed through to the temp-file
   * creation (`fs.writeFileSync({ mode })`) so the rename produces a file
   * with the intended bits. Defaults to the platform default (0o666 on
   * POSIX, which is then masked by the process umask).
   */
  mode?: number;
  /**
   * Encoding for the payload. Only `'utf8'` is used by current callers;
   * kept here for forward compat with binary writes.
   */
  encoding?: BufferEncoding;
}

/**
 * Narrow subset of the `fs` module that {@link atomicWriteFileSync} uses.
 * Exposed so tests can inject a fault-injection double without having to
 * monkey-patch the real `fs` module (whose exports are read-only under
 * Node's ESM/CJS interop).
 *
 * @internal
 */
export interface IAtomicWriteFs {
  writeFileSync: typeof fs.writeFileSync;
  renameSync: typeof fs.renameSync;
  existsSync: typeof fs.existsSync;
  unlinkSync: typeof fs.unlinkSync;
}

const defaultFs: IAtomicWriteFs = {
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  existsSync: fs.existsSync,
  unlinkSync: fs.unlinkSync,
};

/**
 * Narrow subset of the `fs.promises` module that {@link atomicWriteFile} uses.
 * Same shape as {@link IAtomicWriteFs} but with the promise-returning variants.
 *
 * @internal
 */
export interface IAtomicWriteFsAsync {
  writeFile: typeof fs.promises.writeFile;
  rename: typeof fs.promises.rename;
  unlink: typeof fs.promises.unlink;
  /**
   * Probe whether a path exists. Only used on the error path to clean up
   * the temp file — we tolerate a racy answer because the next call is
   * `unlink` which itself no-ops on ENOENT.
   */
  exists: (targetPath: string) => Promise<boolean>;
}

const defaultFsAsync: IAtomicWriteFsAsync = {
  writeFile: fs.promises.writeFile,
  rename: fs.promises.rename,
  unlink: fs.promises.unlink,
  exists: async (p) => {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Synchronously write `content` to `targetPath` atomically: the content
 * is first written to a sibling temp file, then renamed over the target.
 *
 * @throws The underlying fs error on write or rename failure. The target
 *   file at `targetPath` is guaranteed to be either fully-updated or
 *   unchanged — never partially-written.
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string | Buffer,
  options: IAtomicWriteOptions = {},
  fsImpl: IAtomicWriteFs = defaultFs
): void {
  const { mode, encoding = 'utf8' } = options;
  const tmpPath = buildTempPath(targetPath);

  try {
    const writeOptions: fs.WriteFileOptions =
      typeof content === 'string'
        ? mode !== undefined
          ? { encoding, mode }
          : { encoding }
        : mode !== undefined
          ? { mode }
          : {};
    fsImpl.writeFileSync(tmpPath, content, writeOptions);
    // `renameSync` is atomic within a filesystem. If the write above
    // succeeded but the rename throws (e.g. target is locked on Windows),
    // the temp file is left behind and we clean it up in the catch.
    fsImpl.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the temp file. Swallow secondary errors so
    // the caller sees the original (more informative) failure.
    try {
      if (fsImpl.existsSync(tmpPath)) {
        fsImpl.unlinkSync(tmpPath);
      }
    } catch {
      /* deliberate swallow — see JSDoc */
    }
    throw err;
  }
}

/**
 * Promise-returning variant of {@link atomicWriteFileSync} for async callers
 * that cannot block the event loop. Same guarantees:
 *
 * - Content is written to a sibling temp file and then renamed over the
 *   target. A concurrent reader observes either the old or the new
 *   complete file — never a partial write.
 * - On any failure (write or rename) the temp file is best-effort-unlinked
 *   and the original error is thrown.
 *
 * Used by working-tree writers that run on VS Code's extension host (e.g.
 * `MergeView.markResolved`) where the content being written is about to be
 * staged + committed, so a partial write would corrupt the commit. For
 * ephemeral private temp files (e.g. `PatchService`'s
 * `mkdtemp`-created scratch dir) or user-picked export paths (e.g.
 * `ShelfView.createPatch`, `CommitContextMenuCommands._handleCreatePatch`)
 * the plain async `writeFile` remains acceptable — no concurrent observer,
 * no commit at stake.
 *
 * Limitations are identical to the sync variant — see the module header.
 *
 * @throws The underlying fs error on write or rename failure.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string | Buffer,
  options: IAtomicWriteOptions = {},
  fsImpl: IAtomicWriteFsAsync = defaultFsAsync
): Promise<void> {
  const { mode, encoding = 'utf8' } = options;
  const tmpPath = buildTempPath(targetPath);

  try {
    const writeOptions: fs.WriteFileOptions =
      typeof content === 'string'
        ? mode !== undefined
          ? { encoding, mode }
          : { encoding }
        : mode !== undefined
          ? { mode }
          : {};
    await fsImpl.writeFile(tmpPath, content, writeOptions);
    await fsImpl.rename(tmpPath, targetPath);
  } catch (err) {
    try {
      if (await fsImpl.exists(tmpPath)) {
        await fsImpl.unlink(tmpPath);
      }
    } catch {
      /* deliberate swallow — see JSDoc */
    }
    throw err;
  }
}

/**
 * Construct the sibling temp-file path used by both variants. Centralises
 * the naming convention so any future tweak (e.g. adopting `crypto.randomUUID`
 * for stronger entropy) stays in one place.
 *
 * @internal
 */
function buildTempPath(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  // Collision-resistant sibling name under reasonable concurrency:
  // pid-scoped + 8 base36 chars ≈ 41 bits of entropy. Not cryptographically
  // unique — `Math.random()` is deliberately cheap — but the combination
  // means two writers in the same directory at the same instant won't race
  // on the temp name often enough to measurably perturb the rename.
  return path.join(dir, `.${base}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
}
