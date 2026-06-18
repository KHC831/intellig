/**
 * Pure model behind the inline-diff hover popup on a change marker (slice F-8b).
 *
 * Mirrors IntelliJ's `LineStatusMarkerPopup` / `LineStatusMarkerPopupActions`
 * (platform/diff-impl/src/com/intellij/openapi/vcs/ex/LineStatusMarkerPopupActions.kt):
 * hovering/clicking a change marker shows the previous (committed) content for
 * the range and offers a "Rollback" (revert hunk) and "Copy old content"
 * action. Here we produce, from a {@link ILineStatusRange} + the committed HEAD
 * lines, the OLD content to display and the replacement edit the revert applies.
 *
 * No editor and no git: the range carries the exact diff coordinates (see
 * {@link ILineStatusRange}), so the popup reuses the same diff the gutter drew —
 * it never recomputes one differently.
 */

import { ILineStatusRange, LineStatusKind } from './lineStatusDiff';

/** What the hover popup renders for a single change range. */
export interface IHoverModel {
  kind: LineStatusKind;
  /**
   * The committed (HEAD) lines this change replaced, in order. Empty for an
   * `added` range (there was nothing in HEAD).
   */
  oldLines: string[];
}

/**
 * The buffer edit the "Revert this change" action applies: replace the
 * half-open buffer line span `[startLine, endLine)` with `lines`.
 *
 * - `added`: `lines` is empty → the added buffer lines are deleted.
 * - `modified`: the changed buffer lines are replaced by the old HEAD lines.
 * - `deleted`: `startLine === endLine` → the removed HEAD lines are inserted at
 *   the deletion point.
 */
export interface IRevertEdit {
  /** 0-based first buffer line to replace (inclusive). */
  startLine: number;
  /** 0-based buffer line after the last replaced line (exclusive). */
  endLine: number;
  /** HEAD lines to put in place (without trailing newlines); empty = pure delete. */
  lines: string[];
}

/** Build the popup model (kind + old content) for a change range. */
export function buildHoverModel(range: ILineStatusRange, headLines: string[]): IHoverModel {
  return {
    kind: range.kind,
    oldLines: headLines.slice(range.vcsStart, range.vcsEnd),
  };
}

/** Compute the buffer replacement edit that reverts a change range to HEAD. */
export function computeRevertEdit(range: ILineStatusRange, headLines: string[]): IRevertEdit {
  return {
    startLine: range.bufStart,
    endLine: range.bufEnd,
    lines: headLines.slice(range.vcsStart, range.vcsEnd),
  };
}

/** Human label for the popup header, matching the change kind. */
function title(model: IHoverModel): string {
  switch (model.kind) {
    case 'added':
      return 'Added';
    case 'deleted':
      return model.oldLines.length === 1
        ? '1 line removed'
        : `${model.oldLines.length} lines removed`;
    case 'modified':
    default:
      return model.oldLines.length === 1
        ? '1 line changed'
        : `${model.oldLines.length} lines changed`;
  }
}

/** Escape the five characters that are unsafe in rendered HTML/markdown text. */
function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Choose a fence of backticks longer than the longest backtick run in `text`,
 * so old content containing ``` cannot break out of the code block. Markdown
 * requires the fence to be strictly longer than any internal run (min 3).
 */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * Render the hover popup as trusted markdown: the old content in a code block
 * (HTML-escaped, backtick-safe fence) plus "Revert this change" and "Copy old
 * content" command links. `revertUri`/`copyUri` are pre-built `command:` URIs.
 */
export function renderHoverMarkdown(
  model: IHoverModel,
  revertUri: string,
  copyUri: string
): string {
  const parts: string[] = [`**${title(model)}**`];

  if (model.oldLines.length > 0) {
    const body = htmlEscape(model.oldLines.join('\n'));
    const fence = fenceFor(body);
    parts.push(`${fence}\n${body}\n${fence}`);
  }

  // The revert link is always offered; copy only when there is old content.
  const links =
    model.oldLines.length > 0
      ? `[Revert this change](${revertUri}) · [Copy old content](${copyUri})`
      : `[Revert this change](${revertUri})`;
  parts.push(links);

  return parts.join('\n\n');
}
