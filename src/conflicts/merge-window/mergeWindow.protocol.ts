/**
 * Wire protocol shared by the merge-window HOST (MergeWindowPanel) and its
 * webview entry (webview/main.ts). Extracted so both sides type the SAME shapes
 * instead of duplicating them — a field renamed on one side now breaks compile
 * on the other.
 *
 * NO vscode import: this module must be importable by the webview TS bundle.
 * Shapes are the frozen wire — do not rename fields here (Phase 5 owns wire
 * cleanups).
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../../utils/protocolTie';

/** Host → webview: seed the three-pane merge model. */
export type MergeWindowInitMessage = {
  readonly type: 'init';
  readonly left: string;
  readonly base: string;
  readonly right: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly fileName: string;
  /** IntelliJ's "Automatically apply non-conflicting changes" (opt-in). */
  readonly autoApplyNonConflicting?: boolean;
};

/** Everything the host may post to the merge-window webview. */
export type MergeWindowOutbound = MergeWindowInitMessage;

/** Everything the webview may post back to the host. */
export type MergeWindowInbound =
  | { readonly type: 'ready' }
  | { readonly type: 'apply'; readonly resultText: string }
  | { readonly type: 'abort'; readonly modified: boolean }
  | {
      readonly type: 'state';
      readonly unresolved: number;
      readonly total: number;
      readonly modified: boolean;
    }
  | { readonly type: 'log'; readonly level: 'warn' | 'error'; readonly text: string };

/** Runtime discriminant set — the host guard rejects an unknown type before dispatch. */
export const MERGE_WINDOW_INBOUND_TYPES = ['ready', 'apply', 'abort', 'state', 'log'] as const;

/**
 * Narrow an untrusted wire message to {@link MergeWindowInbound} by its
 * discriminant, or `undefined` for an unknown/old type. Field-level validation
 * (e.g. a destructive `apply` requiring a string `resultText`) stays fail-closed
 * at the handler.
 */
export function asMergeWindowInbound(message: unknown): MergeWindowInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (MERGE_WINDOW_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as MergeWindowInbound)
    : undefined;
}

/** Compile tie: MERGE_WINDOW_INBOUND_TYPES and MergeWindowInbound agree both ways (check:typed-messages Rule D). */
const _mergeWindowInboundTie: AssertInboundArrayTie<
  InboundArrayTie<MergeWindowInbound, typeof MERGE_WINDOW_INBOUND_TYPES>
> = true;
void _mergeWindowInboundTie;
