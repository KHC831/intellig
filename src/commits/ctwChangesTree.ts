/**
 * Pure shaping helpers for the Commit tool window's Local Changes list: the
 * directory grouping, the unversioned split, and the one-letter status glyph.
 * No vscode, no git — data in, render shapes out, so the unit and snapshot
 * suites can exercise them without a host.
 */

import type { IChangelist, IFileChange } from '../changelists/interfaces/IChangelistService';
/** Sentinel id for the "Unversioned Files" pseudo-changelist. */
export const UNVERSIONED_PSEUDO_CHANGELIST_ID = '_unversioned';

/** A node in the directory-grouped file tree. Pure data — unit-tested. */
export interface IChangesTreeDirNode {
  /** Directory path relative to the repo root (`''` for repo root). */
  dir: string;
  /** Files that live directly in this directory. */
  files: IFileChange[];
}

/**
 * Group a changelist's files into directory buckets, sorted by directory then
 * filename. Each bucket holds the files that live directly in that directory
 * (no nested recursion — IntelliJ collapses single-child chains, but a flat
 * per-directory bucket is the simplest faithful grouping and keeps the render
 * + tests tractable).
 *
 * Pure — exported for unit + snapshot tests.
 */
export function groupFilesByDirectory(files: readonly IFileChange[]): IChangesTreeDirNode[] {
  const byDir = new Map<string, IFileChange[]>();
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const dir = slash === -1 ? '' : f.path.slice(0, slash);
    const bucket = byDir.get(dir);
    if (bucket) {
      bucket.push(f);
    } else {
      byDir.set(dir, [f]);
    }
  }
  return Array.from(byDir.entries())
    .map(([dir, dirFiles]) => ({
      dir,
      files: [...dirFiles].sort((a, b) => basename(a.path).localeCompare(basename(b.path))),
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Last path segment (basename) of a repo-relative path. */
export function basename(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}

/**
 * Split untracked (`untracked`) files out of the changelists into a separate
 * "Unversioned Files" bucket — IntelliJ renders these under a dedicated
 * top-level node rather than inside a changelist. Pure; the changelists are
 * returned with their untracked files removed so a file never renders twice.
 *
 * Exported for unit/snapshot tests.
 */
export function partitionUnversionedFiles(changelists: readonly IChangelist[]): {
  changelists: IChangelist[];
  unversioned: IFileChange[];
} {
  const unversioned: IFileChange[] = [];
  const filtered = changelists.map((cl) => {
    const tracked: IFileChange[] = [];
    for (const f of cl.files) {
      if (f.status === 'untracked') {
        unversioned.push(f);
      } else {
        tracked.push(f);
      }
    }
    return { ...cl, files: tracked };
  });
  unversioned.sort((a, b) => a.path.localeCompare(b.path));
  return { changelists: filtered, unversioned };
}

export function shortStatusChar(status: string): string {
  switch (status) {
    case 'modified':
      return 'M';
    case 'added':
      return 'A';
    case 'deleted':
      return 'D';
    case 'renamed':
      return 'R';
    case 'copied':
      return 'C';
    case 'untracked':
      return '?';
    case 'ignored':
      return '!';
    case 'conflicted':
      return 'U';
    default:
      return status.charAt(0).toUpperCase();
  }
}
