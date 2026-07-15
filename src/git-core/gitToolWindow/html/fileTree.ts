/**
 * Changed Files directory tree — pure transform.
 *
 * `buildFileTree` turns the flat `IChangedFile[]` that the Details Panel
 * already has into a sorted, compacted directory forest matching IntelliJ's
 * folder nesting. The webview's `buildDetailsPanelDom` (webview/detailsPanelDom)
 * walks an annotated form of that forest to build the nested Changed Files DOM.
 *
 * Everything here is pure — no `this`, no DOM, no I/O — so it is directly
 * unit- and property-testable and can be shared by both the single-commit
 * and multi-commit details panels.
 */

import type { IChangedFile } from '../../interfaces/IGitToolWindowProvider';

/** A node in the Changed Files directory tree. */
export type FileTreeNode = IDirectoryNode | IFileLeaf;

/** A directory segment (or compacted chain of segments) containing children. */
export interface IDirectoryNode {
  kind: 'directory';
  /**
   * Display label: a single segment, or '/'-joined segments after compaction
   * (e.g. 'src/main/java'). Never empty.
   */
  name: string;
  /**
   * Sorted children: all DirectoryNodes before all FileLeaves, each group
   * ascending case-insensitive by name.
   */
  children: FileTreeNode[];
}

/** A single changed file at the end of its path. */
export interface IFileLeaf {
  kind: 'file';
  /** The base file name (last path segment), used for display and sorting. */
  name: string;
  /**
   * The original changed-file record, carried verbatim so path/status/oldPath
   * survive into the rendered data attributes.
   */
  file: IChangedFile;
}

/**
 * Build a sorted, compacted directory forest from a flat changed-file list.
 *
 * - Groups files by their '/'-separated directory segments.
 * - Collapses single-child directory chains into one node (IntelliJ
 *   compaction): a directory whose only child is another directory is
 *   merged, joining segments with '/'.
 * - Orders children: all directories before all files, each group sorted
 *   ascending case-insensitive by name.
 * - Files at the repository root (no '/') become top-level leaves.
 *
 * Pure: no I/O, no DOM, deterministic for a given input.
 */
export function buildFileTree(files: readonly IChangedFile[]): FileTreeNode[] {
  // 1. Insert — grow the forest one file at a time, reusing shared directories.
  const roots: FileTreeNode[] = [];
  for (const file of files) {
    insertFile(roots, file);
  }

  // 2. Compact — collapse single-child directory→directory chains.
  const compacted = compactNodes(roots);

  // 3. Sort — directories before files, each group case-insensitively sorted.
  return sortNodes(compacted);
}

/**
 * Insert one changed file into the forest, walking/creating a DirectoryNode
 * per path segment and attaching a FileLeaf for the final segment.
 *
 * Empty segments (from `//`, leading/trailing `/`) are skipped so a
 * DirectoryNode's name is never empty. A path with no usable directory
 * segment becomes a top-level leaf (repository-root files).
 */
function insertFile(roots: FileTreeNode[], file: IChangedFile): void {
  const segments = file.path.split('/').filter((segment) => segment.length > 0);

  // Defensive: a path that is empty or only separators yields no segments.
  // Carry it as a top-level leaf rather than dropping the file or creating
  // an empty-named directory.
  if (segments.length === 0) {
    roots.push({ kind: 'file', name: file.path, file });
    return;
  }

  const fileName = segments[segments.length - 1];
  const directorySegments = segments.slice(0, -1);

  let children = roots;
  for (const segment of directorySegments) {
    let directory = children.find(
      (node): node is IDirectoryNode => node.kind === 'directory' && node.name === segment
    );
    if (!directory) {
      directory = { kind: 'directory', name: segment, children: [] };
      children.push(directory);
    }
    children = directory.children;
  }

  children.push({ kind: 'file', name: fileName, file });
}

/**
 * Compact each directory whose sole child is another directory into one node
 * whose label is the '/'-joined segments. Children are compacted first so a
 * label like `src/main/java` is produced bottom-up in a single pass.
 */
function compactNodes(nodes: readonly FileTreeNode[]): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind !== 'directory') {
      return node;
    }

    let directory: IDirectoryNode = {
      kind: 'directory',
      name: node.name,
      children: compactNodes(node.children),
    };

    while (directory.children.length === 1 && directory.children[0].kind === 'directory') {
      const onlyChild = directory.children[0];
      directory = {
        kind: 'directory',
        name: `${directory.name}/${onlyChild.name}`,
        children: onlyChild.children,
      };
    }

    return directory;
  });
}

/**
 * Recursively order siblings with all directories before all files, each
 * group sorted ascending case-insensitive by display name.
 */
function sortNodes(nodes: readonly FileTreeNode[]): FileTreeNode[] {
  const sorted = [...nodes].sort(compareNodes);
  for (const node of sorted) {
    if (node.kind === 'directory') {
      node.children = sortNodes(node.children);
    }
  }
  return sorted;
}

/** Directories sort before files; within a kind, case-insensitive by name. */
function compareNodes(a: FileTreeNode, b: FileTreeNode): number {
  if (a.kind !== b.kind) {
    return a.kind === 'directory' ? -1 : 1;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
