import { IDiff } from '../git-core/interfaces/IGitService';

/**
 * Reconstruct the "after" (post-patch) content of a single text file by
 * applying a parsed unified diff to its base content.
 *
 * Used by the shelf "Compare with Local" flow to materialise the *shelved*
 * version of a file: the shelf stores the change as a `git diff` patch
 * (base → shelved), so applying that patch back onto the base reproduces the
 * exact content the user shelved. The reconstructed text becomes the left-hand
 * side of a shelved-vs-working-tree diff, mirroring IntelliJ's
 * `DiffShelvedChangesActionProvider` which builds `texts.getPatched()` from the
 * base revision plus the shelved `TextFilePatch`
 * (platform/vcs-impl/.../shelf/DiffShelvedChangesActionProvider.java,
 * `createDiffRequestUsingBase`).
 *
 * Within a hunk the patch is authoritative — context/added lines come from the
 * patch body, deleted lines are dropped. Between hunks the base supplies the
 * untouched lines. An added file (base `''`) yields just the added lines; a
 * fully-deleted file yields `''`.
 *
 * @param base - The base (pre-patch) file content. Empty string for an added
 *   file that has no base revision.
 * @param diff - The parsed unified diff for this single file.
 * @returns The reconstructed post-patch file content.
 */
export function applyTextPatch(base: string, diff: IDiff): string {
  // No hunks → nothing to apply (e.g. a pure rename or mode change). The
  // shelved content equals the base.
  if (diff.hunks.length === 0) {
    return base;
  }

  const { lines: baseLines } = splitToLines(base);
  const result: string[] = [];
  let cursor = 0; // 0-based index into baseLines

  // Hunks are emitted in ascending source order by git; walk them in turn,
  // copying the untouched stretch of base before each.
  for (const hunk of diff.hunks) {
    const hunkStartIdx = Math.max(0, hunk.oldStart - 1);
    if (hunkStartIdx > cursor) {
      result.push(...baseLines.slice(cursor, hunkStartIdx));
    }
    cursor = Math.max(cursor, hunkStartIdx);

    for (const line of hunk.lines) {
      switch (line.type) {
        case 'context':
          // The patch body carries the unchanged line verbatim; emit it and
          // advance past the matching base line.
          result.push(line.content);
          cursor++;
          break;
        case 'delete':
          // Dropped from the after-image; skip the base line.
          cursor++;
          break;
        case 'add':
          // New line that has no base counterpart.
          result.push(line.content);
          break;
      }
    }
  }

  // Trailing untouched base lines after the last hunk.
  if (cursor < baseLines.length) {
    result.push(...baseLines.slice(cursor));
  }

  if (result.length === 0) {
    return '';
  }

  const joined = result.join('\n');
  // Preserve the base file's trailing-newline convention. An added file has an
  // empty base, so default to a trailing newline — git text patches add whole
  // lines. The "\ No newline at end of file" marker is stripped during parse,
  // so a base that genuinely lacks a final newline reconstructs without one.
  const baseHadTrailingNewline = base.length === 0 || base.endsWith('\n');
  return baseHadTrailingNewline ? `${joined}\n` : joined;
}

/**
 * Split file content into its constituent lines, dropping the separator-only
 * trailing element produced by a final newline. An empty string yields zero
 * lines (not one empty line), so an added file's empty base contributes no
 * spurious leading blank line.
 */
function splitToLines(text: string): { lines: string[] } {
  if (text.length === 0) {
    return { lines: [] };
  }
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return { lines: body.split('\n') };
}
