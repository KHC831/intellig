/**
 * Wire protocol for the New Branch dialog. NO vscode import. Frozen wire.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface INewBranchDialogInit {
  startPointLabel: string;
  defaultName: string;
  defaultTrack: boolean;
  /** Render-time trackability answer; the `conflicts` message refines it later. */
  trackVisible: boolean;
}

export type NewBranchDialogInbound =
  | {
      type: 'create';
      name?: string;
      track?: boolean;
      overwrite?: boolean;
      checkout?: boolean;
    }
  | { type: 'cancel' };

/** Host → webview: the loaded conflict sources for live validation. */
export type NewBranchDialogOutbound = {
  type: 'conflicts';
  localBranches: string[];
  remoteBranches: string[];
  currentBranch: string;
  startPointTrackable: boolean;
};

export const NEW_BRANCH_DIALOG_INBOUND_TYPES = ['create', 'cancel'] as const;

export function asNewBranchDialogInbound(message: unknown): NewBranchDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (NEW_BRANCH_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as NewBranchDialogInbound)
    : undefined;
}

/** Compile tie: NEW_BRANCH_DIALOG_INBOUND_TYPES and NewBranchDialogInbound agree both ways (check:typed-messages Rule D). */
const _newBranchDialogInboundTie: AssertInboundArrayTie<
  InboundArrayTie<NewBranchDialogInbound, typeof NEW_BRANCH_DIALOG_INBOUND_TYPES>
> = true;
void _newBranchDialogInboundTie;
