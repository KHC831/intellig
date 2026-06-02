// Feature: git-view-layout-parity, Property 3
/**
 * Property-based tests for Changed Files directory-tree sibling ordering.
 *
 * Feature: git-view-layout-parity
 * Property 3: Siblings are ordered directories-first, then case-insensitively sorted
 *
 * Property Description:
 * For any set of changed files, at every node of `buildFileTree(files)` all
 * `DirectoryNode` children appear before all `FileLeaf` children, and within each
 * of those two groups the children are in ascending case-insensitive lexicographic
 * order by display name (the directory's joined-segment label or the leaf's file
 * name).
 *
 * Validates: Requirements 2.13
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import { buildFileTree, FileTreeNode } from '../../git-core/gitToolWindow/html/fileTree';
import { IChangedFile } from '../../git-core/interfaces/IGitToolWindowProvider';
import { FileStatus } from '../../git-core/interfaces/IGitService';

// ─── Generators ─────────────────────────────────────────────────────────────

/**
 * Path segment alphabet deliberately mixes upper- and lower-case letters and
 * digits so the case-insensitive ordering invariant is actually exercised
 * (e.g. `App` vs `app`, `B` vs `b`). A small alphabet also makes shared
 * prefixes — and therefore non-trivial sibling groups — common.
 */
const segmentChar = fc.constantFrom(...'aAbBcCdDeEmMnNxXyYzZ0123456789'.split(''));

/** A single non-empty path segment (1–5 mixed-case chars). */
const segmentArb: fc.Arbitrary<string> = fc.stringOf(segmentChar, {
  minLength: 1,
  maxLength: 5,
});

/** A file name = a segment plus a common extension. */
const fileNameArb: fc.Arbitrary<string> = fc
  .tuple(segmentArb, fc.constantFrom('.ts', '.js', '.md', '.txt', '.java'))
  .map(([base, ext]) => base + ext);

/**
 * A '/'-joined path with 0–4 directory segments and a trailing file name.
 * Zero directory segments yields a repository-root file, so the generator
 * mixes files and directories at every level.
 */
const filePathArb: fc.Arbitrary<string> = fc
  .tuple(fc.array(segmentArb, { minLength: 0, maxLength: 4 }), fileNameArb)
  .map(([dirs, name]) => [...dirs, name].join('/'));

/** All status values are valid; ordering does not depend on status. */
const fileStatusArb: fc.Arbitrary<FileStatus> = fc.constantFrom(
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'ignored',
  'conflicted'
);

const changedFileArb: fc.Arbitrary<IChangedFile> = fc.record({
  path: filePathArb,
  status: fileStatusArb,
});

/**
 * Arrays of changed files with unique paths (duplicate paths are collapsed so
 * the forest reflects a realistic changed-file set).
 */
const changedFilesArb: fc.Arbitrary<IChangedFile[]> = fc
  .array(changedFileArb, { minLength: 0, maxLength: 25 })
  .map((files) => {
    const seen = new Set<string>();
    const unique: IChangedFile[] = [];
    for (const f of files) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        unique.push(f);
      }
    }
    return unique;
  });

// ─── Assertion helpers ──────────────────────────────────────────────────────

/** Case-insensitive comparison by display name, matching `buildFileTree`. */
function compareByDisplayName(a: FileTreeNode, b: FileTreeNode): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Assert the ordering invariant for one sibling list (the forest root or any
 * directory's children):
 *   1. all directories precede all files, and
 *   2. each group is ascending case-insensitive by display name.
 * Then recurse into every directory child.
 */
function assertOrdered(children: readonly FileTreeNode[], pathLabel: string): void {
  // 1. Directories-first: once a file is seen, no directory may follow.
  let seenFile = false;
  for (const child of children) {
    if (child.kind === 'file') {
      seenFile = true;
    } else if (seenFile) {
      assert.fail(
        `At "${pathLabel || '<root>'}": directory "${child.name}" appears after a file; ` +
          `all DirectoryNodes must precede all FileLeaves`
      );
    }
  }

  // 2. Each group ascending case-insensitive by display name.
  const directories = children.filter((c) => c.kind === 'directory');
  const files = children.filter((c) => c.kind === 'file');

  for (const [groupName, group] of [
    ['directory', directories],
    ['file', files],
  ] as const) {
    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const curr = group[i];
      assert.ok(
        compareByDisplayName(prev, curr) <= 0,
        `At "${pathLabel || '<root>'}": ${groupName} group not in ascending ` +
          `case-insensitive order — "${prev.name}" precedes "${curr.name}"`
      );
    }
  }

  // Recurse into directory children.
  for (const child of children) {
    if (child.kind === 'directory') {
      assertOrdered(child.children, pathLabel ? `${pathLabel}/${child.name}` : child.name);
    }
  }
}

// ─── Property Test ──────────────────────────────────────────────────────────

describe('Feature: git-view-layout-parity - Changed Files Tree Sibling Ordering', () => {
  describe('Property 3: Siblings are ordered directories-first, then case-insensitively sorted', () => {
    it('Feature: git-view-layout-parity, Property 3: at every node, directories precede files and each group is ascending case-insensitive by display name', () => {
      fc.assert(
        fc.property(changedFilesArb, (files) => {
          const forest = buildFileTree(files);
          assertOrdered(forest, '');
        }),
        { numRuns: 200 }
      );
    });
  });
});
