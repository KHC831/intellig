import { safeFireAndForget } from './safeFireAndForget';
import { getLogger, type Bindings } from './logger';

/**
 * Run a webview message handler under the standard dispatch guard: async
 * rejections are logged via {@link safeFireAndForget}, and a synchronous
 * throw is caught and logged so it cannot take down the host's message
 * dispatcher. Shared by BaseWebviewView, BaseWebviewPanel, and panel-hosting
 * providers so the guard contract cannot drift between hosts.
 */
export function dispatchGuardedWebviewMessage(
  dispatch: () => void | Promise<void>,
  opts: {
    /** Logger component the sync-throw error is attributed to. */
    component: string;
    /** Label safeFireAndForget logs async rejections under. */
    rejectionLabel: string;
    /** Message logged when the handler throws synchronously. */
    syncThrowMessage: string;
    /** Optional context bag for the sync-throw log line. */
    context?: Bindings;
  }
): void {
  try {
    safeFireAndForget(Promise.resolve(dispatch()), opts.rejectionLabel);
  } catch (error) {
    const err = error instanceof Error ? error : undefined;
    const logger = getLogger().child({ component: opts.component });
    if (opts.context) {
      logger.error(opts.syncThrowMessage, opts.context, err);
    } else {
      logger.error(opts.syncThrowMessage, err);
    }
  }
}
