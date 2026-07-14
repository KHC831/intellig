/**
 * Wire protocol for the Merge dialog. NO vscode import. Frozen wire; the dialog
 * posts nothing back. The strategy-flag shape is inlined (not imported from the
 * panel) to keep this module vscode-free by construction.
 */

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
