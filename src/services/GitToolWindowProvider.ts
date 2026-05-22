/**
 * Re-export shim for GitToolWindowProvider.
 *
 * T1-05 Phase 1 moved the implementation to `./gitToolWindow/GitToolWindowProvider.ts`.
 * This shim preserves the stable import path `src/services/GitToolWindowProvider`
 * that extension.ts, command handlers, tests, and other modules already use.
 *
 * DO NOT add logic here — only re-exports. New code should import from the
 * implementation location directly.
 */

export {
  GitToolWindowProvider,
  GIT_TOOL_WINDOW_VIEW_ID,
  INITIAL_COMMIT_LOAD_COUNT,
  INCREMENTAL_COMMIT_LOAD_COUNT,
  INTELLIJ_FILE_STATUS_COLORS,
} from './gitToolWindow/GitToolWindowProvider';

export type {
  LocalChangesContextAction,
  LogContextAction,
  IExtendedLogState,
  WaveAInboundMessage,
  WaveAOutboundMessage,
} from './gitToolWindow/GitToolWindowProvider';
