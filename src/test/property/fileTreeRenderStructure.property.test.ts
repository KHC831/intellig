// Feature: git-view-layout-parity, Property 4
/**
 * Property-based tests for the Changed Files directory-tree renderer.
 *
 * Feature: git-view-layout-parity
 * Property 4: Rendered rows preserve list semantics and indentation monotonicity
 *
 * Property Description:
 * For any set of changed files, in the output of
 * `renderFileTree(buildFileTree(files), 0, deps)` every emitted row (directory
 * or file) carries `role="listitem"`, every child row's indentation
 * (`padding-left`) is strictly greater than that of its parent directory row,
 * and all rows sharing the same parent are emitted at equal indentation.
 *
 *
 * Approach: the renderer emits a flat sequence of sibling rows — each a
 * `.changed-dir-item` or `.changed-file-item` div carrying `role="listitem"`
 * and a depth-derived `padding-left` — in pre-order DFS order (a directory row
 * is immediately followed by its descendants). We parse the emitted rows in
 * order, derive each row's nesting from its `padding-left`, reconstruct the
 * parent of every row with a stack, and check the three sub-properties against
 * that reconstructed structure (no reliance on the source's internal formula
 * beyond reading the rendered `padding-left` values).
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  buildFileTree,
  renderFileTree,
  IFileTreeRenderDeps,
} from '../../git-core/gitToolWindow/html/fileTree';
import { IChangedFile } from '../../git-core/interfaces/IGitToolWindowProvider';
import { FileStatus } from '../../git-core/interfaces/IGitService';

// ─── Generators ─────────────────────────────────────────────────────────────

/**
 * Path segment alphabet deliberately mixes upper- and lower-case letters and
 * digits so shared prefixes — and therefore non-trivial sibling groups and
 * deep nesting — are common, exercising the indentation invariant at multiple
 * levels.
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
 * A '/'-joined path with 0–5 directory segments and a trailing file name.
 * Zero directory segments yields a repository-root file (top-level leaf), so
 * the generator mixes files and directories at every depth.
 */
const filePathArb: fc.Arbitrary<string> = fc
  .tuple(fc.array(segmentArb, { minLength: 0, maxLength: 5 }), fileNameArb)
  .map(([dirs, name]) => [...dirs, name].join('/'));

/** All status values are valid; rendering structure does not depend on status. */
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

const changedFileArb: fc.Arbitrary<IChangedFile> = fc
  .tuple(filePathArb, fileStatusArb, fc.option(filePathArb, { nil: undefined }))
  .map(([path, status, oldPath]) =>
    status === 'renamed' && oldPath !== undefined ? { path, status, oldPath } : { path, status }
  );

/**
 * Arrays of changed files with unique paths (duplicate paths are collapsed so
 * the forest reflects a realistic changed-file set). Depth and prefix sharing
 * are intentionally varied.
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

// ─── Render dependency stub ───────────────────────────────────────────────────

/**
 * A simple, deterministic `FileTreeRenderDeps` stub. `escapeHtml` escapes the
 * five HTML-significant characters so no raw `>` leaks into an attribute value
 * (which the row parser relies on to find the end of each opening tag).
 */
const deps: IFileTreeRenderDeps = {
  escapeHtml: (s: string): string =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;'),
  statusColor: (status: FileStatus): string => `var(--status-${status})`,
  statusChar: (status: FileStatus): string => status.charAt(0).toUpperCase(),
  fileName: (path: string): string => {
    const segments = path.split('/').filter((s) => s.length > 0);
    return segments.length === 0 ? path : segments[segments.length - 1];
  },
  commitHash: 'deadbeef',
};

// ─── Row parsing ──────────────────────────────────────────────────────────────

interface ParsedRow {
  kind: 'directory' | 'file';
  hasListitemRole: boolean;
  paddingLeft: number;
}

/**
 * Parse the emitted HTML into the ordered list of rows. Each row is an opening
 * `<div class="changed-dir-item" …>` or `<div class="changed-file-item" …>`
 * tag; matches arrive in document order, which is the renderer's pre-order DFS
 * order. For each opening tag we read whether it carries `role="listitem"` and
 * its `padding-left` pixel value.
 */
