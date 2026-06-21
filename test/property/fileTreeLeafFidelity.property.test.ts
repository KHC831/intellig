// Feature: git-view-layout-parity, Property 5
/**
 * Property-based tests for Changed Files directory-tree leaf fidelity.
 *
 * Feature: git-view-layout-parity
 * Property 5: Rendered leaves preserve file identity, status, and rename metadata
 *
 * Property Description:
 * For any set of changed files rendered with a commit hash, every emitted file
 * row preserves: `data-path` equal to the escaped original full path,
 * `data-commit-hash` equal to the escaped commit hash, the status letter and
 * status color for the file's status, the file's base name, and — when the
 * file's status is `renamed` — the full escaped `oldPath` on the same row.
 * Consequently the double-click selector
 * `.changed-file-item[data-path][data-commit-hash]` matches every file leaf.
 *
 *
 * The render dependencies (`escapeHtml`, `statusColor`, `statusChar`,
 * `fileName`) intentionally mirror the provider's real helpers
 * (`_escapeHtml`, `_getFileStatusColor`, `_getFileStatusChar`,
 * `_getFileName`) — reusing the exported `FILE_STATUS_THEME_VARS` /
 * `INTELLIJ_FILE_STATUS_COLORS` tables — so the property reflects the markup
 * the Details Panel actually emits.
 */

import * as fc from 'fast-check';
import * as assert from 'assert';
import {
  buildFileTree,
  renderFileTree,
  IFileTreeRenderDeps,
} from '../../src/git-core/gitToolWindow/html/fileTree';
import { IChangedFile } from '../../src/git-core/interfaces/IGitToolWindowProvider';
import { FileStatus } from '../../src/git-core/interfaces/IGitService';
import {
  FILE_STATUS_THEME_VARS,
  INTELLIJ_FILE_STATUS_COLORS,
} from '../../src/git-core/gitToolWindow/GitToolWindowProvider';

// ─── Provider-mirrored render dependencies ──────────────────────────────────

/** Mirrors `GitToolWindowProvider._escapeHtml`. */
function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
}

/** Mirrors `GitToolWindowProvider._getFileStatusColor`. */
function statusColor(status: FileStatus): string {
  const cssVar = FILE_STATUS_THEME_VARS[status];
  const fallback = INTELLIJ_FILE_STATUS_COLORS[status] || '#FFFFFF';
  return cssVar ? `var(${cssVar}, ${fallback})` : fallback;
}

/** Mirrors `GitToolWindowProvider._getFileStatusChar`. */
function statusChar(status: FileStatus): string {
  const statusChars: Record<FileStatus, string> = {
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    untracked: 'U',
    ignored: 'I',
    conflicted: '!',
  };
  return statusChars[status] || '?';
}

/** Mirrors `GitToolWindowProvider._getFileName`. */
function fileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

// ─── Generators ─────────────────────────────────────────────────────────────

/**
 * Path-segment characters: mixed-case alphanumerics plus the five HTML-special
 * characters the renderer must escape (`& < > " '`). Including the special
 * characters exercises the escaping contract (data-path / oldPath / file name
 * are escaped). The pool deliberately excludes `/` (a separator) and any
 * whitespace, so segments are never empty after splitting and file-name
 * extraction has no leading/trailing whitespace to disambiguate.
 */
const plainSegChar = fc.constantFrom(...'aAbBcCdDmMnNxXyYzZ0123456789'.split(''));
const specialSegChar = fc.constantFrom('<', '>', '&', '"', "'");
const segChar = fc.oneof(
  { weight: 6, arbitrary: plainSegChar },
  { weight: 1, arbitrary: specialSegChar }
);

/** A single non-empty path segment (1–5 mixed/special chars, no `/`). */
const segmentArb: fc.Arbitrary<string> = fc.stringOf(segChar, {
  minLength: 1,
  maxLength: 5,
});

/** A file base name plus an optional common extension; never empty. */
const fileNameArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.stringOf(segChar, { minLength: 1, maxLength: 6 }),
    fc.constantFrom('.ts', '.js', '.md', '.txt', '.java', '')
  )
  .map(([base, ext]) => base + ext);

/**
 * A '/'-joined path with 0–4 directory segments and a trailing file name.
 * Zero directory segments yields a repository-root file (top-level leaf).
 */
const filePathArb: fc.Arbitrary<string> = fc
  .tuple(fc.array(segmentArb, { minLength: 0, maxLength: 4 }), fileNameArb)
  .map(([dirs, name]) => [...dirs, name].join('/'));

/** All file statuses are valid; `renamed` carries an `oldPath`. */
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
 * Arrays of changed files deduplicated by full path so each `data-path`
 * corresponds to exactly one input file. With clean paths (no leading/
 * trailing/doubled `/`) the normalized path equals the full path, so each
 * unique input path renders as exactly one leaf — letting the test assert a
 * one-to-one correspondence between leaves and input files.
 */
const changedFilesArb: fc.Arbitrary<IChangedFile[]> = fc
  .array(changedFileArb, { minLength: 0, maxLength: 20 })
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

/** 40-char lowercase hex commit hashes (no HTML-special chars). */
const commitHashArb: fc.Arbitrary<string> = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((s) => s.toLowerCase());

