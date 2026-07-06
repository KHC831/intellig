import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'node:crypto';
import { atomicWriteFileSync } from '../utils/atomicWrite';
import {
  IShelfService,
  IShelfItem,
  IShelfFile,
  IShelveSelection,
  IUnshelveOptions,
  IUnshelveResult,
  IImportPatchOptions,
} from './interfaces/IShelfService';
import { IRepository, IDiff, IHunk, IGitService } from '../git-core/interfaces/IGitService';
import { IChangelistService } from '../changelists/interfaces/IChangelistService';
import { GitCli, createGitCli, IGitCommandResult } from '../git-core/gitCli';
import { getLogger, type Logger } from '../utils/logger';

// Typeguard for GitService's @internal cli escape hatch.
interface IGitServiceWithCli {
  gitCli: GitCli;
}
import { parseDiff } from '../git-core/gitParser';
import { buildPatchHeader, serializeHunkLines } from '../git-core/patchBuilder';
import { splitPatchByFile } from '../patches/PatchService';
import { applyTextPatch } from '../patches/applyTextPatch';
import { isPathInsideOrEqual, resolveWorktreeGitDir } from '../git-core/repo/RepositoryDiscovery';

/**
 * True when a shelved file path, resolved against the repository root, stays
 * inside that root. The shelf store (`.git/intellig-shelf.json`) is
 * attacker-deliverable — a crafted entry can name `../../foo` or an absolute
 * path — so any raw-`fs` write/delete must confirm containment before touching
 * disk. Absolute paths are rejected outright (`path.join` would otherwise fold
 * them back under the root and mask the intent).
 *
 * Containment is enforced in two layers. First a LEXICAL check confines `..`
 * segments and rejects absolute paths. Then a REALPATH check defends against an
 * in-repo symlink whose target points outside the repository: a `writeFileSync`
 * /`rmSync` on a lexically contained path that routes through such a symlink
 * would otherwise follow it. The target file itself may not exist yet (a restore
 * creates it), so we resolve the real path of its nearest EXISTING ancestor and
 * require that to live inside the real (symlink-resolved) repository root. Both
 * sides are resolved with `fs.realpathSync` so a symlinked repo root (e.g.
 * `/tmp` → `/private/tmp` on macOS) compares consistently. Any resolution
 * failure fails closed (returns `false`).
 */
function isShelfFilePathWithinRepo(rootFsPath: string, filePath: string): boolean {
  if (path.isAbsolute(filePath)) {
    return false;
  }
  const absTarget = path.join(rootFsPath, filePath);
  if (!isPathInsideOrEqual(rootFsPath, absTarget)) {
    return false;
  }

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootFsPath);
  } catch {
    return false;
  }

  // Walk up to the nearest existing ancestor (the target may not exist yet),
  // then realpath it. `fs.existsSync` follows symlinks, so a link that escapes
  // the repo resolves to an out-of-repo physical path here and is rejected.
  let ancestor = absTarget;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }

  let realAncestor: string;
  try {
    realAncestor = fs.realpathSync(ancestor);
  } catch {
    return false;
  }

  return isPathInsideOrEqual(realRoot, realAncestor);
}

/**
 * Write `data` to `absPath`, refusing to follow a symlink at the FINAL path
 * component. {@link isShelfFilePathWithinRepo} confines `..` and rejects a
 * symlink whose realpath escapes the repo, but it resolves the path BEFORE the
 * write, so a final component swapped to a symlink between check and write — or
 * an in-repo symlink whose target stays inside the repo (containment passes) —
 * would still be followed. `O_NOFOLLOW` closes that on the final component: the
 * open fails (`ELOOP`) when it is a symlink, so the bytes never route through
 * it.
 *
 * `O_NOFOLLOW` exists on macOS/Linux; on platforms without it (Windows) we fall
 * back to an `lstat`-before-write reject so the call still refuses a
 * final-component symlink rather than throwing on an unknown flag.
 *
 * Residual: a NON-FINAL directory component swapped to a symlink between the
 * containment check and this write is still traversed — fully closing that
 * needs `openat`-style per-component `O_NOFOLLOW`, which Node does not expose.
 * The caller re-runs the realpath containment check immediately before this
 * write to narrow that window.
 */
function writeFileRejectingSymlink(absPath: string, data: Buffer): void {
  const noFollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (typeof noFollow === 'number') {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | noFollow;
    const fd = fs.openSync(absPath, flags, 0o666);
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  rejectFinalSymlink(absPath);
  fs.writeFileSync(absPath, data);
}

/**
 * Delete a REGULAR file at `absPath`, refusing a non-regular final component.
 * `lstat` does not follow the final component, so a path swapped to a symlink
 * is detected and refused rather than having its link unlinked or — for a
 * directory component residual — followed. A missing path is a no-op (the
 * working-tree copy is already gone, which is the desired end state).
 */
function unlinkRegularFile(absPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to delete non-regular shelf path: ${absPath}`);
  }
  fs.rmSync(absPath);
}

/**
 * Throw when `absPath`'s final component is a symlink. Fallback used by
 * {@link writeFileRejectingSymlink} on platforms lacking `O_NOFOLLOW`. A
 * missing path is fine (a fresh write creates a regular file).
 */
function rejectFinalSymlink(absPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to write through symlinked shelf path: ${absPath}`);
  }
}

/**
 * Shelf storage file format version.
 * Increment this when making breaking changes to the storage format.
 *
 * v1: initial format (id, name, timestamp, files).
 * v2: adds optional per-item lifecycle markers — `unshelvedAt`
 *   (Already-Unshelved) and `deletedAt` (recycle bin / Recently Deleted).
 *   Both are additive: a file written without them loads with the field
 *   absent, and unknown fields round-trip via the `_unknown*` capture.
 */
const SHELF_STORAGE_VERSION = 2;

/**
 * Shelf storage file name.
 * Stored in the .git directory to keep it repository-specific.
 */
const SHELF_STORAGE_FILE = 'intellig-shelf.json';

/**
 * Shelf storage model for JSON persistence.
 *
 * Forward-compat round-trip: unknown top-level keys and unknown per-item
 * keys are preserved verbatim across load/save cycles, mirroring the same
 * pattern applied to ChangelistService. A newer version of the extension
 * can introduce new fields without older versions silently dropping them
 * when they persist back to disk. The shape we recognise is narrow (see
 * {@link KNOWN_SHELF_TOP_LEVEL_KEYS} / {@link KNOWN_SHELF_ITEM_KEYS});
 * everything else is captured into `_unknownTopLevel` / `_unknownItem`
 * and re-emitted on save. These two fields are purely in-memory
 * bookkeeping — they are never written to disk as named keys.
 */
interface IShelfStorage {
  version: number;
  items: IShelfStorageItem[];
  /**
   * Unknown top-level keys captured during load. Spread back out when
   * saving so forward-compat fields survive a round trip.
   * @internal
   */
  _unknownTopLevel?: Record<string, unknown>;
}

/**
 * Shelf storage item model.
 */
interface IShelfStorageItem {
  id: string;
  name: string;
  timestamp: number;
  files: IShelfStorageFile[];
  /** v2: epoch ms of successful unshelve, if the entry is Already-Unshelved. */
  unshelvedAt?: number;
  /** v2: epoch ms of deletion into the recycle bin, if the entry is Recently-Deleted. */
  deletedAt?: number;
  /**
   * Unknown per-item keys captured during load. Spread back out when
   * saving so forward-compat fields survive a round trip.
   * @internal
   */
  _unknownItem?: Record<string, unknown>;
}

/**
 * Shelf storage file model.
 *
 * Per-file fields are fixed — the diff payload itself is opaque text. For
 * forward-compat with possible future per-file metadata (e.g. binary-flag,
 * mode bits, encoding hint), unknown keys encountered at this nesting
 * level are captured into `_unknownFileField` and re-emitted on save,
 * mirroring the top-level / per-item pattern above.
 */
