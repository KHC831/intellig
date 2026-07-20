/**
 * Wire protocol for the Push dialog. NO vscode import — the wire data types live
 * here (vscode-free) so both the host and the webview entry import them from one
 * place. Frozen wire.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

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

/** Classified push-failure kind carried on a row's error. */
export type PushErrorKind =
  | 'rejected-non-ff'
  | 'rejected-stale-lease'
  | 'rejected-protected'
  | 'auth'
  | 'hook'
  | 'other';

/** One repo row baked into the init island (wire view — no live IRepository). */
export interface IPushRowView {
  id: string;
  repoLabel: string;
  localBranch: string;
  targetBranch: string;
  ahead: number;
  selected: boolean;
  protected: boolean;
  /**
   * Full hash when the row pushes an exact commit (push-up-to-here) instead
   * of a branch tip; the source cell then renders the short hash — the
   * GitPushSource.OnRevision/DetachedHead presentation — and the rejection
   * banner drops the update/retry affordance (a fixed hash cannot be
   * meaningfully re-pushed after an update).
   */
  sourceHash: string | null;
  /** `message` is the classified one-liner for the banner, never raw stderr. */
  error: { message: string; kind: PushErrorKind } | null;
}

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IPushDialogInit {
  empty: boolean;
  rows: IPushRowView[];
  primaryAction: PushAction;
  primaryLabel: string;
  anyProtected: boolean;
  /** False when no row is selected — the primary button is offered disabled. */
  canSubmit: boolean;
  overflow: IPushOverflowState;
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
  | ({ type: 'forceWithLease-row' } & PushInboundFields)
  | ({ type: 'forceAnyway-row' } & PushInboundFields);

/** Derived primary-button + select state carried on both outbound patches. */
type PushPrimaryPayload = {
  action: PushAction;
  label: string;
  anyProtected: boolean;
  canSubmit: boolean;
};

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
  'forceAnyway-row',
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

/** Compile tie: PUSH_DIALOG_INBOUND_TYPES and PushDialogInbound agree both ways (check:typed-messages Rule D). */
const _pushDialogInboundTie: AssertInboundArrayTie<
  InboundArrayTie<PushDialogInbound, typeof PUSH_DIALOG_INBOUND_TYPES>
> = true;
void _pushDialogInboundTie;
