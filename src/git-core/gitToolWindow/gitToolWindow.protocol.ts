/**
 * Wire protocol for the Git tool window (docked view + undocked panel share it).
 * NO runtime vscode import — every payload-type import is type-only (erased).
 * Frozen wire.
 *
 * Inbound reuses the provider's existing `IWebviewMessage` field bag via `Omit`,
 * split into a discriminated union so `assertNever` can gate it; outbound is
 * enumerated from every `postToWebview` site in the provider + messageHandlers.
 */
import type { IWebviewMessage, IBranchFilterGroups } from './GitToolWindowProvider';
import type { DetailsPanelModel } from './provider/detailsPanelModel';
import type { MultiSelectMenuAction, IMenuItemState } from './multiSelect';

/** Shared field bag (every wire field except the discriminant), reused verbatim. */
type Fields = Omit<IWebviewMessage, 'type'>;

/** Webview → host messages. */
export type GitToolWindowInbound =
  | ({ type: 'refresh' } & Fields)
  | ({ type: 'focusUndockedPanel' } & Fields)
  | ({ type: 'selectCommit' } & Fields)
  | ({ type: 'toggleCommitSelection' } & Fields)
  | ({ type: 'rangeSelectCommit' } & Fields)
  | ({ type: 'addRangeSelectCommit' } & Fields)
  | ({ type: 'selectIfNotSelected' } & Fields)
  | ({ type: 'initRepository' } & Fields)
  | ({ type: 'commitContextMenu' } & Fields)
  | ({ type: 'doubleClickFile' } & Fields)
  | ({ type: 'applyLogFilter' } & Fields)
  | ({ type: 'requestLogFilterOptions' } & Fields)
  | ({ type: 'requestAuthorOptions' } & Fields)
  | ({ type: 'clearLogFilter' } & Fields)
  | ({ type: 'branchClick' } & Fields)
  | ({ type: 'loadMoreCommits' } & Fields)
  | ({ type: 'panelResize' } & Fields)
  | ({ type: 'columnResize' } & Fields)
  | ({ type: 'selectRepositories' } & Fields)
  | ({ type: 'jumpToFixupTarget' } & Fields);

/** Host → webview messages. */
export type GitToolWindowOutbound =
  | { type: 'selectGraphRow'; commitHash: string }
  | { type: 'updateDetailsPanel'; model: DetailsPanelModel }
  | { type: 'graphTotalsUpdate'; loaded: number; total: number }
  | { type: 'commitsLoaded' }
  | { type: 'scrollToCommit'; commitHash: string }
  | { type: 'logFilterOptionsReady'; branchGroups: IBranchFilterGroups }
  | { type: 'authorOptionsReady'; authors: string[] }
  | { type: 'updateBranchFocus'; focusedBranchName: string | null; focusedHash: string | null }
  | {
      type: 'updateMenuEnableState';
      state: Record<MultiSelectMenuAction, IMenuItemState>;
      selectedCount: number;
    }
  | { type: 'syncSelection'; anchorHash: string | null; selectedHashes: string[] };

export const GIT_TOOL_WINDOW_INBOUND_TYPES = [
  'refresh',
  'focusUndockedPanel',
  'selectCommit',
  'toggleCommitSelection',
  'rangeSelectCommit',
  'addRangeSelectCommit',
  'selectIfNotSelected',
  'initRepository',
  'commitContextMenu',
  'doubleClickFile',
  'applyLogFilter',
  'requestLogFilterOptions',
  'requestAuthorOptions',
  'clearLogFilter',
  'branchClick',
  'loadMoreCommits',
  'panelResize',
  'columnResize',
  'selectRepositories',
  'jumpToFixupTarget',
] as const;

export function asGitToolWindowInbound(message: unknown): GitToolWindowInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (GIT_TOOL_WINDOW_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as GitToolWindowInbound)
    : undefined;
}
