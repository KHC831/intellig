/**
 * Wire protocol for the Commit tool window (docked Base View). NO runtime
 * vscode import — every payload-type import below is type-only (erased). Frozen
 * wire.
 *
 * Inbound reuses the panel's existing field bag (`ICommitToolWebviewMessage`)
 * via `Omit`, split into a discriminated union so `assertNever` can gate it;
 * outbound is enumerated from the panel's `_postMessage` call sites.
 */
import type {
  ICommitToolWebviewMessage,
  IShelfTabEntry,
  CommitToolWindowTab,
  ShelfTabFilter,
} from './CommitToolWindow';
import type { IChangelist } from '../changelists/interfaces/IChangelistService';
import type { IShelfItem } from '../shelf/interfaces/IShelfService';
import type { IStash, IDiff } from '../git-core/interfaces/IGitService';

/** Shared field bag (every wire field except the discriminant), reused verbatim. */
type Fields = Omit<ICommitToolWebviewMessage, 'type'>;

/** Webview → host messages. */
export type CommitToolWindowInbound =
  | ({ type: 'tabChange' } & Fields)
  | ({ type: 'selectFile' } & Fields)
  | ({ type: 'toggleFile' } & Fields)
  | ({ type: 'toggleChangelist' } & Fields)
  | ({ type: 'updateComposerField' } & Fields)
  | ({ type: 'messageHistoryRequest' } & Fields)
  | ({ type: 'commit' } & Fields)
  | ({ type: 'commitAndPush' } & Fields)
  | ({ type: 'changelistContextAction' } & Fields)
  | ({ type: 'shelfTabFilterChange' } & Fields)
  | ({ type: 'changesGroupingChange' } & Fields)
  | ({ type: 'shelfTabContextAction' } & Fields);

/** Host → webview messages (incremental patches + the full render). */
export type CommitToolWindowOutbound =
  | {
      type: 'fullRender';
      tab: CommitToolWindowTab;
      changelists: IChangelist[];
      shelf: IShelfItem[];
      stash: IStash[];
      filter: ShelfTabFilter;
    }
  | { type: 'updateChangelistTree'; changelists: IChangelist[] }
  | { type: 'updateShelfList'; entries: IShelfTabEntry[]; filter: ShelfTabFilter }
  | { type: 'updateDiffPreview'; path: string; diff?: IDiff; error?: string }
  | { type: 'updateFileCheckbox'; path: string; checked: boolean }
  | { type: 'messageHistory'; messages: string[] }
  | { type: 'commitDone'; success: boolean };

export const COMMIT_TOOL_WINDOW_INBOUND_TYPES = [
  'tabChange',
  'selectFile',
  'toggleFile',
  'toggleChangelist',
  'updateComposerField',
  'messageHistoryRequest',
  'commit',
  'commitAndPush',
  'changelistContextAction',
  'shelfTabFilterChange',
  'changesGroupingChange',
  'shelfTabContextAction',
] as const;

export function asCommitToolWindowInbound(message: unknown): CommitToolWindowInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (COMMIT_TOOL_WINDOW_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as CommitToolWindowInbound)
    : undefined;
}
