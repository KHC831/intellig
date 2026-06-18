/**
 * LogTab handler.
 *
 * For the Log tab, all business logic continues to live inside the monolithic
 * `GitToolWindowProvider.onDidReceiveMessage` switch, which is left intact (see
 * design section 3.6: extract log HTML intact first, layer tab strip later). This
 * module is therefore a thin identity handler — the TabRouter returns early for
 * `log` messages and the provider handles them as before.
 *
 * As log-specific handlers are gradually migrated out of the switch,
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
