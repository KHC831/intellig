/**
 * Wire protocol for the Git tool window (docked view + undocked panel share it).
 * NO runtime vscode import — every payload-type import is type-only (erased).
 * Frozen wire.
 *
 * Inbound reuses the provider's existing `IWebviewMessage` field bag via `Omit`,
 * split into a discriminated union so `assertNever` can gate it; outbound is
 * enumerated from every `postToWebview` site in the provider + messageHandlers.
 */
import type { IWebviewMessage, IBranchFilterGroups } from './gitToolWindow.wireTypes';
import type { DetailsPanelModel } from './provider/detailsPanelModel.types';
import type { MultiSelectMenuAction, IMenuItemState } from './multiSelect';
import type { AssertInboundArrayTie, InboundArrayTie } from '../../utils/protocolTie';

/** Shared field bag (every wire field except the discriminant), reused verbatim. */
type Fields = Omit<IWebviewMessage, 'type'>;

/** Webview → host messages. */
export type GitToolWindowInbound =
  | ({ type: 'focusUndockedPanel' } & Fields)
  | ({ type: 'selectCommit' } & Fields)
  | ({ type: 'toggleCommitSelection' } & Fields)
  | ({ type: 'rangeSelectCommit' } & Fields)
  | ({ type: 'addRangeSelectCommit' } & Fields)
  | ({ type: 'selectIfNotSelected' } & Fields)
  | ({ type: 'initRepository' } & Fields)
  | ({ type: 'commitContextMenu' } & Fields)
  | ({ type: 'doubleClickFile' } & Fields)
  | ({ type: 'fileContextAction' } & Fields)
  | ({ type: 'applyLogFilter' } & Fields)
  | ({ type: 'logSearchDraft' } & Fields)
  | ({ type: 'jumpToCommitRequest' } & Fields)
  | ({ type: 'requestLogFilterOptions' } & Fields)
  | ({ type: 'requestAuthorOptions' } & Fields)
  | ({ type: 'clearLogFilter' } & Fields)
  | ({ type: 'branchClick' } & Fields)
  | ({ type: 'loadMoreCommits' } & Fields)
  | ({ type: 'panelResize' } & Fields)
  | ({ type: 'setDetailsGroupBy' } & Fields)
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
  | { type: 'focusTextFilter' }
  | { type: 'logFilterOptionsReady'; branchGroups: IBranchFilterGroups }
  | { type: 'authorOptionsReady'; authors: string[]; me?: string }
  | { type: 'updateBranchFocus'; focusedBranchName: string | null; focusedHash: string | null }
  | {
      type: 'updateMenuEnableState';
      state: Record<MultiSelectMenuAction, IMenuItemState>;
      selectedCount: number;
    }
  | { type: 'syncSelection'; anchorHash: string | null; selectedHashes: string[] };

export const GIT_TOOL_WINDOW_INBOUND_TYPES = [
  'focusUndockedPanel',
  'selectCommit',
  'toggleCommitSelection',
  'rangeSelectCommit',
  'addRangeSelectCommit',
  'selectIfNotSelected',
  'initRepository',
  'commitContextMenu',
  'doubleClickFile',
  'fileContextAction',
  'applyLogFilter',
  'logSearchDraft',
  'jumpToCommitRequest',
  'requestLogFilterOptions',
  'requestAuthorOptions',
  'clearLogFilter',
  'branchClick',
  'loadMoreCommits',
  'panelResize',
  'setDetailsGroupBy',
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

/** Compile tie: GIT_TOOL_WINDOW_INBOUND_TYPES and GitToolWindowInbound agree both ways (check:typed-messages Rule D). */
const _gitToolWindowInboundTie: AssertInboundArrayTie<
  InboundArrayTie<GitToolWindowInbound, typeof GIT_TOOL_WINDOW_INBOUND_TYPES>
> = true;
void _gitToolWindowInboundTie;
