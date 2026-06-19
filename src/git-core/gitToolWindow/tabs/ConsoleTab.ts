/**
 * Console tab host-side message handler.
 *
 * The HTML body is rendered by `html/consoleHtml.ts` from the provider's
 * captured `_consoleEntries`. This handler routes `console.*` webview messages;
 * `console.clear` / `console.filter` are not yet surfaced in the UI.
 */

import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';

export function createConsoleTabHandler(): TabMessageHandler {
  return (message: IWebviewTabMessage): void => {
    // No-op handler. Present so the router can dispatch console.* messages
    // without falling through to the Log handler.
    //
    // Planned message types: 'console.clear', 'console.filter'.
    void message;
  };
}
