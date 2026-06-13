/**
 * Changed Files directory tree — pure transform + (later) pure render.
 *
 * `buildFileTree` turns the flat `IChangedFile[]` that the Details Panel
 * already has into a sorted, compacted directory forest matching IntelliJ's
 * folder nesting. The renderer (`renderFileTree`, added in a later task)
 * walks that forest to emit the nested Changed Files markup.
 *
 * Everything here is pure — no `this`, no DOM, no I/O — so it is directly
 * unit- and property-testable and can be shared by both the single-commit
 * and multi-commit details panels.
 */

import type { IChangedFile } from '../../interfaces/IGitToolWindowProvider';
import type { FileStatus } from '../../interfaces/IGitService';

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

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * Injected, presentation-only callbacks the renderer needs to emit a row.
 *
 * These mirror the provider's existing styling helpers (`_escapeHtml`,
 * `_getFileStatusColor`, `_getFileStatusChar`, `_getFileName`) so the leaf
 * markup is identical to today's `.changed-file-item` row. Passing them in
 * (rather than importing the provider) keeps `renderFileTree` pure and lets
 * the single-commit and multi-commit panels share one implementation.
 */
export interface IFileTreeRenderDeps {
  /** HTML-escape a user-controlled string (path, name, oldPath, hash). */
  escapeHtml: (s: string) => string;
  /** CSS color expression for a file status. */
  statusColor: (status: FileStatus) => string;
  /** Single-letter indicator for a file status (M, A, D, R, …). */
  statusChar: (status: FileStatus) => string;
  /** Base file name (last path segment) for display. */
  fileName: (path: string) => string;
  /**
   * Commit hash for the per-leaf `data-commit-hash` attribute. Omitted on the
   * multi-commit combined view, whose leaves carry no single commit hash —
   * matching today's markup which has no `data-commit-hash` there.
   */
  commitHash?: string;
}

/** Indentation per directory level, in pixels. */
const INDENT_STEP_PX = 16;
/** Base left inset shared with the existing `.changed-file-item` padding. */
const INDENT_BASE_PX = 4;

/** Depth-derived `padding-left` so depth-0 rows keep the existing 4px inset. */
function paddingLeftPx(depth: number): number {
  return depth * INDENT_STEP_PX + INDENT_BASE_PX;
}

/**
 * Render a directory forest to the nested Changed Files markup.
 *
 * `depth` starts at 0 for the top level and increases by 1 per directory
 * level. Each file leaf is a `.changed-file-item` row indented by a
 * depth-derived inline `padding-left`; this preserves the existing `dblclick`
 * event delegation (`.changed-file-item[data-path][data-commit-hash]`).
 *
 * Each directory is a collapsible `.changed-dir-item` row (IntelliJ-style):
 * it carries a chevron toggle, `aria-expanded`, and `aria-controls` pointing
 * at the `.changed-dir-children` container that wraps its descendants — so a
 * collapse is a single class toggle on that container. The tree opens fully
 * expanded; no state is persisted, so a re-render always resets to expanded.
 *
 * ARIA: the container is a `role="tree"`, directory and file rows are
 * `role="treeitem"`, and each directory's children container is a
 * `role="group"`.
 *
 * Pure given `deps`: deterministic string output, no DOM. Directory-children
 * container ids are assigned by a per-render counter, so they are stable
 * within one render (sufficient — there is no cross-render persistence).
 */
export function renderFileTree(
  nodes: readonly FileTreeNode[],
  depth: number,
  deps: IFileTreeRenderDeps
): string {
  return renderForest(nodes, depth, deps, { next: 0 });
}

/** Monotonic id source for directory-children container ids within one render. */
interface IDirIdCounter {
  next: number;
}

/** Render a sibling list of nodes, threading the shared id counter. */
function renderForest(
  nodes: readonly FileTreeNode[],
  depth: number,
  deps: IFileTreeRenderDeps,
  ids: IDirIdCounter
): string {
  return nodes.map((node) => renderNode(node, depth, deps, ids)).join('');
}

/** Render one node (directory row + children container, or a file leaf). */
function renderNode(
  node: FileTreeNode,
  depth: number,
  deps: IFileTreeRenderDeps,
  ids: IDirIdCounter
): string {
  return node.kind === 'directory'
    ? renderDirectory(node, depth, deps, ids)
    : renderLeaf(node, depth, deps);
}

/**
 * Emit a collapsible directory row followed by a `.changed-dir-children`
 * container holding its children rendered at `depth + 1`.
 *
 * The row carries a `codicon-chevron-down` toggle (expanded by default),
 * `role="treeitem"`, `aria-expanded="true"`, and `aria-controls` referencing
 * the container's id. `tabindex="0"` puts it in the tab order so the toggle is
 * keyboard-operable (the webview script toggles on click and on Enter/Space).
 * It has no `data-path` / `data-commit-hash`, so the `dblclick` file-open
 * delegation never matches it. Collapse is driven by the webview script
 * toggling a class on the referenced container.
 */
function renderDirectory(
  node: IDirectoryNode,
  depth: number,
  deps: IFileTreeRenderDeps,
  ids: IDirIdCounter
): string {
  const padding = paddingLeftPx(depth);
  const label = deps.escapeHtml(node.name);
  const containerId = `dir-children-${ids.next++}`;
  const childrenHtml = renderForest(node.children, depth + 1, deps, ids);

  return `
          <div class="changed-dir-item" role="treeitem" aria-expanded="true" aria-controls="${containerId}" tabindex="0" style="padding-left: ${padding}px;">
            <span class="dir-chevron codicon codicon-chevron-down" aria-hidden="true"></span>
            <span class="dir-name">${label}</span>
          </div>
          <div class="changed-dir-children" role="group" id="${containerId}">${childrenHtml}</div>`;
}

/**
 * Emit the `.changed-file-item` row. All existing data attributes are
 * preserved: `data-path`, `data-status`, `data-commit-hash` (only when
 * `deps.commitHash` is set), `tabindex="0"`, the color-coded status
 * indicator/letter, the file name, and the `renamed` old-path on the same
 * row. The row carries `role="treeitem"` to match the surrounding directory
 * tree's `role="tree"` / `role="group"` semantics.
 */
function renderLeaf(node: IFileLeaf, depth: number, deps: IFileTreeRenderDeps): string {
  const { file } = node;
  const padding = paddingLeftPx(depth);
  const statusColor = deps.statusColor(file.status);
  const statusChar = deps.statusChar(file.status);
  const fileName = deps.escapeHtml(deps.fileName(file.path));

  const commitHashAttr =
    deps.commitHash !== undefined
      ? `\n               data-commit-hash="${deps.escapeHtml(deps.commitHash)}"`
      : '';

  // For renames, show the old path as well — full value retained.
  const renameInfo =
    file.status === 'renamed' && file.oldPath
      ? ` <span class="rename-arrow">←</span> <span class="old-path" title="${deps.escapeHtml(file.oldPath)}">${deps.escapeHtml(file.oldPath)}</span>`
      : '';

  return `
          <div class="changed-file-item"
               data-path="${deps.escapeHtml(file.path)}"
               data-status="${file.status}"${commitHashAttr}
               role="treeitem"
               tabindex="0"
               style="padding-left: ${padding}px;">
            <span class="file-status-indicator" style="color: ${statusColor};" title="${file.status}">
              ${statusChar}
            </span>
            <span class="file-name" style="color: ${statusColor};">
              ${fileName}
            </span>
            ${renameInfo}
          </div>`;
}
