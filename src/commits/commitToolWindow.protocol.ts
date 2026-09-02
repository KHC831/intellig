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
  ICommitToolWindowInitModel,
  ICtwMenuItem,
} from './commitToolWindow.types';
import type { IDiff } from '../git-core/interfaces/gitModels';

import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** Shared field bag (every wire field except the discriminant), reused verbatim. */
type Fields = Omit<ICommitToolWebviewMessage, 'type'>;

/** Webview → host messages. */
export type CommitToolWindowInbound =
  | ({ type: 'tabChange' } & Fields)
  | ({ type: 'selectFile' } & Fields)
  | ({ type: 'openFileDiff' } & Fields)
  | ({ type: 'resolveConflicts' } & Fields)
  | ({ type: 'resolveConflictFile'; path: string } & Fields)
  | ({ type: 'toggleFile' } & Fields)
  | ({ type: 'updateComposerField' } & Fields)
  | ({ type: 'commit' } & Fields)
  | ({ type: 'commitAndPush' } & Fields)
  | ({ type: 'changelistContextAction' } & Fields)
  | ({ type: 'shelfTabFilterChange' } & Fields)
  | ({ type: 'changesGroupingChange' } & Fields)
  | ({ type: 'shelfTabContextAction' } & Fields)
  | ({ type: 'gearAction' } & Fields);

/**
 * Host → webview messages. `updateModel` is the single live-update arm: every
 * post-resolve state change (service events, stash lane, reload, tab switch,
 * shelf filter, grouping) ships the full render model and the client applies
 * it in place, preserving composer/selection/scroll. `setComposerMessage` is
 * the prefill carve-out (Undo Commit): an explicit user action that writes the
 * composer, which a live update never does. The remaining three are
 * fine-grained patches the client applies in place.
 */
export type CommitToolWindowOutbound =
  | { type: 'updateModel'; model: ICommitToolWindowInitModel }
  | { type: 'setComposerMessage'; message: string }
  | { type: 'updateDiffPreview'; path: string; diff?: IDiff; error?: string }
  | { type: 'updateFileCheckbox'; path: string; checked: boolean }
  | { type: 'setGearState'; noVerify: boolean }
  | { type: 'commitDone'; success: boolean }
  | {
      type: 'showRowContextMenu';
      path?: string;
      changelistId?: string;
      rowKind?: 'shelf' | 'stash';
      shelfId?: string;
      stashIndex?: number;
      stashSha?: string;
      items: ICtwMenuItem[];
    };

export const COMMIT_TOOL_WINDOW_INBOUND_TYPES = [
  'tabChange',
  'selectFile',
  'openFileDiff',
  'resolveConflicts',
  'resolveConflictFile',
  'toggleFile',
  'updateComposerField',
  'commit',
  'commitAndPush',
  'changelistContextAction',
  'shelfTabFilterChange',
  'changesGroupingChange',
  'shelfTabContextAction',
  'gearAction',
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

/** Compile tie: COMMIT_TOOL_WINDOW_INBOUND_TYPES and CommitToolWindowInbound agree both ways (check:typed-messages Rule D). */
const _commitToolWindowInboundTie: AssertInboundArrayTie<
  InboundArrayTie<CommitToolWindowInbound, typeof COMMIT_TOOL_WINDOW_INBOUND_TYPES>
> = true;
void _commitToolWindowInboundTie;
