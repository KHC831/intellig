/**
 * Stub for the Update Info tab host-side handler.
 *
 * A future change renders the post-pull summary (commits pulled, files changed,
 * per-repo breakdown).
 */

import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';

export function createUpdateInfoTabHandler(): TabMessageHandler {
  return (message: IWebviewTabMessage): void => {
    // No-op handler. Planned message: 'updateInfo.refresh'.
    void message;
  };
}
