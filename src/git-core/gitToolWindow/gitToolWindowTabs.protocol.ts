/**
 * Wire protocol for the Git Tool Window's TAB channel (webview → host) — the
 * messages the tabRouter dispatches by `tab`/`<tab>.` prefix, distinct from the
 * frozen log-graph channel in `gitToolWindow.protocol.ts`. NO runtime vscode
 * import; `TabId` comes from the vscode-free `tabIds` module. Frozen wire.
 *
 * C2a lands only the union type (the bundled entry posts `history.selectRevision`
 * from the parent-hash click inside the History details panel). The runtime
 * guard + `*_INBOUND_TYPES` discriminant array + Rule-D tie + tabRouter wiring
 * ride C2b, when the tab-strip + history behavior scripts fold into the entry.
 */
import type { TabId } from './tabIds';

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
