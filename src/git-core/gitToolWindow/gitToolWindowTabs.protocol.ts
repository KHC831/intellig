/**
 * Wire protocol for the Git Tool Window's TAB channel (webview → host) — the
 * messages the tabRouter dispatches by `tab`/`<tab>.` prefix, distinct from the
 * frozen log-graph channel in `gitToolWindow.protocol.ts`. NO runtime vscode
 * import; `TabId` comes from the vscode-free `tabIds` module. Frozen wire.
 *
 * The bundled entry posts every variant below (tab-strip switch + the History
 * tab's commit list / toolbar). `asGitToolWindowTabsInbound` is the host-side
 * recognizer used at the message-routing boundary (`_routeIfNonLog`); the
 * `_INBOUND_TYPES` array + Rule-D tie keep it in lockstep with the union.
 */
import type { TabId } from './tabIds';
import type { AssertInboundArrayTie, InboundArrayTie } from '../../utils/protocolTie';

/** Webview → host messages on the tab channel (tab switch + History tab). */
export type GitToolWindowTabsInbound =
  | { type: 'tabChange'; tab: TabId }
  | { type: 'history.selectRevision'; rev: string; additive?: boolean }
  | { type: 'history.openAtRevision'; rev: string }
  | { type: 'history.toggleFollowRenames'; value: boolean }
  | { type: 'history.setBranchFilter'; branch?: string }
  | { type: 'history.getVersion'; rev: string }
  | { type: 'history.compareWithLocal'; rev: string }
  | { type: 'history.compareWith'; from: string; to: string };

export const GIT_TOOL_WINDOW_TABS_INBOUND_TYPES = [
  'tabChange',
  'history.selectRevision',
  'history.openAtRevision',
  'history.toggleFollowRenames',
  'history.setBranchFilter',
  'history.getVersion',
  'history.compareWithLocal',
  'history.compareWith',
] as const;

export function asGitToolWindowTabsInbound(message: unknown): GitToolWindowTabsInbound | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' &&
    (GIT_TOOL_WINDOW_TABS_INBOUND_TYPES as readonly string[]).includes(type)
    ? (message as GitToolWindowTabsInbound)
    : undefined;
}

/** Compile tie: array and union agree both ways (check:typed-messages Rule D). */
const _gitToolWindowTabsInboundTie: AssertInboundArrayTie<
  InboundArrayTie<GitToolWindowTabsInbound, typeof GIT_TOOL_WINDOW_TABS_INBOUND_TYPES>
> = true;
void _gitToolWindowTabsInboundTie;
