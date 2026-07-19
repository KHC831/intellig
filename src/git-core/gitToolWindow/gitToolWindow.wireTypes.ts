/**
 * Wire field-bag types for the Git Tool Window, split out of
 * `GitToolWindowProvider.ts` (which imports vscode) so the tool window's
 * `*.protocol.ts` — and through it the bundled webview entry — can type-import
 * them without pulling the vscode/node runtime into the DOM-only webview
 * program. `GitToolWindowProvider.ts` re-exports `IWebviewMessage` +
 * `IBranchFilterGroups`, so existing host callers keep importing them from
 * there unchanged.
 */

import type { TabId } from './tabIds';

/** Branch options for the Log filter's Branch popup (grouped local/remote). */
export interface IBranchFilterGroups {
  local: string[];
  remotes: Array<{ remote: string; branches: string[] }>;
}

/** Log filter from the webview (with string dates). */
export interface IWebviewLogFilter {
  branch?: string;
  branches?: string[];
  /** Every branch checkbox unchecked → show no commits (distinct from "all"). */
  branchesNone?: boolean;
  searchText?: string;
  author?: string;
  /** Multi-select authors (User popup checkboxes) — union. */
  authors?: string[];
  path?: string;
  paths?: string[];
  since?: string | null;
  until?: string | null;
  /**
   * Which relative preset produced `since` ('24h' / '7d'), so reopening the
   * popup shows the preset selected instead of a custom bound rounded to
   * midnight. Absent for an explicit custom range.
   */
  datePreset?: string | null;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
}

/**
 * The flat field bag every webview → host message shares. The tool window's
 * protocol splits it into a discriminated union keyed on `type`; the optional
 * `tab` field drives per-tab routing (messages without one are implicit
 * `tab: 'log'`).
 */
export interface IWebviewMessage {
  type: string;
  path?: string;
  changelistId?: string;
  commitHash?: string;
  commitHashes?: string[];
  /**
   * Set by `selectCommit` when the click came from a hash link in a commit
   * message: the target is usually off-screen, so the host scrolls to it.
   */
  viaHashLink?: boolean;
  action?: string;
  files?: string[];
  targetChangelistId?: string;
  filter?: IWebviewLogFilter | null;
  /**
   * Branch name carried by `branchClick` and `focusBranchOnGraph`.
   * `null` is allowed for the focus message to clear the current focus.
   */
  branchName?: string | null;
  branchType?: 'local' | 'remote';
  widths?: [number, number];
  /** Carried by `setDetailsGroupBy`: how to group the changed-file list. */
  groupBy?: 'tree' | 'flat';
  /**
   * Carried by `selectRepository`: a numeric repository index, or the `'all'`
   * sentinel for the merged "all repositories" scope.
   */
  repositoryIndex?: number | 'all';
  /**
   * Carried by `selectRepositories`: the fsPaths of the repository roots the
   * user checked in the multi-select "Repository" filter. An empty array (or one
   * covering every root) means "show all".
   */
  roots?: string[];
  /**
   * Click anchor that travels with
   * `rangeSelectCommit` / `addRangeSelectCommit`. `null` means "no prior
   * anchor" (first click after a render).
   */
  anchorHash?: string | null;
  /** Optional tab discriminator for tab routing. */
  tab?: TabId;
  /**
   * Carried by `logSearchDraft`: the live (uncommitted) search-box text, so a
   * host re-render can restore it instead of wiping the in-flight draft.
   */
  text?: string;
  /**
   * Carried by `jumpToFixupTarget` (G6): the commit subject text that the
   * fixup!/squash! link's target commit must match.
   */
  targetSubject?: string;
}
