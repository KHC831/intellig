/**
 * Wire protocol for the Resolve Conflicts dialog. NO vscode import (so the
 * Phase-5 webview TS entry can import the same shapes). Frozen wire.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** Per-file resolution state shown in the dialog + carried on updateFileStatus. */
export type ConflictFileStatus = 'unresolved' | 'resolved';

/** One conflicted-file row baked into the init island. */
export interface IResolveConflictsFile {
  path: string;
  status: ConflictFileStatus;
}

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IResolveConflictsDialogInit {
  headerText: string;
  opLabel: string;
  files: IResolveConflictsFile[];
  canAbort: boolean;
  skipVisible: boolean;
  continueVisible: boolean;
  allResolved: boolean;
  yoursLabel: string;
  theirsLabel: string;
  /** Persisted "Group files by directory" preference (IntelliJ's GROUP_MULTIFILE_MERGE_BY_DIRECTORY). */
  groupByDirectory: boolean;
}

/** Webview → host messages. */
export type ResolveConflictsDialogInbound =
  | { type: 'acceptYours'; path: string }
  | { type: 'acceptTheirs'; path: string }
  | { type: 'openMergeView'; path: string }
  /** Take the user's ("Yours") side for every remaining unresolved file. */
  | { type: 'acceptAllYours' }
  /** Take the incoming ("Theirs") side for every remaining unresolved file. */
  | { type: 'acceptAllTheirs' }
  | { type: 'abort' }
  | { type: 'continue' }
  /** Skip This Commit — rebase-only; drops the conflicting commit. */
  | { type: 'skip' }
  /** Persist the "Group files by directory" preference. */
  | { type: 'setGroupByDirectory'; value: boolean };

/** Host → webview messages. */
export type ResolveConflictsDialogOutbound = {
  type: 'updateFileStatus';
  path: string;
  status: ConflictFileStatus;
};

/** Runtime discriminant set — the host guard rejects an unknown type before dispatch. */
export const RESOLVE_CONFLICTS_DIALOG_INBOUND_TYPES = [
  'acceptYours',
  'acceptTheirs',
  'openMergeView',
  'acceptAllYours',
  'acceptAllTheirs',
  'abort',
  'continue',
  'skip',
  'setGroupByDirectory',
] as const;

/**
 * Narrow an untrusted wire message to {@link ResolveConflictsDialogInbound} by
 * its discriminant, or `undefined` for an unknown/old type. Per-path field
 * checks stay fail-closed at the handler.
 */
export function asResolveConflictsDialogInbound(
  message: unknown
): ResolveConflictsDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (RESOLVE_CONFLICTS_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as ResolveConflictsDialogInbound)
    : undefined;
}

/** Compile tie: RESOLVE_CONFLICTS_DIALOG_INBOUND_TYPES and ResolveConflictsDialogInbound agree both ways (check:typed-messages Rule D). */
const _resolveConflictsDialogInboundTie: AssertInboundArrayTie<
  InboundArrayTie<ResolveConflictsDialogInbound, typeof RESOLVE_CONFLICTS_DIALOG_INBOUND_TYPES>
> = true;
void _resolveConflictsDialogInboundTie;
