/**
 * Wire protocol for the Reset dialog. NO runtime vscode import (the ResetMode
 * type-only import is erased). Frozen wire; the dialog posts nothing back.
 */
import type { ResetMode } from '../git-core/interfaces/IGitService';

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
