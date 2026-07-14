/**
 * Wire protocol for the Commit Message dialog. NO vscode import. Frozen wire.
 * The dialog bakes its initial state into the HTML and posts nothing back, so
 * the outbound side is `never`.
 */

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface ICommitMessageDialogInit {
  seedMessage: string;
  heading: string;
  submitLabel: string;
  submitVerb: string;
  isMac: boolean;
}

export type CommitMessageDialogInbound = { type: 'submit'; message?: string } | { type: 'cancel' };

export type CommitMessageDialogOutbound = never;

export const COMMIT_MESSAGE_DIALOG_INBOUND_TYPES = ['submit', 'cancel'] as const;

export function asCommitMessageDialogInbound(
  message: unknown
): CommitMessageDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (COMMIT_MESSAGE_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as CommitMessageDialogInbound)
    : undefined;
}