interface IShelfStorageFile {
  path: string;
  originalContent: string;
  patchContent: string;
  /**
   * `true` for a binary file entry. Binary entries store their bytes in
   * `binaryContent` (base64) rather than a text patch in `patchContent`, and
   * are restored by writing those bytes to disk instead of via `git apply`.
   * Mirrors IntelliJ's binary-aware shelf (ShelvedBinaryFile.java).
   */
  isBinary?: boolean;
  /** Base64 of the shelved binary "after" bytes; absent for a deleted binary. */
  binaryContent?: string;
  /** Change status for a binary entry. Absent for text entries. */
  binaryStatus?: 'added' | 'modified' | 'deleted';
  /**
   * Unknown per-file keys captured during load. Spread back out when
   * saving so forward-compat per-file fields survive a round trip.
   * @internal
   */
  _unknownFileField?: Record<string, unknown>;
}

/**
 * The set of known top-level keys. Used by the forward-compat round-trip
 * logic to partition a parsed payload into known vs. unknown halves. Kept in
 * sync with {@link IShelfStorage} via the compile-time `satisfies` clause —
 * adding a field to the interface without listing it here fails the build.
 * `_unknownTopLevel` is excluded as in-memory bookkeeping.
 */
const KNOWN_SHELF_TOP_LEVEL_KEYS_SPEC = {
  version: true,
  items: true,
} as const satisfies Record<Exclude<keyof IShelfStorage, '_unknownTopLevel'>, true>;

const KNOWN_SHELF_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(
  Object.keys(KNOWN_SHELF_TOP_LEVEL_KEYS_SPEC)
);

/**
 * The set of known per-item keys. Same purpose as
 * {@link KNOWN_SHELF_TOP_LEVEL_KEYS} but for individual shelf records. Same
 * compile-time audit — adding a field to {@link IShelfStorageItem} requires a
 * matching entry here or the build fails. `_unknownItem` is excluded as
 * in-memory bookkeeping.
 */
const KNOWN_SHELF_ITEM_KEYS_SPEC = {
  id: true,
  name: true,
  timestamp: true,
  files: true,
  unshelvedAt: true,
  deletedAt: true,
} as const satisfies Record<Exclude<keyof IShelfStorageItem, '_unknownItem'>, true>;

const KNOWN_SHELF_ITEM_KEYS: ReadonlySet<string> = new Set(Object.keys(KNOWN_SHELF_ITEM_KEYS_SPEC));

/**
 * The set of known per-file keys. Partitions a parsed shelf-file record into
 * known vs. unknown halves so the unknown half survives a load/save round
 * trip. Compile-time audit mirrors the top-level / per-item registries —
 * `_unknownFileField` is the only excluded key because it's in-memory
 * bookkeeping.
 */
const KNOWN_SHELF_FILE_KEYS_SPEC = {
  path: true,
  originalContent: true,
  patchContent: true,
  isBinary: true,
  binaryContent: true,
  binaryStatus: true,
} as const satisfies Record<Exclude<keyof IShelfStorageFile, '_unknownFileField'>, true>;

const KNOWN_SHELF_FILE_KEYS: ReadonlySet<string> = new Set(Object.keys(KNOWN_SHELF_FILE_KEYS_SPEC));

/**
 * Pure version of {@link ShelfService.loadShelfStorage}'s parse half,
 * exported so property tests can exercise the load logic without
 * constructing the whole service. Unit tests rely on this matching the
 * class method exactly.
 *
 * Accepts anything JSON.parse might return (including non-object or
 * missing-keys shapes) and always returns a well-formed {@link IShelfStorage}.
 *
 * @internal
 */
export function migrateShelfStorageForTest(parsed: unknown): IShelfStorage {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      version: SHELF_STORAGE_VERSION,
      items: [],
    };
  }

  const record = parsed as Record<string, unknown>;

  const version = typeof record.version === 'number' ? record.version : 1;
  if (version > SHELF_STORAGE_VERSION) {
    getLogger()
      .child({ component: 'ShelfService' })
      .warn('Shelf storage version is newer than expected; reading best-effort', {
        observedVersion: version,
        expectedVersion: SHELF_STORAGE_VERSION,
      });
  }

  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items: IShelfStorageItem[] = rawItems.map((raw) => {
    const item = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const unknownItem: Record<string, unknown> = {};
    for (const k of Object.keys(item)) {
      if (!KNOWN_SHELF_ITEM_KEYS.has(k)) {
        unknownItem[k] = item[k];
      }
    }
    const files = Array.isArray(item.files)
      ? (item.files as unknown[]).map((f): IShelfStorageFile => {
          const fileRec = f !== null && typeof f === 'object' ? (f as Record<string, unknown>) : {};
          const unknownFileField: Record<string, unknown> = {};
          for (const k of Object.keys(fileRec)) {
            if (!KNOWN_SHELF_FILE_KEYS.has(k)) {
              unknownFileField[k] = fileRec[k];
            }
          }
          const binaryStatus =
            fileRec.binaryStatus === 'added' ||
            fileRec.binaryStatus === 'modified' ||
            fileRec.binaryStatus === 'deleted'
              ? fileRec.binaryStatus
              : undefined;
          return {
            path: typeof fileRec.path === 'string' ? fileRec.path : '',
            originalContent:
              typeof fileRec.originalContent === 'string' ? fileRec.originalContent : '',
            patchContent: typeof fileRec.patchContent === 'string' ? fileRec.patchContent : '',
            ...(typeof fileRec.isBinary === 'boolean' ? { isBinary: fileRec.isBinary } : {}),
            ...(typeof fileRec.binaryContent === 'string'
              ? { binaryContent: fileRec.binaryContent }
              : {}),
            ...(binaryStatus ? { binaryStatus } : {}),
            ...(Object.keys(unknownFileField).length > 0
              ? { _unknownFileField: unknownFileField }
              : {}),
          };
        })
      : [];
    return {
      id: typeof item.id === 'string' ? item.id : '',
      name: typeof item.name === 'string' ? item.name : '',
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : 0,
      files,
      ...(typeof item.unshelvedAt === 'number' ? { unshelvedAt: item.unshelvedAt } : {}),
      ...(typeof item.deletedAt === 'number' ? { deletedAt: item.deletedAt } : {}),
      ...(Object.keys(unknownItem).length > 0 ? { _unknownItem: unknownItem } : {}),
    };
  });

  const unknownTopLevel: Record<string, unknown> = {};
  for (const k of Object.keys(record)) {
    if (!KNOWN_SHELF_TOP_LEVEL_KEYS.has(k)) {
      unknownTopLevel[k] = record[k];
    }
  }

  return {
    // Always re-tag the version to the current schema so the next save
    // writes the canonical shape. v1 → v2 is pure-additive (added
    // `unshelvedAt`), and a future v3 etc. would follow the same rule.
    version: SHELF_STORAGE_VERSION,
    items,
    ...(Object.keys(unknownTopLevel).length > 0 ? { _unknownTopLevel: unknownTopLevel } : {}),
  };
}

/**
 * Serialize an in-memory shelf storage back to the on-disk JSON shape.
 *
 * Known keys emit in the fixed order `{version, items, ...unknownTopLevel}`;
 * per-item keys emit in the fixed order
 * `{id, name, timestamp, files, unshelvedAt?, deletedAt?, ...unknownItem}`; per-file
 * keys emit in the fixed order
 * `{path, originalContent, patchContent, ...unknownFileField}`. The internal
 * bookkeeping fields (`_unknownTopLevel`, `_unknownItem`, `_unknownFileField`)
 * are consumed here and MUST NOT appear in the emitted JSON.
 *
 * Exported only for tests — production code always goes through
 * {@link ShelfService.saveShelfStorage}.
 *
 * @internal
 */
