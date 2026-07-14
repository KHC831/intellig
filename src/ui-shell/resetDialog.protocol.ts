/**
 * Wire protocol for the Reset dialog. NO vscode import — ResetMode comes from
 * the vscode-free resetMode module so the webview entry can import this. Frozen
 * wire; the dialog posts nothing back.
 */
import type { ResetMode } from '../git-core/interfaces/resetMode';
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IResetDialogInit {
  shortHash: string;
  subject: string;
  disabledModes: ResetMode[];
  effectiveDefault: ResetMode;
  protectedTooltip: string;
}

export type ResetDialogInbound = { type: 'reset'; mode?: ResetMode } | { type: 'cancel' };

export type ResetDialogOutbound = never;

export const RESET_DIALOG_INBOUND_TYPES = ['reset', 'cancel'] as const;

export function asResetDialogInbound(message: unknown): ResetDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (RESET_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as ResetDialogInbound)
    : undefined;
}

/** Compile tie: RESET_DIALOG_INBOUND_TYPES and ResetDialogInbound agree both ways (check:typed-messages Rule D). */
const _resetDialogInboundTie: AssertInboundArrayTie<
  InboundArrayTie<ResetDialogInbound, typeof RESET_DIALOG_INBOUND_TYPES>
> = true;
void _resetDialogInboundTie;
