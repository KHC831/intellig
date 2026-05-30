/**
 * LogTab handler — Phase 1.
 *
 * For the Log tab, all business logic continues to live inside the monolithic
 * `GitToolWindowProvider.onDidReceiveMessage` switch. Phase 1 leaves that
 * switch intact (see design §3.6: extract log HTML intact first, layer tab
 * strip later). This module is therefore a thin identity handler — the
 * TabRouter returns early for `log` messages and the provider handles them as
 * before.
 *
 * When Phase 2/3 gradually migrates log-specific handlers out of the switch,
 * they will move here.
 */

import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';

/**
 * Construct the identity handler for the Log tab. Present so the router's
 * registration API stays uniform across all tabs.
 */
export function createLogTabHandler(): TabMessageHandler {
  return (_message: IWebviewTabMessage): void => {
    // Intentionally empty. The provider's existing switch owns log dispatch.
  };
}