function parseRows(html: string): ParsedRow[] {
  // Non-greedy `[\s\S]*?` captures the (possibly multi-line) attribute block up
  // to the first `>`, which is the end of the opening tag — attribute values
  // never contain a raw `>` because every interpolated value is HTML-escaped.
  const rowRe = /<div class="(changed-dir-item|changed-file-item)"([\s\S]*?)>/g;
  const rows: ParsedRow[] = [];
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const [, className, attrs] = match;
    const paddingMatch = /padding-left:\s*(\d+)px/.exec(attrs);
    assert.ok(
      paddingMatch !== null,
      `Row "${className}" is missing a numeric padding-left; attrs were: ${attrs}`
    );
    rows.push({
      kind: className === 'changed-dir-item' ? 'directory' : 'file',
      hasListitemRole: /role="listitem"/.test(attrs),
      paddingLeft: Number(paddingMatch[1]),
    });
  }
  return rows;
}

// ─── Property Test ──────────────────────────────────────────────────────────

describe('Feature: git-view-layout-parity - Changed Files Render Structure', () => {
  describe('Property 4: Rendered rows preserve list semantics and indentation monotonicity', () => {
    it('Feature: git-view-layout-parity, Property 4: every row is a listitem, children indent strictly beyond their parent, and siblings share equal indentation', () => {
      fc.assert(
        fc.property(changedFilesArb, (files) => {
          const html = renderFileTree(buildFileTree(files), 0, deps);
          const rows = parseRows(html);

          // The number of emitted rows equals directory nodes + file leaves.
          // (Sanity: at least one row per input file must be present.)
          assert.ok(
            rows.length >= files.length,
            `Expected at least ${files.length} rows (one per file), got ${rows.length}`
          );

          // Walk the pre-order row sequence, reconstructing each row's parent
          // directory with a stack keyed on padding-left. `ROOT` is the virtual
          // top-level parent shared by all depth-0 rows.
          const ROOT = -1;
          const openDirs: Array<{ id: number; padding: number }> = [];
          const childrenByParent = new Map<number, number[]>();
          let nextDirId = 0;

          rows.forEach((row, index) => {
            // 1. Every emitted row carries role="listitem".
            assert.ok(row.hasListitemRole, `Row ${index} (${row.kind}) is missing role="listitem"`);

            // Pop ancestors that are no longer enclosing this row (any open
            // directory whose indentation is >= this row's is a sibling or
            // shallower, not an ancestor).
            while (
              openDirs.length > 0 &&
              openDirs[openDirs.length - 1].padding >= row.paddingLeft
            ) {
              openDirs.pop();
            }

            const parent = openDirs.length > 0 ? openDirs[openDirs.length - 1] : null;
            const parentId = parent ? parent.id : ROOT;

            // 2. A child row's indentation is strictly greater than that of its
            // parent directory row. Top-level rows (no
            //    parent directory) must sit at the base indentation.
            if (parent) {
              assert.ok(
                parent.padding < row.paddingLeft,
                `Row ${index} (${row.kind}) padding-left ${row.paddingLeft}px is not ` +
                  `strictly greater than its parent directory's ${parent.padding}px`
              );
            }

            // Record this row under its parent for the equal-sibling check.
            const group = childrenByParent.get(parentId) ?? [];
            group.push(row.paddingLeft);
            childrenByParent.set(parentId, group);

            // A directory row opens a new nesting level for the rows that follow.
            if (row.kind === 'directory') {
              openDirs.push({ id: nextDirId++, padding: row.paddingLeft });
            }
          });

          // 3. All rows sharing the same parent are emitted at equal
          // indentation.
          for (const [parentId, paddings] of childrenByParent) {
            const first = paddings[0];
            for (const p of paddings) {
              assert.strictEqual(
                p,
                first,
                `Rows sharing parent ${parentId === ROOT ? '<root>' : `#${parentId}`} ` +
                  `have unequal padding-left: found ${p}px and ${first}px`
              );
            }
          }
        }),
        { numRuns: 200 }
      );
    });
  });
});
