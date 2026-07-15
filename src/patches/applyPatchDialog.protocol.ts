/**
 * Wire protocol for the Apply Patch dialog. NO vscode import. Frozen wire.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IApplyPatchDialogInit {
  patchPath: string;
  previewLineCap: number;
}

/** Webview → host messages. */
export type ApplyPatchDialogInbound =
  | { type: 'cancel' }
  | { type: 'browse' }
  | { type: 'preview'; patchPath?: string; useClipboard?: boolean }
  | {
      type: 'apply';
      patchPath?: string;
      useClipboard?: boolean;
      useAm?: boolean;
      stripLevel?: number;
      baseDir?: string;
    };

/** Host → webview messages. */
export type ApplyPatchDialogOutbound =
  | { type: 'patchPathChosen'; patchPath: string }
  | { type: 'preview'; content: string }
  | { type: 'error'; message: string };

export const APPLY_PATCH_DIALOG_INBOUND_TYPES = ['cancel', 'browse', 'preview', 'apply'] as const;

export function asApplyPatchDialogInbound(message: unknown): ApplyPatchDialogInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (APPLY_PATCH_DIALOG_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as ApplyPatchDialogInbound)
    : undefined;
}

/** Compile tie: APPLY_PATCH_DIALOG_INBOUND_TYPES and ApplyPatchDialogInbound agree both ways (check:typed-messages Rule D). */
const _applyPatchDialogInboundTie: AssertInboundArrayTie<
  InboundArrayTie<ApplyPatchDialogInbound, typeof APPLY_PATCH_DIALOG_INBOUND_TYPES>
> = true;
void _applyPatchDialogInboundTie;