export function serializeShelfForDisk(storage: IShelfStorage): Record<string, unknown> {
  const items = storage.items.map((item) => {
    const known: Record<string, unknown> = {
      id: item.id,
      name: item.name,
      timestamp: item.timestamp,
      files: item.files.map((f) => {
        const knownFile: Record<string, unknown> = {
          path: f.path,
          originalContent: f.originalContent,
          patchContent: f.patchContent,
        };
        if (f.isBinary !== undefined) {
          knownFile.isBinary = f.isBinary;
        }
        if (f.binaryContent !== undefined) {
          knownFile.binaryContent = f.binaryContent;
        }
        if (f.binaryStatus !== undefined) {
          knownFile.binaryStatus = f.binaryStatus;
        }
        return f._unknownFileField ? { ...knownFile, ...f._unknownFileField } : knownFile;
      }),
    };
    if (item.unshelvedAt !== undefined) {
      known.unshelvedAt = item.unshelvedAt;
    }
    if (item.deletedAt !== undefined) {
      known.deletedAt = item.deletedAt;
    }
    return item._unknownItem ? { ...known, ...item._unknownItem } : known;
  });
  const known: Record<string, unknown> = {
    version: storage.version,
    items,
  };
  return storage._unknownTopLevel ? { ...known, ...storage._unknownTopLevel } : known;
}

/**
 * Shelf Service implementation.
 * Manages IDE-specific shelf storage for temporary changes.
 * The shelf is separate from Git stash and persists across VS Code sessions.
 */
export class ShelfService implements IShelfService {
  private _gitCli: GitCli;
  /** See {@link RebaseService._ownsGitCli} for the rationale. */
  private _ownsGitCli: boolean;
  /**
   * Optional changelist mechanism used to route unshelved files into a chosen
   * changelist. Only {@link IChangelistService.moveToChangelist} is needed, so
   * the dependency is narrowed to that method — unshelve still works (defaulting
   * to the active changelist) when no changelist service is wired. Mirrors the
   * `targetChangeList` PatchApplier receives in IntelliJ's
   * ShelveChangesManager.unshelveChangeList.
   */
  private _changelistService?: Pick<IChangelistService, 'moveToChangelist'>;
  private _shelfCache: Map<string, IShelfItem[]> = new Map();
  private _onDidChangeShelf: vscode.EventEmitter<IShelfItem[]>;
  private _disposables: vscode.Disposable[] = [];
  /**
   * Bound child Logger for this service.
   * Component name `'ShelfService'` appears in every emitted record.
   */
  private readonly _logger: Logger;

  /**
   * Event fired when shelf changes
   */
  readonly onDidChangeShelf: vscode.Event<IShelfItem[]>;

  constructor(
    gitCli?: GitCli,
    gitService?: IGitService,
    changelistService?: Pick<IChangelistService, 'moveToChangelist'>
  ) {
    if (gitService) {
      this._gitCli = (gitService as unknown as IGitServiceWithCli).gitCli;
      this._ownsGitCli = false;
    } else {
      this._gitCli = gitCli || createGitCli();
      this._ownsGitCli = true;
    }
    this._changelistService = changelistService;
    this._onDidChangeShelf = new vscode.EventEmitter<IShelfItem[]>();
    this.onDidChangeShelf = this._onDidChangeShelf.event;
    this._logger = getLogger().child({ component: 'ShelfService' });
    this._logger.info('ShelfService constructed', { ownsGitCli: this._ownsGitCli });
  }

  /**
   * Shelve selected changes.
   * Saves the selected changes to the shelf storage and optionally removes them from the working directory.
   *
   * @param repo - The repository
   * @param name - Name for the shelf item
   * @param changes - Selection of changes to shelve (files, changelists, or hunks)
   * @returns The created shelf item
   */
  /**
   * Abort the shelve if a diff capture hit the output cap. The captured stdout
   * is persisted as the shelf entry's patch and the working tree is reverted
   * right after — a truncated prefix would store a corrupt patch AND destroy
   * the original content, unrecoverable on unshelve. Throwing here, before any
   * store or revert, leaves the working tree genuinely untouched.
   */
  private _assertDiffNotTruncated(diffResult: IGitCommandResult, filePath: string): void {
    if (diffResult.truncated) {
      throw new Error(
        `${filePath}'s diff exceeds the capture limit; shelve aborted, working tree untouched`
      );
    }
  }

  async shelve(repo: IRepository, name: string, changes: IShelveSelection): Promise<IShelfItem> {
    const cwd = repo.rootUri.fsPath;

    // Reject an empty / whitespace-only name at the boundary, and store the
    // trimmed form (mirrors renameShelf) so a blank or padded shelf name never
    // lands on disk.
    name = name.trim();
    if (name.length === 0) {
      throw new Error('Shelf name cannot be empty');
    }

    // Validate that we have something to shelve. `changes.changelists` is NOT
    // counted here: `resolveFilesToShelve` does not expand changelists into
    // files yet, so counting them would pass this gate and then throw the
    // confusing "No files found to shelve" below. Until expansion lands, a
    // changelists-only selection is treated as "nothing selected".
    if (!changes.files?.length && !changes.hunks?.size) {
      throw new Error('No changes selected to shelve');
    }

    // Get the files to shelve
    const filesToShelve = this.resolveFilesToShelve(repo, changes);

    if (filesToShelve.length === 0) {
      throw new Error('No files found to shelve');
    }

    // Create shelf files with diffs
    const shelfFiles: IShelfFile[] = [];

    for (const filePath of filesToShelve) {
      // Binary files cannot round-trip through a text patch — git's stdout is
      // captured as a UTF-8 string, which corrupts non-UTF-8 bytes. Detect
      // binary up-front and capture the raw bytes instead. Mirrors IntelliJ's
      // ShelvedBinaryFile path (platform/vcs-impl/.../shelf/ShelvedBinaryFile.java),
      // which stores the shelved binary as a separate file rather than text.
      const binaryFile = await this.captureBinaryShelfFile(repo, filePath);
      if (binaryFile) {
        shelfFiles.push(binaryFile);
        continue;
      }

      const selectedHunks = changes.hunks?.get(filePath);
      let diffContent = '';
      if (selectedHunks && selectedHunks.length > 0) {
        // Partial-hunk shelve operates on the UNSTAGED working-tree diff (the
        // hunks the UI presented to the user); index-aware whole-change capture
        // applies only to full-file shelves.
        const diffResult = await this._gitCli.exec(['diff', '--', filePath], { cwd });
        this._assertDiffNotTruncated(diffResult, filePath);
        if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
          diffContent = this.generateHunksDiff(filePath, selectedHunks);
        }
      } else {
        // Full-file shelve captures the WHOLE change vs HEAD — staged AND
        // unstaged — so a partly- or fully-staged file is shelved in full
        // rather than silently dropped. Unshelve forward-applies it as an
        // unstaged change (IntelliJ parity). A staged-new file (in the index,
        // absent from HEAD) shows here as a creation diff and round-trips too.
        const diffResult = await this._gitCli.exec(['diff', 'HEAD', '--', filePath], { cwd });
        this._assertDiffNotTruncated(diffResult, filePath);
        if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
          // A binary change emits only "Binary files a/… and b/… differ" with no
          // recoverable hunk. captureBinaryShelfFile (HEAD-based) should have
          // handled it already; guard so a contentless binary marker is never
          // stored as an unrestorable text entry (it would revert the file on
          // shelve but fail to unshelve).
          const onlyBinaryMarker =
            /^Binary files .* differ$/m.test(diffResult.stdout) && !/^@@ /m.test(diffResult.stdout);
          if (!onlyBinaryMarker) {
            diffContent = diffResult.stdout;
          }
        }
      }

