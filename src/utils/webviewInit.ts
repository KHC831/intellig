/**
 * Init-island helpers shared by a webview host and its bundled TS entry.
 *
 * A panel's initial state is baked into the body as a `data-*` attribute on a
 * hidden element (the "island"), not posted as a message and not embedded in an
 * inline `<script>` (which check:no-string-scripts bans). The host serializes it
 * with {@link initIslandHtml}; the entry reads it on boot with
 * {@link parseInitIsland}. Both sides type the payload against the panel's
 * `*.protocol.ts`, so a field the entry reads but the host never wrote is a
 * compile error.
 *
 * Deliberately DOM-free AND vscode-free: the host (Node lib, no DOM) and the
 * entry (DOM lib, no node/vscode) both compile it. The entry passes the read
 * attribute string in — this module never touches `document`.
 */

export const INIT_ELEMENT_ID = 'intellig-init';

/** Host side: the hidden island element carrying the JSON init payload. */
export function initIslandHtml(init: unknown): string {
  // JSON.stringify returns `undefined` (not a string) for `undefined`, a
  // function, or a symbol — serialize those as `null` so a panel with an absent
  // init degrades gracefully instead of throwing a TypeError here.
  const escaped = (JSON.stringify(init) ?? 'null')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div id="${INIT_ELEMENT_ID}" data-init="${escaped}" hidden></div>`;
}

/** Webview side: parse the island's `data-init` attribute value. */
export function parseInitIsland<T>(raw: string | null | undefined): T {
  if (!raw) {
    throw new Error('intellig webview init island missing or empty');
  }
  return JSON.parse(raw) as T;
}
