/**
 * Shelf storage — the on-disk JSON shape, its parse (migrate) half and its
 * serialize half.
 *
 * A self-contained forward-compat round-trip — unknown top-level, per-item,
 * and per-file keys are preserved verbatim across load/save cycles, and a
 * malformed record degrades rather than throwing — with nothing here
 * reaching into ShelfService itself.
 */

import { getLogger } from '../utils/logger';

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
export const SHELF_STORAGE_VERSION = 2;

/**
 * Shelf storage file name.
 * Stored in the .git directory to keep it repository-specific.
 */
export const SHELF_STORAGE_FILE = 'intellig-shelf.json';

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
export interface IShelfStorage {
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
export interface IShelfStorageItem {
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
export interface IShelfStorageFile {
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
    const unknownItem = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(item)) {
      if (!KNOWN_SHELF_ITEM_KEYS.has(k)) {
        unknownItem[k] = item[k];
      }
    }
    const rawFiles = Array.isArray(item.files)
      ? (item.files as unknown[]).map((f): IShelfStorageFile => {
          const fileRec = f !== null && typeof f === 'object' ? (f as Record<string, unknown>) : {};
          const unknownFileField = Object.create(null) as Record<string, unknown>;
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
    const itemId = typeof item.id === 'string' ? item.id : '';
    const files = rawFiles.filter((f) => f.path.length > 0); // never '' — matches every pathspec
    const droppedCount = rawFiles.length - files.length;
    if (droppedCount > 0) {
      // Every other malformed input here is preserved (unknown keys land in
      // _unknownFileField/_unknownItem); this branch is the one that
      // deletes, so it is the one that must not do so silently — the next
      // unrelated shelf action (load -> mutate -> save) would otherwise
      // persist the loss to disk with no trace.
      getLogger()
        .child({ component: 'ShelfService' })
        .warn('Dropped shelf file record(s) with no usable path', { itemId, droppedCount });
    }
    return {
      id: itemId,
      name: typeof item.name === 'string' ? item.name : '',
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : 0,
      files,
      ...(typeof item.unshelvedAt === 'number' ? { unshelvedAt: item.unshelvedAt } : {}),
      ...(typeof item.deletedAt === 'number' ? { deletedAt: item.deletedAt } : {}),
      ...(Object.keys(unknownItem).length > 0 ? { _unknownItem: unknownItem } : {}),
    };
  });

  const unknownTopLevel = Object.create(null) as Record<string, unknown>;
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
