/**
 * Wire protocol for the Rebase dialog. NO vscode import. Frozen wire; the
 * dialog posts nothing back.
 */

export type RebaseDialogInbound =
  | {
      type: 'rebase';
      onto?: string;
      /** Optional `--onto <newbase>` target; '' / absent means rebase onto upstream. */
      newBase?: string;
      interactive?: boolean;
      rebaseMerges?: boolean;
      keepEmpty?: boolean;
      updateRefs?: boolean;
      autosquash?: boolean;
      root?: boolean;
    }
  | { type: 'cancel' };

export type RebaseDialogOutbound = never;

export const REBASE_DIALOG_INBOUND_TYPES = ['rebase', 'cancel'] as const;

export function asRebaseDialogInbound(message: unknown): RebaseDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (REBASE_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as RebaseDialogInbound)
    : undefined;
}