// ─── Row-extraction helpers ─────────────────────────────────────────────────

/**
 * Split the rendered forest into the inner content of each `.changed-file-item`
 * row. A leaf row contains only spans (no nested `<div>`), so the first
 * `</div>` after the marker closes the row — directory rows and following
 * siblings are excluded from each chunk.
 */
function extractFileRows(html: string): string[] {
  return html
    .split('<div class="changed-file-item"')
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf('</div>');
      return chunk.slice(0, end);
    });
}

const DATA_PATH_RE = /data-path="([^"]*)"/;
const INDICATOR_RE = /class="file-status-indicator"[^>]*>\s*([\s\S]*?)\s*<\/span>/;
const FILE_NAME_RE = /class="file-name"[^>]*>\s*([\s\S]*?)\s*<\/span>/;

// ─── Property Test ──────────────────────────────────────────────────────────

describe('Feature: git-view-layout-parity - Changed Files Tree Leaf Fidelity', () => {
  describe('Property 5: Rendered leaves preserve file identity, status, and rename metadata', () => {
    it('Feature: git-view-layout-parity, Property 5: every file row preserves escaped data-path, escaped data-commit-hash, status letter+color, base name, and renamed oldPath', () => {
      fc.assert(
        fc.property(changedFilesArb, commitHashArb, (files, hash) => {
          const deps: IFileTreeRenderDeps = {
            escapeHtml,
            statusColor,
            statusChar,
            fileName,
            commitHash: hash,
          };

          const html = renderFileTree(buildFileTree(files), 0, deps);
          const rows = extractFileRows(html);

          // Every input file is rendered as exactly one file leaf (no leaf is
          // dropped, duplicated, or invented).
          assert.strictEqual(
            rows.length,
            files.length,
            `Expected ${files.length} file rows, got ${rows.length} for input ` +
              `[${files.map((f) => f.path).join(', ')}]`
          );

          // Map each input file by its escaped full path so each rendered row
          // can be matched back to its source file.
          const byEscapedPath = new Map<string, IChangedFile>();
          for (const f of files) {
            byEscapedPath.set(escapeHtml(f.path), f);
          }

          const escapedHash = escapeHtml(hash);
          const seenPaths = new Set<string>();

          for (const row of rows) {
            // The double-click selector `.changed-file-item[data-path]
            // [data-commit-hash]` requires BOTH attributes on every leaf.
            const pathMatch = DATA_PATH_RE.exec(row);
            assert.ok(pathMatch, `Row is missing a data-path attribute: ${row}`);
            const escapedPath = pathMatch[1];

            const file = byEscapedPath.get(escapedPath);
            assert.ok(file, `Rendered data-path="${escapedPath}" does not match any input file`);

            // data-path equals the escaped original full path (2.9).
            assert.ok(
              row.includes(`data-path="${escapeHtml(file.path)}"`),
              `Row should carry data-path="${escapeHtml(file.path)}"`
            );

            // data-commit-hash equals the escaped commit hash (2.9) — this is
            // the second half of the double-click selector contract.
            assert.ok(
              row.includes(`data-commit-hash="${escapedHash}"`),
              `Row for "${file.path}" should carry data-commit-hash="${escapedHash}"`
            );

            // Status color for the file's status (2.5).
            const expectedColor = statusColor(file.status);
            assert.ok(
              row.includes(`color: ${expectedColor};`),
              `Row for "${file.path}" should use status color "${expectedColor}"`
            );
            // Status is preserved on the indicator's title.
            assert.ok(
              row.includes(`title="${file.status}"`),
              `Row for "${file.path}" should carry title="${file.status}"`
            );

            // Status letter for the file's status (2.5).
            const indicatorMatch = INDICATOR_RE.exec(row);
            assert.ok(indicatorMatch, `Row for "${file.path}" is missing a status indicator span`);
            assert.strictEqual(
              indicatorMatch[1],
              statusChar(file.status),
              `Row for "${file.path}" should show status letter ` + `"${statusChar(file.status)}"`
            );

            // Base file name (2.5).
            const nameMatch = FILE_NAME_RE.exec(row);
            assert.ok(nameMatch, `Row for "${file.path}" is missing a file-name span`);
            assert.strictEqual(
              nameMatch[1],
              escapeHtml(fileName(file.path)),
              `Row for "${file.path}" should show base name ` +
                `"${escapeHtml(fileName(file.path))}"`
            );

            // Renamed files retain the full escaped oldPath on the same row (2.6).
            if (file.status === 'renamed' && file.oldPath) {
              const escapedOld = escapeHtml(file.oldPath);
              assert.ok(
                row.includes(`<span class="old-path" title="${escapedOld}">${escapedOld}</span>`),
                `Renamed row for "${file.path}" should retain the full escaped ` +
                  `oldPath "${escapedOld}" on the same row`
              );
            }

            seenPaths.add(escapedPath);
          }

          // The rendered leaves are a bijection with the input file set — every
          // input path appears as a leaf exactly once.
          assert.strictEqual(
            seenPaths.size,
            files.length,
            `Rendered file rows should cover every input path exactly once`
          );
        }),
        { numRuns: 100 }
      );
    });
  });
});
