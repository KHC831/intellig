/**
 * Re-export shim for GitToolWindowProvider.
 *
 * The implementation lives at `./gitToolWindow/GitToolWindowProvider.ts`.
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
} from '../git-core/gitToolWindow/GitToolWindowProvider';

export {
  INTELLIJ_FILE_STATUS_COLORS,
  FILE_STATUS_THEME_VARS,
} from '../git-core/gitToolWindow/provider/fileStatusTheme';

export type {
  IExtendedLogState,
  WaveAInboundMessage,
  WaveAOutboundMessage,
} from '../git-core/gitToolWindow/GitToolWindowProvider';

export type {
  LocalChangesContextAction,
  LogContextAction,
} from '../git-core/gitToolWindow/provider/logActions';
