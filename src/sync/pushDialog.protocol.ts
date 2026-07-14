/**
 * Wire protocol for the Push dialog. NO vscode import — the wire data types live
 * here (vscode-free) so both the host and the webview entry import them from one
 * place. Frozen wire.
 */

/** Which push variant the primary button performs. */
export type PushAction = 'push' | 'forceWithLease' | 'force';

/** Gear overflow state (wire-serialized). */
export interface IPushOverflowState {
  /** `--no-verify`. */
  noVerify: boolean;
  /** Include tags in the push. When false, tag scope is ignored. */
  pushTags: boolean;
  /** When pushTags = true: 'all' → --tags, 'follow' → --follow-tags. */
  tagScope: 'all' | 'follow';
}

/** Fields shared across the inbound variants (all optional, as on the wire). */
type PushInboundFields = {
  action?: PushAction;
  rowId?: string;
  rowPatch?: { selected?: boolean; targetBranch?: string };
  overflow?: IPushOverflowState;
};

/** Webview → host messages. */
export type PushDialogInbound =
  | ({ type: 'submit' } & PushInboundFields)
  | ({ type: 'cancel' } & PushInboundFields)
  | ({ type: 'updateRow' } & PushInboundFields)
  | ({ type: 'updateOverflow' } & PushInboundFields)
  | ({ type: 'pullAndRetry' } & PushInboundFields)
  | ({ type: 'forceWithLease-row' } & PushInboundFields);

/** Derived primary-button + select state carried on both outbound patches. */
type PushPrimaryPayload = { action: PushAction; label: string; anyProtected: boolean };

/** Host → webview: incremental DOM patches (a full re-render steals focus). */
export type PushDialogOutbound =
  | { type: 'patchRow'; rowId: string; protected: boolean; primary: PushPrimaryPayload }
  | { type: 'patchOverflow'; primary: PushPrimaryPayload };

export const PUSH_DIALOG_INBOUND_TYPES = [
  'submit',
  'cancel',
  'updateRow',
  'updateOverflow',
  'pullAndRetry',
  'forceWithLease-row',
] as const;

export function asPushDialogInbound(message: unknown): PushDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && (PUSH_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as PushDialogInbound)
    : undefined;
}
