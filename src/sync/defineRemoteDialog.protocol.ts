/**
 * Wire protocol for the Define Remote dialog (IntelliJ GitDefineRemoteDialog).
 * NO vscode import — the host and the bundled webview entry both import these
 * types from here. Frozen wire.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** What the caller asks the dialog to collect. */
export interface IDefineRemoteRequest {
  /** Dialog title, e.g. `Define Remote` or `Edit Remote 'origin'`. */
  title: string;
  /** Prefilled name (empty for a fresh remote). */
  name: string;
  /** Prefilled URL (empty for a fresh remote). */
  url: string;
  /** Names already taken in the repo; used for the duplicate-name check. */
  existingNames: string[];
  /** Name under edit, exempt from the duplicate check. */
  originalName?: string;
}

/** What the user confirmed. */
export interface IDefineRemoteResult {
  name: string;
  url: string;
  /** Fetch the remote right after defining it (checkbox, on by default). */
  fetch: boolean;
}

/** Initial state the host bakes into the body island. */
export interface IDefineRemoteDialogInit {
  name: string;
  url: string;
  existingNames: string[];
  originalName: string | null;
  fetch: boolean;
  submitLabel: string;
}

/** Fields shared across the inbound variants (all optional, as on the wire). */
type DefineRemoteInboundFields = {
  name?: string;
  url?: string;
  fetch?: boolean;
};

/** Webview → host messages. */
export type DefineRemoteDialogInbound =
  | ({ type: 'submit' } & DefineRemoteInboundFields)
  | ({ type: 'cancel' } & DefineRemoteInboundFields);

/**
 * Host → webview. `busy` brackets the reachability probe (GitDefineRemoteDialog
 * disables its fields while `git ls-remote` runs); `error` reports a probe or
 * git failure without closing the dialog.
 */
export type DefineRemoteDialogOutbound =
  { type: 'busy'; busy: boolean } | { type: 'error'; message: string };

export const DEFINE_REMOTE_DIALOG_INBOUND_TYPES = ['submit', 'cancel'] as const;

export function asDefineRemoteDialogInbound(
  message: unknown
): DefineRemoteDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (DEFINE_REMOTE_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as DefineRemoteDialogInbound)
    : undefined;
}

/** Compile tie: the array and the union agree both ways (check:typed-messages Rule D). */
const _defineRemoteDialogInboundTie: AssertInboundArrayTie<
  InboundArrayTie<DefineRemoteDialogInbound, typeof DEFINE_REMOTE_DIALOG_INBOUND_TYPES>
> = true;
void _defineRemoteDialogInboundTie;
