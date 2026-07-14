/**
 * Wire protocol for the Commit tool window (docked Base View). NO runtime
 * vscode import — every payload-type import below is type-only (erased). Frozen
 * wire.
 *
 * Inbound reuses the panel's existing field bag (`ICommitToolWebviewMessage`)
 * via `Omit`, split into a discriminated union so `assertNever` can gate it;
 * outbound is enumerated from the panel's `_postMessage` call sites.
 */
import type { ICommitToolWebviewMessage } from './commitToolWindow.types';
import type { IDiff } from '../git-core/interfaces/gitModels';
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** Shared field bag (every wire field except the discriminant), reused verbatim. */
type Fields = Omit<ICommitToolWebviewMessage, 'type'>;

/** Webview → host messages. */
export type CommitToolWindowInbound =
  | ({ type: 'tabChange' } & Fields)
  | ({ type: 'selectFile' } & Fields)
  | ({ type: 'toggleFile' } & Fields)
  | ({ type: 'updateComposerField' } & Fields)
  | ({ type: 'commit' } & Fields)
  | ({ type: 'commitAndPush' } & Fields)
  | ({ type: 'changelistContextAction' } & Fields)
  | ({ type: 'shelfTabFilterChange' } & Fields)
  | ({ type: 'changesGroupingChange' } & Fields)
  | ({ type: 'shelfTabContextAction' } & Fields);

/**
 * Host → webview messages. The view has no incremental live-update path today —
 * initial load, structural changes, and post-commit/rollback all go through a
 * full host-side re-render — so this is just the three fine-grained patches the
 * client listener applies in place.
 */
export type CommitToolWindowOutbound =
  | { type: 'updateDiffPreview'; path: string; diff?: IDiff; error?: string }
  | { type: 'updateFileCheckbox'; path: string; checked: boolean }
  | { type: 'commitDone'; success: boolean };

export const COMMIT_TOOL_WINDOW_INBOUND_TYPES = [
  'tabChange',
  'selectFile',
  'toggleFile',
  'updateComposerField',
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

/** Compile tie: COMMIT_TOOL_WINDOW_INBOUND_TYPES and CommitToolWindowInbound agree both ways (check:typed-messages Rule D). */
const _commitToolWindowInboundTie: AssertInboundArrayTie<
  InboundArrayTie<CommitToolWindowInbound, typeof COMMIT_TOOL_WINDOW_INBOUND_TYPES>
> = true;
void _commitToolWindowInboundTie;
