/**
 * Console tab host-side message handler.
 *
 * The HTML body is rendered by `html/consoleHtml.ts` from the provider's
 * captured `_consoleEntries`. This handler routes `console.*` webview messages
 * to the provider hooks that act on them.
 */

import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';

/** Provider capabilities the Console tab drives. */
export interface IConsoleTabHooks {
  /** Drop every captured entry (the toolbar's Clear). */
  clearConsole(): void;
}

export function createConsoleTabHandler(hooks?: IConsoleTabHooks): TabMessageHandler {
  return (message: IWebviewTabMessage): void => {
    if (message?.type === 'console.clear') {
      hooks?.clearConsole();
    }
  };
}
