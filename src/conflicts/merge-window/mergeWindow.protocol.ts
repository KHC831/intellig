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
  /**
   * Result text saved when a previous merge window for this file closed
   * with unsaved edits; seeds the result editor (as a modified state).
   */
  readonly restoredResult?: string;
};

/** Destructive toolbar actions the webview must have confirmed by a host modal. */
export type MergeWindowConfirmAction = 'acceptLeft' | 'acceptRight' | 'applyUnresolved';

/** Host → webview: the user's answer to a `confirm` request. */
export type MergeWindowConfirmResultMessage = {
  readonly type: 'confirmResult';
  readonly requestId: number;
  readonly confirmed: boolean;
};

/** Everything the host may post to the merge-window webview. */
export type MergeWindowOutbound = MergeWindowInitMessage | MergeWindowConfirmResultMessage;

/** Everything the webview may post back to the host. */
export type MergeWindowInbound =
  | { readonly type: 'ready' }
  | { readonly type: 'apply'; readonly resultText: string }
  | { readonly type: 'abort'; readonly modified: boolean }
  | {
      readonly type: 'confirm';
      readonly requestId: number;
      readonly action: MergeWindowConfirmAction;
      /** Unresolved plain changes ('applyUnresolved' only). */
      readonly changes?: number;
      /** Unresolved conflicts ('applyUnresolved' only). */
      readonly conflicts?: number;
    }
  | {
      readonly type: 'state';
      readonly unresolved: number;
      readonly total: number;
      readonly modified: boolean;
      /**
       * True while the result still equals what the window produced on its
       * own — the base, plus any non-conflicting changes auto-apply landed.
       *  cannot answer this: auto-apply routes through the same
       * command path a user edit does and sets it.
       */
      readonly pristine?: boolean;
      /** The current result text, present while modified — the host persists
       * it so a closed tab (which VS Code cannot veto) can be restored. */
      readonly resultText?: string;
    }
  | {
      readonly type: 'log';
      /** 'fatal' means the webview cannot continue: the host toasts and closes it. */
      readonly level: 'warn' | 'error' | 'fatal';
      readonly text: string;
    };

/** Runtime discriminant set — the host guard rejects an unknown type before dispatch. */
export const MERGE_WINDOW_INBOUND_TYPES = [
  'ready',
  'apply',
  'abort',
  'confirm',
  'state',
  'log',
] as const;

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
