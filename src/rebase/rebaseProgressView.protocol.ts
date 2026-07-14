/**
 * Wire protocol for the Rebase Progress view (standalone panel). NO vscode
 * import. Frozen wire; the view re-renders its HTML rather than posting, so the
 * outbound side is `never`.
 */

export type RebaseProgressViewInbound =
  | { type: 'continue' }
  | { type: 'abort' }
  | { type: 'skip' }
  | { type: 'provideRewordMessage'; message?: string }
  | { type: 'refresh' };

export type RebaseProgressViewOutbound = never;

export const REBASE_PROGRESS_VIEW_INBOUND_TYPES = [
  'continue',
  'abort',
  'skip',
  'provideRewordMessage',
  'refresh',
] as const;

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
