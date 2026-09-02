/**
 * Pure render-model builder for the Commit tool window.
 *
 * Turns changelists into the JSON island the webview maps to DOM. Vscode-free
 * and side-effect-free, so the whole tree shape is unit-testable without ever
 * constructing a webview.
 */

import type { IChangelist, IFileChange } from '../changelists/interfaces/IChangelistService';
import type { IShelfItem } from '../shelf/interfaces/IShelfService';
import type {
  ChangesGroupingMode,
  CommitToolWindowTab,
  ICommitToolWindowInitModel,
  ICtwChangelistModel,
  ICtwConflictEntry,
  ICtwConflictsModel,
  ICtwFileEntry,
  IShelfTabEntry,
  ShelfTabFilter,
} from './commitToolWindow.types';
import {
  basename,
  groupFilesByDirectory,
  partitionConflictedFiles,
  partitionUnversionedFiles,
  shortStatusChar,
  UNVERSIONED_PSEUDO_CHANGELIST_ID,
} from './ctwChangesTree';
import { buildShelfTabEntries, gearMenuItems } from './shelfTab';

export interface IRenderInput {
  activeTab: CommitToolWindowTab;
  changelists: readonly IChangelist[];
  shelfItems: readonly IShelfItem[];
  /** Unified shelf+stash entries. Derived from shelfItems + stashes. */
  shelfTabEntries?: readonly IShelfTabEntry[];
  /** Active Shelf-tab filter, used to render the segmented control. */
  shelfTabFilter?: ShelfTabFilter;
  composer: { message: string; amend: boolean; signOff: boolean; noVerify?: boolean };
  activeChangelistId?: string;
  /** Local Changes file-grouping mode. Defaults to `flat` when omitted. */
  grouping?: ChangesGroupingMode;
  /** Checked file paths (host-owned inclusion model). Defaults to none. */
  selectedFiles?: readonly string[];
  /** Repo root these rows were built from (the retarget guard's stamp). */
  repoRoot?: string;
  /**
   * Conflict-region count per repo-relative path, for the rows lifted into the
   * Merge Conflicts node. Computed by the host (it reads files); the builder
   * stays pure and synchronous.
   */
  conflictRegionCounts?: ReadonlyMap<string, number>;
}

/** Map an {@link IFileChange} to its render-model entry. */
function buildCtwFileEntry(f: IFileChange, displayName: string): ICtwFileEntry {
  const entry: ICtwFileEntry = {
    path: f.path,
    statusChar: shortStatusChar(f.status),
    displayName,
  };
  if (f.status === 'conflicted') {
    entry.conflicted = true;
  }
  if (f.status === 'untracked') {
    entry.untracked = true;
  }
  return entry;
}

/**
 * Build the file portion of a changelist's render model, honoring the grouping
 * mode. Flat mode yields a `files` array (full paths); directory mode yields
 * `dirGroups` bucketed by directory (basenames), mirroring renderChangelistFiles.
 */
function buildCtwChangelistFiles(
  files: readonly IFileChange[],
  grouping: ChangesGroupingMode
): Pick<ICtwChangelistModel, 'files' | 'dirGroups'> {
  if (grouping === 'directory') {
    return {
      dirGroups: groupFilesByDirectory(files).map((node) => ({
        dir: node.dir.length > 0 ? node.dir : null,
        files: node.files.map((f) => buildCtwFileEntry(f, basename(f.path))),
      })),
    };
  }
  return { files: files.map((f) => buildCtwFileEntry(f, f.path)) };
}

/**
 * Precompute the full {@link ICommitToolWindowInitModel} from render input.
 * Exported for unit/jsdom tests that assert the built DOM.
 */
export function buildCommitToolWindowInitModel(input: IRenderInput): ICommitToolWindowInitModel {
  const { activeTab, changelists, shelfItems, composer, activeChangelistId } = input;
  const grouping: ChangesGroupingMode = input.grouping ?? 'flat';
  // Derive combined entries when not already computed. Callers that skip
  // the field get a shelf-only view (legacy behavior).
  const shelfTabFilter: ShelfTabFilter = input.shelfTabFilter ?? 'shelves';
  const shelfTabEntries: readonly IShelfTabEntry[] =
    input.shelfTabEntries ?? buildShelfTabEntries(shelfItems, [], shelfTabFilter);

  /**
   * The Merge Conflicts node for one changelist's unmerged files, or null.
   * Nested inside the changelist rather than hoisted above every list, so a
   * list holding nothing but conflicts keeps its header and its own actions.
   */
  const conflictsFor = (
    conflicted: readonly IFileChange[],
    changelistId: string
  ): ICtwConflictsModel | null =>
    conflicted.length === 0
      ? null
      : {
          fileCount: conflicted.length,
          files: conflicted.map((file) => {
            const entry: ICtwConflictEntry = {
              ...buildCtwFileEntry(file, file.path),
              changelistId,
            };
            const regions = input.conflictRegionCounts?.get(file.path);
            if (typeof regions === 'number' && regions > 0) {
              entry.conflictCount = regions;
            }
            return entry;
          }),
        };

  const { changelists: tracked, unversioned } = partitionUnversionedFiles(changelists);
  const changelistModels: ICtwChangelistModel[] = tracked.map((cl) => {
    // Unmerged files come out of the ordinary buckets and into this list's own
    // conflicts node; `fileCount` still counts every file the list owns.
    const { rest, conflicted } = partitionConflictedFiles(cl.files);
    return {
      id: cl.id,
      name: cl.name,
      isActive: cl.id === activeChangelistId,
      fileCount: cl.files.length,
      conflicts: conflictsFor(conflicted, cl.id),
      ...buildCtwChangelistFiles(rest, grouping),
    };
  });
  const unversionedModel: ICtwChangelistModel | null =
    unversioned.length === 0
      ? null
      : {
          id: UNVERSIONED_PSEUDO_CHANGELIST_ID,
          name: 'Unversioned Files',
          isActive: false,
          fileCount: unversioned.length,
          ...buildCtwChangelistFiles(unversioned, grouping),
        };

  const emptyCopy =
    shelfTabFilter === 'stashes'
      ? 'No stash entries.'
      : shelfTabFilter === 'shelves'
        ? 'Shelf is empty.'
        : 'No shelf or stash entries.';

  return {
    activeTab,
    repoRoot: input.repoRoot,
    showLocal: activeTab === 'localChanges',
    grouping,
    gearItems: gearMenuItems(composer.noVerify ?? false),
    composer: { message: composer.message, amend: composer.amend, signOff: composer.signOff },
    selectedFiles: [...(input.selectedFiles ?? [])],
    local: {
      empty: changelists.length === 0,
      changelists: changelistModels,
      unversioned: unversionedModel,
    },
    shelf: {
      filter: shelfTabFilter,
      empty: shelfTabEntries.length === 0,
      emptyCopy,
      rows: shelfTabEntries.map((entry) =>
        entry.kind === 'shelf'
          ? {
              kind: 'shelf' as const,
              id: entry.id,
              name: entry.name,
              alreadyUnshelved: entry.unshelvedAt !== undefined,
              fileCount: entry.fileCount,
            }
          : {
              kind: 'stash' as const,
              index: entry.index,
              name: entry.name,
              id: entry.id,
              hash: entry.hash,
            }
      ),
    },
  };
}
