/**
 * Phase 1 stub for the Incoming tab host-side handler.
 *
 * Phase 2 will wire this to `git rev-list HEAD..@{u}` + jump-to-commit routing
 * (forwards `incoming.jumpToCommit` to the Log tab's scroll-to-commit path).
 */

import type { IWebviewTabMessage, TabMessageHandler } from '../tabRouter';

export function createIncomingTabHandler(): TabMessageHandler {
  return (message: IWebviewTabMessage): void => {
    // No-op Phase 1. Known Phase-2 messages:
    //   'incoming.refresh', 'incoming.jumpToCommit'
    void message;
  };
}
