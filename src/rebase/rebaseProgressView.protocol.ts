/**
 * Wire protocol for the Rebase Progress view (standalone panel). NO vscode
 * import. Frozen wire; the view re-renders its HTML rather than posting, so the
 * outbound side is `never`.
 */
import type { AssertInboundArrayTie, InboundArrayTie } from '../utils/protocolTie';

/** One commit row baked into the init island. */
export interface IRebaseProgressCommit {
  shortHash: string;
  action: string;
  message: string;
  statusIcon: string;
  statusClass: string;
}

/** Rebase-progress detail (present when a session exists). */
export interface IRebaseProgressDetail {
  originalBranch: string;
  onto: string;
  currentStep: number;
  totalSteps: number;
  progressPercent: number;
  currentCommit: { shortHash: string; action: string; message: string } | null;
  commits: IRebaseProgressCommit[];
}

/** Initial state the host bakes into the body island; the entry reads it on boot. */
export interface IRebaseProgressViewInit {
  statusText: string;
  statusClass: string;
  hasSession: boolean;
  progress: IRebaseProgressDetail | null;
  isConflict: boolean;
  conflictFiles: string[];
  rebaseInProgress: boolean;
  showContinue: boolean;
  showSkip: boolean;
  showAbort: boolean;
}

export type RebaseProgressViewInbound =
  { type: 'continue' } | { type: 'abort' } | { type: 'skip' } | { type: 'refresh' };

export type RebaseProgressViewOutbound = never;

export const REBASE_PROGRESS_VIEW_INBOUND_TYPES = ['continue', 'abort', 'skip', 'refresh'] as const;

export function asRebaseProgressViewInbound(
  message: unknown
): RebaseProgressViewInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (REBASE_PROGRESS_VIEW_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as RebaseProgressViewInbound)
    : undefined;
}

/** Compile tie: REBASE_PROGRESS_VIEW_INBOUND_TYPES and RebaseProgressViewInbound agree both ways (check:typed-messages Rule D). */
const _rebaseProgressViewInboundTie: AssertInboundArrayTie<
  InboundArrayTie<RebaseProgressViewInbound, typeof REBASE_PROGRESS_VIEW_INBOUND_TYPES>
> = true;
void _rebaseProgressViewInboundTie;