      if (diffContent.trim()) {
        shelfFiles.push({
          path: filePath,
          diff: diffContent,
        });
      }
    }

    if (shelfFiles.length === 0) {
      throw new Error('No changes found in selected files');
    }

    // Generate unique ID
    const id = this.generateShelfId();

    // Create the shelf item
    const shelfItem: IShelfItem = {
      id,
      name,
      timestamp: new Date(),
      files: shelfFiles,
    };

    // Save to storage
    this.saveShelfItem(repo, shelfItem);

    // Revert the shelved changes from working directory. A non-empty result
    // means some files could not be cleared — the shelf entry is saved but
    // those files are still live in the working tree (partial shelve).
    const removalFailures = await this.revertShelvedChanges(repo, shelfFiles, changes.hunks);
    if (removalFailures.length > 0) {
      shelfItem.partialCleanupFailures = removalFailures;
      this._logger.warn('shelve: partial — working tree still contains changes for some files', {
        failedPaths: removalFailures,
      });
    }

    // Update cache and fire event
    const items = this.getShelfItems(repo);
    this._onDidChangeShelf.fire(items);

    return shelfItem;
  }

  /**
   * Unshelve changes back to working directory.
   * Restores the shelved changes and optionally removes them from the shelf.
   *
   * @param repo - The repository
   * @param shelfId - ID of the shelf item to unshelve
   * @param options - Unshelve options (removeFromShelf, targetChangelist)
   * @returns Result of the unshelve operation
   */
  async unshelve(
    repo: IRepository,
    shelfId: string,
    options?: IUnshelveOptions
  ): Promise<IUnshelveResult> {
    const cwd = repo.rootUri.fsPath;

    // Get the shelf item
    const items = this.getShelfItems(repo);
    const shelfItem = items.find((item) => item.id === shelfId);

    if (!shelfItem) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }

    // Per-file (partial) unshelve: when `files` is given, narrow the entry to
    // just that subset. The remaining files are never applied and stay
    // shelved, mirroring IntelliJ's `remainingPatches` collection.
    const requestedFiles = options?.files;
    const selectedPaths = requestedFiles ? new Set(requestedFiles) : undefined;
    const filesToApply = selectedPaths
      ? shelfItem.files.filter((file) => selectedPaths.has(file.path))
      : shelfItem.files;

    if (selectedPaths && filesToApply.length === 0) {
      throw new Error(`No matching files to unshelve in shelf item: ${shelfId}`);
    }

    const conflicts: string[] = [];
    // Track files that applied cleanly so removeAppliedFiles can prune
    // just those paths.
    const appliedCleanly: string[] = [];

    // Apply each file's diff
    for (const file of filesToApply) {
      // Binary files restore by writing their stored bytes (or deleting the
      // path) rather than applying a text patch.
      if (file.isBinary) {
        if (await this.restoreBinaryShelfFile(repo, file)) {
          appliedCleanly.push(file.path);
        } else {
          conflicts.push(file.path);
        }
        continue;
      }
      try {
        // Apply the patch to the working directory
        const result = await this._gitCli.exec(['apply', '--3way', '-'], {
          cwd,
          input: file.diff,
        });

        if (result.exitCode !== 0) {
          // Check if it's a conflict
          if (result.stderr.includes('conflict') || result.stderr.includes('CONFLICT')) {
            conflicts.push(file.path);
          } else {
            // Try without 3-way merge
            const fallbackResult = await this._gitCli.exec(['apply', '-'], {
              cwd,
              input: file.diff,
            });

            if (fallbackResult.exitCode !== 0) {
              conflicts.push(file.path);
            } else {
              appliedCleanly.push(file.path);
            }
          }
        } else {
          appliedCleanly.push(file.path);
        }
      } catch {
        conflicts.push(file.path);
      }
    }

    // Route the cleanly-applied files into the chosen changelist. IntelliJ
    // passes a `targetChangeList` to PatchApplier so unshelved files land in
    // that list rather than the active one
    // (ShelveChangesManager.unshelveChangeList → PatchApplier). With no target
    // the files stay in the active changelist — today's behavior — so we only
    // reassign when a target is given and a changelist mechanism is wired.
    // Conflicted files are left untouched: they didn't land in the working tree.
    if (options?.targetChangelist && this._changelistService && appliedCleanly.length > 0) {
      this._changelistService.moveToChangelist(repo, appliedCleanly, options.targetChangelist);
    }

    // Per-file unshelve owns its own bookkeeping: unselected files always
    // stay shelved, and selected files that applied cleanly are dropped only
    // when removeFromShelf (default) is on. Selected files that conflicted are
    // retained so the user can retry — matching IntelliJ's remainingPatches =
    // unselected + failed.
    if (selectedPaths) {
      const removeFromShelf = options?.removeFromShelf !== false;
      if (removeFromShelf) {
        const unselectedPaths = shelfItem.files
          .map((f) => f.path)
          .filter((p) => !selectedPaths.has(p));
        const remaining = [...unselectedPaths, ...conflicts];
        this.filterShelfFiles(repo, shelfId, remaining);
      }

      const updatedItems = this.getShelfItems(repo);
      this._onDidChangeShelf.fire(updatedItems);

      return {
        success: conflicts.length === 0,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
      };
    }

    // Honor removeAppliedFiles — prune cleanly-applied files from the entry
    // and delete the entry if nothing remains. This path takes precedence
    // over removeFromShelf because it is strictly more granular.
    const removeAppliedFiles = options?.removeAppliedFiles === true;
    if (removeAppliedFiles && appliedCleanly.length > 0) {
      const remaining = shelfItem.files
        .map((f) => f.path)
        .filter((p) => !appliedCleanly.includes(p));
      this.filterShelfFiles(repo, shelfId, remaining);
    } else {
      // Standard removeFromShelf semantics (default is true).
      const removeFromShelf = options?.removeFromShelf !== false;
      if (removeFromShelf && conflicts.length === 0) {
        // A fully-applied unshelve drops the entry outright — it is not a
        // user-initiated delete, so it skips the recycle bin (matches
        // IntelliJ's removeFilesFromShelf path, which deletes the resources).
        this.purgeShelfItem(repo, shelfId);
      } else if (conflicts.length === 0) {
        // Kept on shelf but fully applied → mark as Already-Unshelved
        // so the default filter elides it.
        this.markAsUnshelved(repo, shelfId);
      }
    }

    // Fire change event
    const updatedItems = this.getShelfItems(repo);
    this._onDidChangeShelf.fire(updatedItems);

    return {
      success: conflicts.length === 0,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  }

  /**
   * Get the active shelf items for a repository — everything except entries
   * sitting in the recycle bin. Recycle-bin entries are reached through
   * {@link getRecycledShelfItems}. Mirrors IntelliJ's main list, which
   * excludes deleted lists (`!t.isDeleted()`).
   *
   * @param repo - The repository
   * @returns Array of active shelf items
   */
  getShelfItems(repo: IRepository): IShelfItem[] {
    return this.getAllShelfItems(repo).filter((item) => item.deletedAt === undefined);
  }

  /**
   * Get the recycle-bin ("Recently Deleted") entries — items deleted via
   * {@link deleteShelfItem} that are not yet purged. Mirrors IntelliJ's
   * `ShelveChangesManager.getDeletedLists`.
   *
   * @param repo - The repository
   * @returns Array of recycled shelf items
   */
  getRecycledShelfItems(repo: IRepository): IShelfItem[] {
    return this.getAllShelfItems(repo).filter((item) => item.deletedAt !== undefined);
  }

  /**
   * Load (and cache) every shelf item for a repository, active and recycled
   * alike. The public accessors partition this list by `deletedAt`. The cache
   * holds the full set so a recycle/restore doesn't lose entries.
   *
   * @param repo - The repository
   * @returns Array of all shelf items
   */
  private getAllShelfItems(repo: IRepository): IShelfItem[] {
    const repoKey = this.getRepoKey(repo);

    // Check cache first
    if (this._shelfCache.has(repoKey)) {
      return this._shelfCache.get(repoKey)!;
    }

    // Load from storage
    const storage = this.loadShelfStorage(repo);
    const items = storage.items.map((item) => this.storageItemToShelfItem(item));

    // Update cache
    this._shelfCache.set(repoKey, items);

    return items;
  }

  /**
   * Delete a shelf item by moving it to the recycle bin. The entry's files are
   * kept and its `deletedAt` marker is stamped so it drops out of the active
   * list ({@link getShelfItems}) and surfaces under {@link getRecycledShelfItems}.
   * Restore with {@link restoreFromRecycleBin} or purge with
   * {@link deleteShelfItemPermanently}. Mirrors IntelliJ's
   * `ShelveChangesManager.markChangeListAsDeleted`.
   *
   * @param repo - The repository
   * @param shelfId - ID of the shelf item to recycle
   */
  deleteShelfItem(repo: IRepository, shelfId: string): void {
    const storage = this.loadShelfStorage(repo);

    const item = storage.items.find((i) => i.id === shelfId);
    if (!item) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }

    // Idempotent: only stamp the first deletion so a re-delete doesn't reset
    // the recycle-bin timestamp.
    if (item.deletedAt === undefined) {
      item.deletedAt = Date.now();
    }

    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
  }

  /**
   * Restore a recycle-bin entry back to the active list by clearing its
   * `deletedAt` marker. Throws when the entry can't be found. Mirrors
   * IntelliJ's `ShelveChangesManager.restoreList`.
   *
   * @param repo - The repository
   * @param shelfId - ID of the shelf item to restore
   */
  restoreFromRecycleBin(repo: IRepository, shelfId: string): void {
    const storage = this.loadShelfStorage(repo);

    const item = storage.items.find((i) => i.id === shelfId);
    if (!item) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }

    item.deletedAt = undefined;
    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
  }

  /**
   * Permanently remove a shelf item from storage (whether active or recycled).
   * Cannot be undone. Throws when the entry can't be found. Mirrors IntelliJ's
   * `ShelveChangesManager.clearShelvedLists` / `deleteChangeListCompletely`.
   *
   * @param repo - The repository
   * @param shelfId - ID of the shelf item to purge
   */
  deleteShelfItemPermanently(repo: IRepository, shelfId: string): void {
    if (!this.purgeShelfItem(repo, shelfId)) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }
  }

  /**
   * Splice a shelf item out of storage outright (no recycle bin). Shared by
   * the public {@link deleteShelfItemPermanently} and the unshelve cleanup
   * path, where a successfully-applied entry is dropped rather than recycled.
   *
   * @returns `true` when an entry was removed, `false` when none matched.
   */
  private purgeShelfItem(repo: IRepository, shelfId: string): boolean {
    const storage = this.loadShelfStorage(repo);

    const index = storage.items.findIndex((item) => item.id === shelfId);
    if (index === -1) {
      return false;
    }

    storage.items.splice(index, 1);

    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
    return true;
  }

  // ===========================================================================
  // rename / importPatch / markAsUnshelved / restoreShelf / filterShelfFiles.
  // ===========================================================================

  /**
   * Rename a shelf entry. Throws when the entry does not exist.
   */
  renameShelf(repo: IRepository, shelfId: string, newName: string): void {
    const storage = this.loadShelfStorage(repo);
    const item = storage.items.find((i) => i.id === shelfId);
    if (!item) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      throw new Error('Shelf name cannot be empty');
    }
    item.name = trimmed;
    this.saveShelfStorage(repo, storage);

    // Invalidate cache and fire event.
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
  }

  /**
   * Import a `.patch` / `.diff` file (or inline patch text) as a new shelf
   * entry. The patch's body is captured verbatim as the entry's single
   * file's diff so subsequent unshelve applies it through the standard
   * `git apply` path.
   *
   * The entry is added in an "unapplied" state (no working-tree mutation);
   * callers typically follow with unshelve when they want to actually apply.
   */
  async importPatch(repo: IRepository, options: IImportPatchOptions): Promise<IShelfItem> {
    if (!options.patchPath && options.patchContent === undefined) {
      throw new Error('importPatch: either patchPath or patchContent is required');
    }
    if (options.patchPath && options.patchContent !== undefined) {
      throw new Error('importPatch: patchPath and patchContent are mutually exclusive');
    }

    let content: string;
    if (options.patchPath) {
      content = await fs.promises.readFile(options.patchPath, 'utf-8');
    } else {
      content = options.patchContent!;
    }
    if (content.trim().length === 0) {
      throw new Error('importPatch: patch content is empty');
    }

    const name =
      options.name?.trim() ||
      (options.patchPath ? path.basename(options.patchPath) : 'Imported patch');

    // Carve the patch into one shelf file per changed file, mirroring IntelliJ
    // PatchReader.readTextPatches() which yields a TextFilePatch per file (see
    // ShelveChangesManager.importPatches → loadPatches). Each file keeps its own
    // diff block verbatim so unshelve applies it through the standard git apply
    // path. A headerless patch (no `diff --git`) can't be split, so it falls
    // back to a single synthetic `imported-patch` entry whose body git apply
    // reads in full.
    const segments = splitPatchByFile(content);
    const files: IShelfFile[] =
      segments.length > 0
        ? segments.map((segment) => ({ path: segment.path, diff: segment.content }))
        : [{ path: 'imported-patch', diff: content }];

    const shelfItem: IShelfItem = {
      id: this.generateShelfId(),
      name,
      timestamp: new Date(),
      files,
    };

    this.saveShelfItem(repo, shelfItem);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));

    return shelfItem;
  }

  /**
   * Mark a shelf entry as successfully applied. Idempotent.
   */
  markAsUnshelved(repo: IRepository, shelfId: string): void {
    const storage = this.loadShelfStorage(repo);
    const item = storage.items.find((i) => i.id === shelfId);
    if (!item) {
      return; // Idempotent — silently no-op when the entry is already gone.
    }
    if (item.unshelvedAt !== undefined) {
      return;
    }
    item.unshelvedAt = Date.now();
    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
  }

  /**
   * Re-activate an Already-Unshelved entry. Idempotent.
   */
  restoreShelf(repo: IRepository, shelfId: string): void {
    const storage = this.loadShelfStorage(repo);
    const item = storage.items.find((i) => i.id === shelfId);
    if (!item) {
      return;
    }
    if (item.unshelvedAt === undefined) {
      return;
    }
    item.unshelvedAt = undefined;
    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
  }

  /**
   * Remove every file from a shelf entry whose path is NOT in
   * `remainingPaths`. If the resulting entry has zero files the whole
   * entry is deleted.
   *
   * @returns the updated entry, or `undefined` when it was deleted.
   */
  filterShelfFiles(
    repo: IRepository,
    shelfId: string,
    remainingPaths: string[]
  ): IShelfItem | undefined {
    const storage = this.loadShelfStorage(repo);
    const index = storage.items.findIndex((i) => i.id === shelfId);
    if (index < 0) {
      return undefined;
    }
    const retainSet = new Set(remainingPaths);
    const item = storage.items[index];
    item.files = item.files.filter((f) => retainSet.has(f.path));
    if (item.files.length === 0) {
      storage.items.splice(index, 1);
      this.saveShelfStorage(repo, storage);
      this._shelfCache.delete(this.getRepoKey(repo));
      this._onDidChangeShelf.fire(this.getShelfItems(repo));
      return undefined;
    }
    this.saveShelfStorage(repo, storage);
    this._shelfCache.delete(this.getRepoKey(repo));
    const updated = this.storageItemToShelfItem(item);
    this._onDidChangeShelf.fire(this.getShelfItems(repo));
    return updated;
  }

  /**
   * Get diff for a shelf item.
   * Returns the diffs for all files in the shelf item.
   *
   * @param repo - The repository
   * @param shelfId - ID of the shelf item
   * @returns Array of diffs for the shelf item
   */
  getShelfDiff(repo: IRepository, shelfId: string): Promise<IDiff[]> {
    const items = this.getShelfItems(repo);
    const shelfItem = items.find((item) => item.id === shelfId);

    if (!shelfItem) {
      return Promise.reject(new Error(`Shelf item not found: ${shelfId}`));
    }

    // Parse the diffs from the stored diff content
    const diffs: IDiff[] = [];

    for (const file of shelfItem.files) {
      if (file.isBinary) {
        // No text hunks to parse — surface a binary IDiff so the diff view
        // shows "binary file" rather than empty/garbled text. Mirrors how a
        // ShelvedBinaryFile renders in IntelliJ's shelf diff.
        diffs.push({
          path: file.path,
          status: file.binaryStatus ?? 'modified',
          hunks: [],
          binary: true,
        });
        continue;
      }
      const parsedDiffs = parseDiff(file.diff);
      diffs.push(...parsedDiffs);
    }

    return Promise.resolve(diffs);
  }

  /**
   * Reconstruct the shelved version of a single file. See
   * {@link IShelfService.getShelvedFileContent} for the contract.
   */
  async getShelvedFileContent(
    repo: IRepository,
    shelfId: string,
    filePath: string
  ): Promise<string> {
    const items = this.getShelfItems(repo);
    const shelfItem = items.find((item) => item.id === shelfId);
    if (!shelfItem) {
      throw new Error(`Shelf item not found: ${shelfId}`);
    }

    const file = shelfItem.files.find((f) => f.path === filePath);
    if (!file) {
      throw new Error(`File not found in shelf item: ${filePath}`);
    }

    if (file.isBinary) {
      // A binary file has no text representation to reconstruct. The shelved
      // bytes live in `binaryContent`; callers that need them should read those
      // directly. Returning '' keeps the text "Compare with Local" flow inert
      // for binaries rather than emitting decoded garbage.
      return '';
    }

    // Pick the diff entry matching this file. A stored entry normally holds a
    // single-file patch, but importPatch can fold a multi-file patch into one
    // entry, so match by path and fall back to the sole diff.
    const diffs = parseDiff(file.diff);
    const diff = diffs.find((d) => d.path === filePath) ?? diffs[0];
    if (!diff) {
      // Unparseable/headerless patch — nothing to reconstruct against a base.
      return '';
    }

    const base = await this.readBaseContent(repo, diff);
    return applyTextPatch(base, diff);
  }

  /**
   * Read the base (pre-shelve) revision of a file via `git show HEAD:<path>`.
   *
   * Added files have no base revision, so return empty content directly. For a
   * rename the base lives at the old path. Any git failure (file absent at
   * HEAD, etc.) degrades to empty content so reconstruction still yields the
   * patch's added lines rather than throwing.
   */
  private async readBaseContent(repo: IRepository, diff: IDiff): Promise<string> {
    if (diff.status === 'added') {
      return '';
    }
    const basePath = diff.oldPath ?? diff.path;
    const result = await this._gitCli.exec(['show', `HEAD:${basePath}`], {
      cwd: repo.rootUri.fsPath,
      throwOnError: false,
    });
    return result.exitCode === 0 ? result.stdout : '';
  }

  /**
   * Detect whether `filePath` is a changed binary file and, if so, capture its
   * shelved bytes into an {@link IShelfFile}. Returns `undefined` for a text
   * file (or no change) so the caller falls back to the unified-diff path.
   *
   * git reports a binary change as `-\t-\t<path>` in `git diff --numstat`
   * (the byte-count columns are `-` for binaries). We classify the change by
   * comparing presence in HEAD vs. the working tree:
   *   - absent at HEAD, present on disk → added
   *   - present at HEAD, absent on disk → deleted (no bytes captured)
   *   - present in both → modified
   * The shelved bytes are the current working-tree bytes, read directly via
   * `fs` so non-UTF-8 / NUL bytes survive byte-for-byte. This mirrors
   * IntelliJ's ShelvedBinaryFile, which captures the local binary content
   * rather than a text patch.
   */
  private async captureBinaryShelfFile(
    repo: IRepository,
    filePath: string
  ): Promise<IShelfFile | undefined> {
    const cwd = repo.rootUri.fsPath;

    // --numstat prints byte counts; binary changes show `-` in both columns.
    // Diff vs HEAD (not the unstaged working tree) so a STAGED-only binary
    // change is detected too — otherwise it would slip past as a contentless
    // "Binary files differ" text diff and be lost on shelve (no bytes captured).
    const numstat = await this._gitCli.exec(['diff', '--numstat', 'HEAD', '--', filePath], {
      cwd,
      throwOnError: false,
    });
    const line = numstat.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (!line || !line.startsWith('-\t-')) {
      return undefined; // Text change, or no change at all.
    }

    const existsInHead =
      (
        await this._gitCli.exec(['cat-file', '-e', `HEAD:${filePath}`], {
          cwd,
          throwOnError: false,
        })
      ).exitCode === 0;
    const absPath = path.join(cwd, filePath);
    const existsOnDisk = fs.existsSync(absPath);

    let binaryStatus: 'added' | 'modified' | 'deleted';
    let binaryContent: string | undefined;
    if (!existsInHead && existsOnDisk) {
      binaryStatus = 'added';
      binaryContent = fs.readFileSync(absPath).toString('base64');
    } else if (existsInHead && !existsOnDisk) {
      binaryStatus = 'deleted';
      binaryContent = undefined; // Matches ShelvedBinaryFile.SHELVED_PATH == null.
    } else {
      binaryStatus = 'modified';
      binaryContent = fs.readFileSync(absPath).toString('base64');
    }

    return {
      path: filePath,
      diff: '',
      isBinary: true,
      binaryStatus,
      ...(binaryContent !== undefined ? { binaryContent } : {}),
    };
  }

  /**
   * Restore a shelved binary file to the working tree. Writes the stored bytes
   * for an added/modified entry, or deletes the path for a deleted entry. Bytes
   * are written via `fs` so they round-trip exactly. Returns `true` on success.
   */
  private async restoreBinaryShelfFile(repo: IRepository, file: IShelfFile): Promise<boolean> {
    if (!isShelfFilePathWithinRepo(repo.rootUri.fsPath, file.path)) {
      this._logger.error('Refusing to restore shelved binary file outside repository root', {
        path: file.path,
      });
      return false;
    }
    const root = repo.rootUri.fsPath;
    const absPath = path.join(root, file.path);
    try {
      if (file.binaryStatus === 'deleted') {
        // Re-validate immediately before the unlink to narrow the check→act
        // window, then refuse a non-regular (symlinked) final component.
        if (!isShelfFilePathWithinRepo(root, file.path)) {
          return false;
        }
        // Re-applying a shelved deletion unlinks the path. If the user recreated
        // a file there after shelving the deletion, deleting it would silently
        // lose their work. Only delete when the on-disk file is the PRISTINE
        // HEAD version (a clean re-apply); compare the HEAD blob hash against the
        // working file's hash. Hash compare (not `git diff HEAD`) is required so
        // an UNTRACKED recreation is caught too. Fail-closed: a positive match
        // is the ONLY case that deletes — a differing file, a missing HEAD blob
        // (nothing to match against), or a hash error all PRESERVE the file and
        // report a conflict (the unshelve loop counts a false return as one).
        if (fs.existsSync(absPath)) {
          const headBlob = await this._gitCli.exec(['rev-parse', `HEAD:${file.path}`], {
            cwd: root,
            throwOnError: false,
          });
          const diskBlob = await this._gitCli.exec(['hash-object', '--', absPath], {
            cwd: root,
            throwOnError: false,
          });
          const headSha = headBlob.exitCode === 0 ? headBlob.stdout.trim() : '';
          const diskSha = diskBlob.exitCode === 0 ? diskBlob.stdout.trim() : '';
          const isPristineHeadVersion = headSha !== '' && headSha === diskSha;
          if (!isPristineHeadVersion) {
            this._logger.warn(
              'Refusing to delete a recreated file on deletion-unshelve; preserving it and reporting a conflict',
              { path: file.path }
            );
            return false;
          }
        }
        unlinkRegularFile(absPath);
        return true;
      }
      if (file.binaryContent === undefined) {
        return false;
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      // Re-validate immediately before the write (mkdir may have materialised
      // the parent chain) and refuse to follow a final-component symlink.
      if (!isShelfFilePathWithinRepo(root, file.path)) {
        return false;
      }
      writeFileRejectingSymlink(absPath, Buffer.from(file.binaryContent, 'base64'));
      return true;
    } catch (error) {
      this._logger.error(
        'Failed to restore shelved binary file',
        { path: file.path },
        error instanceof Error ? error : undefined
      );
      return false;
    }
  }

  /**
   * Revert a binary file's working-tree change after it has been shelved.
   * Inverse of the shelve classification: restore the HEAD bytes for an
   * added/modified file (delete for an add, since there is no HEAD copy), and
   * re-materialise the HEAD bytes for a deletion.
   *
   * Returns `true` when the working-tree revert succeeded, `false` when it
   * failed (unlink threw, or the git checkout/reset returned a non-zero exit
   * code). Callers push the path to failedPaths on false.
   */
  private async revertBinaryShelfFile(repo: IRepository, file: IShelfFile): Promise<boolean> {
    const cwd = repo.rootUri.fsPath;
    const absPath = path.join(cwd, file.path);
    if (file.binaryStatus === 'added') {
      // No HEAD revision — drop the working-tree copy. The raw-fs delete must
      // stay inside the repo (the shelf store is attacker-deliverable); the
      // modified/deleted branch below is git-contained and needs no guard.
      if (!isShelfFilePathWithinRepo(cwd, file.path)) {
        this._logger.error('Refusing to revert shelved binary file outside repository root', {
          path: file.path,
        });
        return false;
      }
      // Refuse a non-regular (symlinked) final component rather than unlinking
      // it; the lstat-before-unlink mirrors the restore path's hardening.
      try {
        unlinkRegularFile(absPath);
      } catch (error) {
        this._logger.error(
          'Failed to revert shelved binary file',
          { path: file.path },
          error instanceof Error ? error : undefined
        );
        return false;
      }
      // Clear any intent-to-add staging so the file no longer shows as a change.
      // This is best-effort; the working-tree copy is already gone at this point.
      await this._gitCli.exec(['reset', '--', file.path], { cwd, throwOnError: false });
      return true;
    }
    // modified or deleted → restore the committed bytes from HEAD.
    const result = await this._gitCli.exec(['checkout', 'HEAD', '--', file.path], {
      cwd,
      throwOnError: false,
    });
    return result.exitCode === 0;
  }

  /**
   * Resolve the list of files to shelve based on the selection.
   *
   * @param _repo - The repository (reserved for future changelist support)
   * @param changes - The selection of changes
   * @returns Array of file paths to shelve
   */
  private resolveFilesToShelve(_repo: IRepository, changes: IShelveSelection): string[] {
    const files = new Set<string>();

    // Add explicitly selected files
    if (changes.files) {
      for (const file of changes.files) {
        files.add(file);
      }
    }

    // Add files from hunks selection
    if (changes.hunks) {
      for (const filePath of changes.hunks.keys()) {
        files.add(filePath);
      }
    }

    // TODO: also include files that live only in changelists; this currently
    // covers shelf hunks only.

    return Array.from(files);
  }

  /**
   * Generate a multi-hunk diff string for a file. Delegates to the shared
   * patch builder so path escaping and the `\ No newline at end of file`
   * marker match every other patch surface — the previous hand-rolled builder
   * emitted neither, so a partial-hunk shelve of a special-char-path or
   * no-trailing-newline file produced a patch git could not reverse-apply.
   *
   * @param filePath - The file path
   * @param hunks - The hunks to include
   * @returns The diff string
   */
  private generateHunksDiff(filePath: string, hunks: IHunk[]): string {
    const header = buildPatchHeader(filePath);
    const body = hunks.flatMap((hunk) => [hunk.header, ...serializeHunkLines(hunk)]);
    return [...header, ...body].join('\n') + '\n';
  }

  /**
   * Revert shelved changes from the working directory.
   *
   * Returns the list of repo-relative file paths that could NOT be removed
   * from the working tree. When non-empty the shelve is only partial: the
   * changes are saved on the shelf but the listed files are still live.
   *
   * @param repo - The repository
   * @param shelfFiles - The shelved files
   * @param selectedHunks - Optional map of selected hunks per file
   * @returns Paths that failed to be cleared from the working tree
   */
  private async revertShelvedChanges(
    repo: IRepository,
    shelfFiles: IShelfFile[],
    selectedHunks?: Map<string, IHunk[]>
  ): Promise<string[]> {
    const cwd = repo.rootUri.fsPath;
    const failedPaths: string[] = [];

    for (const file of shelfFiles) {
      // Binary files have no text patch to reverse — restore the HEAD bytes
      // (or drop an added file) directly. A false return means the revert
      // failed; surface it as a partial-cleanup failure like the text paths.
      if (file.isBinary) {
        const ok = await this.revertBinaryShelfFile(repo, file);
        if (!ok) {
          failedPaths.push(file.path);
        }
        continue;
      }

      if (selectedHunks?.has(file.path)) {
        // Partial-hunk shelve: reverse just the selected hunks from the
        // working tree, leaving the index and the unselected hunks untouched.
        //
        // `gitCli.exec` only REJECTS on a spawn fault; a non-zero exit (the
        // patch did not apply — a stale buffer, or the old header/no-newline
        // defects) RESOLVES. Check the exit code too, or a failed cleanup is
        // reported as a clean shelve and the "shelved" hunks stay live in the
        // working tree — a later unshelve then double-applies or conflicts.
        try {
          const revert = await this._gitCli.exec(['apply', '-R', '-'], {
            cwd,
            input: file.diff,
          });
          if (revert.exitCode !== 0) {
            this._logger.debug('shelve: reverse-apply of partial hunks exited non-zero', {
              path: file.path,
              stderr: revert.stderr,
            });
            failedPaths.push(file.path);
          }
        } catch (error) {
          this._logger.debug('shelve: reverse-apply of partial hunks failed', {
            path: file.path,
            err: error instanceof Error ? error.message : String(error),
          });
          failedPaths.push(file.path);
        }
        continue;
      }

      // Full-file shelve: the captured diff is the whole change vs HEAD
      // (staged + unstaged), so removal must clear BOTH the index and the
      // working tree. `git checkout HEAD -- <file>` writes HEAD into both, so
      // staged content is dropped too (a plain `checkout -- <file>` would
      // restore from the index and leave staged changes behind).
      const checkout = await this._gitCli.exec(['checkout', 'HEAD', '--', file.path], {
        cwd,
        throwOnError: false,
      });
      if (checkout.exitCode === 0) {
        continue;
      }
      // checkout fails for a staged-NEW file (absent from HEAD). Only then is
      // `git rm -f` the right removal — confirm the path is genuinely absent
      // from HEAD first, so a transient checkout error (lock contention, etc.)
      // on a tracked file can't trigger an unintended deletion.
      const inHead =
        (
          await this._gitCli.exec(['cat-file', '-e', `HEAD:${file.path}`], {
            cwd,
            throwOnError: false,
          })
        ).exitCode === 0;
      if (inHead) {
        // A transient checkout failure on a HEAD-tracked file — leave the
        // working tree as-is and surface this as a partial-cleanup failure so
        // the caller can warn the user.
        this._logger.debug('shelve: checkout failed for a HEAD-tracked file; left as-is', {
          path: file.path,
          checkoutStderr: checkout.stderr,
        });
        failedPaths.push(file.path);
        continue;
      }
      const removed = await this._gitCli.exec(['rm', '-f', '--', file.path], {
        cwd,
        throwOnError: false,
      });
      if (removed.exitCode !== 0) {
        this._logger.debug('shelve: could not revert staged-new full-file change', {
          path: file.path,
          rmStderr: removed.stderr,
        });
        failedPaths.push(file.path);
      }
    }

    return failedPaths;
  }

  /**
   * Save a shelf item to storage.
   *
   * @param repo - The repository
   * @param item - The shelf item to save
   */
  private saveShelfItem(repo: IRepository, item: IShelfItem): void {
    const storage = this.loadShelfStorage(repo);

    // Convert to storage format
    const storageItem: IShelfStorageItem = {
      id: item.id,
      name: item.name,
      timestamp: item.timestamp.getTime(),
      files: item.files.map((file) => ({
        path: file.path,
        originalContent: '', // Not storing original content for now
        patchContent: file.diff,
        ...(file.isBinary !== undefined ? { isBinary: file.isBinary } : {}),
        ...(file.binaryContent !== undefined ? { binaryContent: file.binaryContent } : {}),
        ...(file.binaryStatus !== undefined ? { binaryStatus: file.binaryStatus } : {}),
      })),
      unshelvedAt: item.unshelvedAt?.getTime(),
      deletedAt: item.deletedAt?.getTime(),
    };

    // Add to storage
    storage.items.push(storageItem);

    // Save to file
    this.saveShelfStorage(repo, storage);

    // Update cache
    const repoKey = this.getRepoKey(repo);
    this._shelfCache.delete(repoKey);
  }

  /**
   * Load shelf storage from file.
   *
   * Parse into a `Record<string, unknown>` first, then partition into
   * known/unknown keys at both the top level and per-item level so
   * forward-compat fields survive a round trip. See
   * {@link migrateShelfStorageForTest} for the pure test-exported variant.
   *
   * @param repo - The repository
   * @returns The shelf storage
   */
  private loadShelfStorage(repo: IRepository): IShelfStorage {
    const storagePath = this.getStoragePath(repo);

    try {
      if (fs.existsSync(storagePath)) {
        const content = fs.readFileSync(storagePath, 'utf8');
        const parsed = JSON.parse(content) as unknown;
        return migrateShelfStorageForTest(parsed);
      }
    } catch (error) {
      this._logger.error(
        'Failed to load shelf storage',
        { storagePath },
        error instanceof Error ? error : undefined
      );
    }

    // Return empty storage
    return {
      version: SHELF_STORAGE_VERSION,
      items: [],
    };
  }

  /**
   * Save shelf storage to file.
   *
   * Route through {@link serializeShelfForDisk} so `_unknownTopLevel` /
   * `_unknownItem` get spread back out as anonymous sibling keys and the
   * internal bookkeeping names never appear in the JSON.
   *
   * @param repo - The repository
   * @param storage - The shelf storage to save
   */
  private saveShelfStorage(repo: IRepository, storage: IShelfStorage): void {
    const storagePath = this.getStoragePath(repo);

    try {
      // Ensure directory exists
      const dir = path.dirname(storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write storage file atomically (write-to-temp + rename). See
      // {@link atomicWriteFileSync} for the crash-during-write rationale — and
      // its "Limitations" note: this is last-writer-wins ACROSS WINDOWS, so two
      // VS Code windows on the same repo saving the shelf near-simultaneously
      // can silently overwrite each other (knowingly accepted; no cross-window
      // lock).
      const content = JSON.stringify(serializeShelfForDisk(storage), null, 2);
      atomicWriteFileSync(storagePath, content, { encoding: 'utf8' });
    } catch (error) {
      this._logger.error(
        'Failed to save shelf storage',
        { storagePath },
        error instanceof Error ? error : undefined
      );
      throw new Error('Failed to save shelf storage');
    }
  }

  /**
   * Get the storage file path for a repository.
   *
   * @param repo - The repository
   * @returns The storage file path
   */
  private getStoragePath(repo: IRepository): string {
    // Resolve the real per-worktree git dir: in a linked worktree `<root>/.git`
    // is a FILE (a `gitdir:` pointer), so the conventional `<root>/.git/<file>`
    // would throw on write. See {@link resolveWorktreeGitDir}.
    return path.join(resolveWorktreeGitDir(repo.rootUri.fsPath), SHELF_STORAGE_FILE);
  }

  /**
   * Convert a storage item to a shelf item.
   *
   * @param storageItem - The storage item
   * @returns The shelf item
   */
  private storageItemToShelfItem(storageItem: IShelfStorageItem): IShelfItem {
    return {
      id: storageItem.id,
      name: storageItem.name,
      timestamp: new Date(storageItem.timestamp),
      files: storageItem.files.map((file) => ({
        path: file.path,
        diff: file.patchContent,
        ...(file.isBinary !== undefined ? { isBinary: file.isBinary } : {}),
        ...(file.binaryContent !== undefined ? { binaryContent: file.binaryContent } : {}),
        ...(file.binaryStatus !== undefined ? { binaryStatus: file.binaryStatus } : {}),
      })),
      unshelvedAt:
        storageItem.unshelvedAt !== undefined ? new Date(storageItem.unshelvedAt) : undefined,
      deletedAt: storageItem.deletedAt !== undefined ? new Date(storageItem.deletedAt) : undefined,
    };
  }

  /**
   * Generate a unique shelf ID.
   *
   * Switched from `Math.random()` (predictable, can collide
   * across rapid shelves in the same millisecond) to `randomBytes(4)`
   * (32 bits of CSPRNG entropy → ~4.3B distinct ids per timestamp).
   * Mirrors the pattern in `src/utils/webviewNonce.ts`.
   *
   * @returns A unique ID string
   */
  private generateShelfId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString('hex');
    return `shelf-${timestamp}-${random}`;
  }

  /**
   * Get a unique key for a repository.
   *
   * @param repo - The repository
   * @returns A unique key string
   */
  private getRepoKey(repo: IRepository): string {
    return repo.rootUri.fsPath;
  }

  /**
   * Dispose of resources.
   *
   * Only dispose `_gitCli` when WE own it.
   */
  dispose(): void {
    this._logger.info('ShelfService disposing', {
      cachedRepos: this._shelfCache.size,
      ownsGitCli: this._ownsGitCli,
    });
    this._onDidChangeShelf.dispose();
    this._shelfCache.clear();

    for (const disposable of this._disposables) {
      disposable.dispose();
    }
    this._disposables = [];

    if (this._ownsGitCli) {
      const cli = this._gitCli as unknown as { dispose?: () => void };
      if (typeof cli.dispose === 'function') {
        cli.dispose();
      }
    }
  }
}

/**
 * Create a new ShelfService instance.
 *
 * @param gitCli - Optional GitCli instance to use
 * @param gitService - Optional GitService whose gitCli we adopt
 * @returns A new ShelfService instance
 */
export function createShelfService(
  gitCli?: GitCli,
  gitService?: IGitService,
  changelistService?: Pick<IChangelistService, 'moveToChangelist'>
): ShelfService {
  return new ShelfService(gitCli, gitService, changelistService);
}
