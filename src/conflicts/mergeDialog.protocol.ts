/**
 * Wire protocol for the Merge dialog. NO vscode import. Frozen wire; the dialog
 * posts nothing back. The strategy-flag shape is inlined (not imported from the
 * panel) to keep this module vscode-free by construction.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IMergeDialogInit {
  sourceBranch: string;
  targetBranch: string;
}

export type MergeDialogInbound =
  | {
      type: 'merge';
      flags?: {
        ffOnly?: boolean;
        noFf?: boolean;
        squash?: boolean;
        noCommit?: boolean;
      };
      noVerify?: boolean;
      allowUnrelatedHistories?: boolean;
      message?: string;
    }
  | { type: 'cancel' };

export type MergeDialogOutbound = never;

export const MERGE_DIALOG_INBOUND_TYPES = ['merge', 'cancel'] as const;

export function asMergeDialogInbound(message: unknown): MergeDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (MERGE_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as MergeDialogInbound)
    : undefined;
}

/** Compile tie: MERGE_DIALOG_INBOUND_TYPES and MergeDialogInbound agree both ways (check:typed-messages Rule D). */
const _mergeDialogInboundTie: AssertInboundArrayTie<
  InboundArrayTie<MergeDialogInbound, typeof MERGE_DIALOG_INBOUND_TYPES>
> = true;
void _mergeDialogInboundTie;
