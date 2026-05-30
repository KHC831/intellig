/**
 * Phase 1 stub for the Update Info tab host-side handler.
 *
 * Phase 3 renders the post-pull summary (commits pulled, files changed,
 * per-repo breakdown).
 */

import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';

export function createUpdateInfoTabHandler(): TabMessageHandler {
  return (message: IWebviewTabMessage): void => {
    // No-op Phase 1. Known Phase-3 message: 'updateInfo.refresh'.
    void message;
  };
}
