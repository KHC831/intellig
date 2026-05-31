/**
 * Stub for the Console tab host-side handler.
 *
 * The HTML body is rendered by `html/consoleHtml.ts`. A future change will wire
 * this handler to `ConsoleService.stream` and implement `console.clear` /
 * `console.filter` (design §3.4).
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
