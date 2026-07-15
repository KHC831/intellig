/**
 * Wire protocol for the interactive Rebase Editor (standalone panel). NO
 * runtime vscode import (the two type-only imports are erased). Frozen wire; the
 * editor re-renders its HTML rather than posting, so outbound is `never`.
 */
import type { RebaseAction } from '../git-core/interfaces/rebaseAction';
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** One action option in each row's dropdown. */
export interface IRebaseActionOption {
  value: RebaseAction;
  label: string;
  description: string;
}

/** One commit row baked into the init island. */
export interface IRebaseEditorCommit {
  hash: string;
  shortHash: string;
  message: string;
  action: RebaseAction;
  actionClass: string;
  showMessageEditor: boolean;
  rewordValue: string;
}

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IRebaseEditorInit {
  originalBranch: string;
  onto: string;
  commitCount: number;
  /** Scroll restoration is on by DEFAULT; false only on a fresh rebase's first render. */
  preserveScroll: boolean;
  placeholders: Partial<Record<RebaseAction, string>>;
  actions: IRebaseActionOption[];
  commits: IRebaseEditorCommit[];
}

export type RebaseEditorInbound =
  | { type: 'execute' }
  | { type: 'cancel' }
  | { type: 'updateAction'; hash?: string; action?: RebaseAction }
  | { type: 'reorder'; fromIndex?: number; toIndex?: number }
  | { type: 'updateMessage'; hash?: string; message?: string };

export type RebaseEditorOutbound = never;

export const REBASE_EDITOR_INBOUND_TYPES = [
  'execute',
  'cancel',
  'updateAction',
  'reorder',
  'updateMessage',
] as const;

export function asRebaseEditorInbound(message: unknown): RebaseEditorInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (REBASE_EDITOR_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as RebaseEditorInbound)
    : undefined;
}

/** Compile tie: REBASE_EDITOR_INBOUND_TYPES and RebaseEditorInbound agree both ways (check:typed-messages Rule D). */
const _rebaseEditorInboundTie: AssertInboundArrayTie<
  InboundArrayTie<RebaseEditorInbound, typeof REBASE_EDITOR_INBOUND_TYPES>
> = true;
void _rebaseEditorInboundTie;
