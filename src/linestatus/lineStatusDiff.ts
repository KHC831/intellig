/**
 * Pure buffer-vs-HEAD line-status diff — the change-range model behind the
 * live changed-line gutter (workstream A, slice A-2).
 *
 * Mirrors the per-line change model of IntelliJ's `LineStatusTracker`
 * (platform/vcs-impl/src/com/intellij/openapi/vcs/ex/LineStatusTracker.java and
 * its `Range` model in DocumentTracker / LineStatusTrackerBase): the committed
 * ("vcs") content is diffed against the live document, yielding INSERTED /
 * DELETED / MODIFIED ranges expressed in *current document* line coordinates.
 *
 * We compute the diff in-memory (the document buffer may hold unsaved edits, so
 * `git diff` against the working tree would miss them — exactly why IntelliJ
 * tracks the open document, not the file on disk). A minimal LCS line diff is
 * used; no external diff dependency is added.
 */

/** Kind of change for a contiguous range, matching IntelliJ's Range types. */
export type LineStatusKind = 'added' | 'modified' | 'deleted';

/**
 * A contiguous changed-line range in *current buffer* (0-based) coordinates.
 *
 * - `added` / `modified`: `start`..`end` (inclusive) cover the affected buffer
 *   lines.
 * - `deleted`: the lines no longer exist in the buffer, so the range is an
 *   anchor — `start === end` is the buffer line adjacent to where content was
 *   removed (clamped into the buffer). IntelliJ draws the deletion marker in the
 *   gutter gap at this position.
 */
export interface ILineStatusRange {
  kind: LineStatusKind;
  /** 0-based inclusive first buffer line of the range (anchor for `deleted`). */
  start: number;
  /** 0-based inclusive last buffer line of the range (== start for `deleted`). */
  end: number;

  // Exact diff coordinates (IntelliJ `Range` line1/line2 + vcsLine1/vcsLine2,
  // platform/vcs-impl/.../ex/LineStatusTracker.kt). Both spans are half-open and
  // 0-based; the hover popup + revert (slice F-8b) use these rather than the
  // decoration anchor above, which is inclusive and clamped for drawing.

  /** First buffer line of the change (== `bufEnd` for `deleted`: nothing in the buffer). */
  bufStart: number;
  /** End-exclusive buffer line of the change; the true (unclamped) insertion point for `deleted`. */
  bufEnd: number;
  /** First HEAD line of the change (== `vcsEnd` for `added`: nothing in HEAD). */
  vcsStart: number;
  /** End-exclusive HEAD line of the change. */
  vcsEnd: number;
}

/**
 * Largest file (in lines, on either side) the tracker will diff. The LCS pass
 * is O(m·n) in both time and memory, so an unbounded diff on a huge or minified
 * file (e.g. a 50k-line bundle) would allocate billions of cells and hang/OOM
 * the extension host. Past this cap we skip the diff and paint no markers —
 * VS Code's own dirty-diff caps large files for the same reason.
 */
export const MAX_TRACKED_LINES = 10000;

/**
 * Cap on the LCS table size (`oldLines.length * newLines.length`). The diff
 * allocates an m×n dp table, so the per-side {@link MAX_TRACKED_LINES} cap is
 * not enough — two ~10k-line sides would still allocate ~10^8 cells (hundreds
 * of MB) synchronously on the extension host. Past this product cap we skip the
 * diff too. ~16M cells keeps the table to a few hundred MB worst case while
 * still covering files up to a few thousand lines on each side.
 */
export const MAX_DIFF_CELLS = 16_000_000;

/**
 * Compute the changed-line ranges of `buffer` relative to its committed
 * `head` content. Returns ranges in ascending buffer-line order.
 *
 * Files larger than {@link MAX_TRACKED_LINES} on either side, or whose LCS
 * table would exceed {@link MAX_DIFF_CELLS} cells, are not diffed — an empty
 * result is returned so the tracker shows no markers rather than blocking the
 * extension host on a quadratic LCS.
 */
export function computeLineStatusRanges(head: string, buffer: string): ILineStatusRange[] {
  const oldLines = splitLines(head);
  const newLines = splitLines(buffer);
  if (oldLines.length > MAX_TRACKED_LINES || newLines.length > MAX_TRACKED_LINES) {
    return [];
  }
  if (oldLines.length * newLines.length > MAX_DIFF_CELLS) {
    return [];
  }
  const ops = diffLines(oldLines, newLines);
  return coalesce(ops, newLines.length);
}

/**
 * Split file content into lines, dropping the empty trailing element produced
 * by a final newline. Empty content yields zero lines (not one blank line) so
 * an empty HEAD (added file) contributes no spurious leading line.
 *
 * Exported so the hover popup addresses HEAD lines by the same indices these
 * ranges carry (`vcsStart`/`vcsEnd`).
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

/** A single line-level edit operation in old→new order. */
type Op = { type: 'equal' | 'add' | 'del' };

/**
 * Classic LCS line diff. Returns operations in source order: `equal` for lines
 * present in both, `del` for old-only lines, `add` for new-only lines.
 */
function diffLines(oldLines: string[], newLines: string[]): Op[] {
  const m = oldLines.length;
  const n = newLines.length;

  // LCS length table. dp[i][j] = LCS of oldLines[i..] and newLines[j..].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: 'equal' });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del' });
      i++;
    } else {
      ops.push({ type: 'add' });
      j++;
    }
  }
  while (i < m) {
    ops.push({ type: 'del' });
    i++;
  }
  while (j < n) {
    ops.push({ type: 'add' });
    j++;
  }
  return ops;
}

/**
 * Coalesce consecutive non-equal ops into ranges in buffer coordinates.
 * A block with both deletions and additions is a MODIFIED range; additions
 * only is ADDED; deletions only is DELETED (anchored to the adjacent buffer
 * line).
 */
function coalesce(ops: Op[], bufferLineCount: number): ILineStatusRange[] {
  const ranges: ILineStatusRange[] = [];
  let bufferLine = 0; // 0-based index of the next buffer line to consume
  let headLine = 0; // 0-based index of the next HEAD line consumed
  let k = 0;

  while (k < ops.length) {
    if (ops[k].type === 'equal') {
      bufferLine++;
      headLine++;
      k++;
      continue;
    }

    // Gather the contiguous run of changes.
    let adds = 0;
    let dels = 0;
    const blockStart = bufferLine;
    const headStart = headLine;
    while (k < ops.length && ops[k].type !== 'equal') {
      if (ops[k].type === 'add') {
        adds++;
        bufferLine++;
      } else {
        dels++;
        headLine++;
      }
      k++;
    }

    const bufStart = blockStart;
    const bufEnd = blockStart + adds;
    const vcsStart = headStart;
    const vcsEnd = headStart + dels;

    if (adds > 0) {
      ranges.push({
        kind: dels > 0 ? 'modified' : 'added',
        start: blockStart,
        end: blockStart + adds - 1,
        bufStart,
        bufEnd,
        vcsStart,
        vcsEnd,
      });
    } else {
      // Pure deletion: no buffer lines were produced. Anchor to the buffer
      // line that now sits at the deletion point, clamped into the buffer.
      const lastLine = Math.max(0, bufferLineCount - 1);
      const anchor = Math.min(blockStart, lastLine);
      ranges.push({
        kind: 'deleted',
        start: anchor,
        end: anchor,
        bufStart,
        bufEnd,
        vcsStart,
        vcsEnd,
      });
    }
  }

  return ranges;
}
