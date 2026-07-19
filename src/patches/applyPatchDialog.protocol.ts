/**
 * Wire protocol for the Apply Patch dialog. NO vscode import. Frozen wire.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** Per-file verdict of the preview dry-run pass. */
export interface IPatchPreviewFileWire {
  path: string;
  ok: boolean;
  message?: string;
}

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IApplyPatchDialogInit {
  patchPath: string;
  previewLineCap: number;
  /** Remembered form state, so the dialog reopens where the user left it. */
  stripLevel: number;
  baseDir: string;
  useAm: boolean;
}

/** Webview → host messages. */
export type ApplyPatchDialogInbound =
  | { type: 'cancel' }
  | { type: 'browse' }
  | {
      // Carries the same options as `apply` so the preview's dry run
      // reflects exactly what applying would do.
      type: 'preview';
      patchPath?: string;
      useClipboard?: boolean;
      useAm?: boolean;
      stripLevel?: number;
      baseDir?: string;
    }
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
  | { type: 'preview'; content: string; files: IPatchPreviewFileWire[] }
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
