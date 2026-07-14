/**
 * Wire protocol for the Shelve Changes dialog. NO vscode import (so the Phase-5
 * webview TS entry can import the same shapes). Frozen wire — do not rename
 * fields here.
 *
 * The dialog bakes its initial data into the rendered HTML (a `data-*` init
 * island the entry reads on boot) rather than posting it, so the host emits
 * nothing: `ShelveDialogOutbound` is `never`.
 */

/** A file row in the dialog's checkbox list (pure view-model, vscode-free). */
export interface IShelveFileItem {
  path: string;
  fileName: string;
  fileDir: string;
  statusChar: string;
  statusLabel: string;
  statusColor: string;
  selected: boolean;
}

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IShelveDialogInit {
  defaultName: string;
  files: IShelveFileItem[];
}

/** Webview → host messages. */
export type ShelveDialogInbound =
  | { readonly type: 'cancel' }
  | { readonly type: 'shelve'; readonly name: string; readonly files: string[] };

/** Host → webview messages: none (initial state is embedded in the HTML island). */
export type ShelveDialogOutbound = never;

/** Runtime discriminant set — the host guard rejects an unknown type before dispatch. */
export const SHELVE_DIALOG_INBOUND_TYPES = ['cancel', 'shelve'] as const;

/**
 * Narrow an untrusted wire message to {@link ShelveDialogInbound} by its
 * discriminant, or `undefined` for an unknown/old type. Field-level checks on
 * the state-mutating `shelve` payload stay fail-closed at the handler.
 */
export function asShelveDialogInbound(message: unknown): ShelveDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (SHELVE_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as ShelveDialogInbound)
    : undefined;
}
