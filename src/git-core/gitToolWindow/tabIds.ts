/**
 * Canonical tab-ID list for the Git Tool Window, split out of `tabRouter.ts`
 * so it can be imported without pulling in the router's vscode dependency
 * (`setContextKey` reaches the vscode API). A webview entry's `*.protocol.ts`
 * type-imports {@link TabId} through the wire-types module; keeping the list
 * here means that import stays vscode-free.
 *
 * `tabRouter.ts` re-exports every symbol below, so existing callers keep
 * importing `TAB_IDS` / `TabId` / `isTabId` from there unchanged.
 */

export const TAB_IDS = ['log', 'console', 'incoming', 'updateInfo', 'history'] as const;

/** Union of valid tab IDs. */
export type TabId = (typeof TAB_IDS)[number];

/** Type guard for {@link TabId}. */
export function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value);
}
