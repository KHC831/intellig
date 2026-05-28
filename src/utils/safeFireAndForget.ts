/**
 * Shared helper for state-sync / initialization fire-and-forget calls.
 *
 * The codebase has several `void this.asyncMethod()` patterns where the
 * caller is synchronous (event handler, constructor, debounce timer) and
 * cannot `await`. Before this helper, a rejected promise silently
 * disappeared — no console trace, no telemetry, no way to diagnose
 * user-reported "the UI didn't refresh after X" bugs.
 *
 * `safeFireAndForget` routes those rejections through the structured
 * IntelliG Logger with a caller-supplied context string. The context
 * MUST be specific enough to grep for (class + method + trigger), so an
 * extension-host trace pinpoints the offending call site.
 *
 * ### Routing through the Logger (Requirement 5.3, 6.7)
 *
 * The rejection is forwarded to `getLogger().error(context, { correlationId }, err)`:
 *
 * - The current Correlation_Id is read from the correlation store with
 *   `getCurrentCorrelationId()` **at call time** and closed over in the
 *   rejection handler. The `AsyncLocalStorage` frame may have popped by
 *   the time the rejection settles, so a read inside the `.catch`
 *   would return `undefined` — capturing eagerly preserves the cid that
 *   was in scope when the caller fired the promise.
 * - When called outside any `registerLoggedCommand` frame the captured
 *   cid is `undefined`; the Logger then omits the `correlationId` field
 *   (Requirement 5.5) rather than fabricating one.
 * - The Logger's existing OutputChannel sink renders the rejection into
 *   the user-visible `Output → IntelliG` channel uniformly with every
 *   other emission, replacing the bespoke OutputChannel mirror this
 *   helper used to maintain. See `docs/adr/ADR-011-structured-logger.md`
 *   for the consolidation rationale.
 *
 * ### Context-string convention
 *
 * Use `ClassName.methodName: trigger-description`:
 *
 * ```ts
 * safeFireAndForget(this.refresh(),
 *   'ShelfView.setShowAlreadyUnshelved: refresh after toggle');
 * safeFireAndForget(this._initialRepoScan(),
 *   'GitService.constructor: initial repository discovery');
 * ```
 *
 * The colon separates the identifier (what) from the trigger (why), which
 * makes grepping by class+method independent of the reason text.
 *
 * ### When NOT to use this
 *
 * - For **data-safety** paths where a failure silently corrupts user data
 *   (e.g. MergeView's atomic-write to a file about to be committed), the
 *   correct pattern is an internalised `try/catch` that surfaces a
 *   sanitised `vscode.window.showErrorMessage` toast. See
 *   `MergeView.markResolved` for the reference implementation.
 *
 * - For **commands that can plausibly await** (e.g. command-palette
 *   handlers, test helpers), use `await` or `return` the promise — the
 *   caller already owns error surfacing.
 *
 * This helper is specifically for the in-between case: the caller must stay
 * synchronous, the failure is not directly user-visible, but dropping the
 * rejection on the floor is still worse than a structured log record.
 *
 * ### Explicitly out of scope (documented here so the audit stays honest)
 *
 * The following `void this.X()` call classes are intentionally NOT routed
 * through this helper:
 *
 * 1. **`void this._panel.webview.postMessage(...)` /
 *    `void this._view.webview.postMessage(...)` / `void this.postMessage(...)`** —
 *    The underlying `Thenable<boolean>` resolves `false` when the webview
 *    is already disposed; there's no reject path we need to observe. Seen
 *    in CommitToolWindow, GitToolWindowProvider (×5), MergeView, PushDialog (×2),
 *    ResolveConflictsDialog (×2).
 *
 * 2. **`void this.markResolved()` (MergeView:656)** — data-safety path,
 *    already handled with an internalised try/catch + sanitised toast
 *    inside `markResolved` itself. The outer `void` is the dispatcher;
 *    internalisation is the right pattern, not helper wrapping.
 *
 * 3. **`void this.reconcileWithGitStatus(repo).catch(...)`
 *    (ChangelistService:725)** — already wears an explicit `.catch` with
 *    a `console.error` log. Functionally equivalent to `safeFireAndForget`;
 *    left alone to keep the diff tight. Could be migrated in a future
 *    audit pass if we want exactly one canonical shape for this idiom.
 *
 * ### Why a fresh `Promise.resolve(...).catch` wrap
 *
 * Accepting a `PromiseLike`/`Thenable` and wrapping in `Promise.resolve`
 * normalises VS Code's `Thenable<T>` return types (e.g. from
 * `WorkspaceState.update`) alongside native `Promise` without the caller
 * having to cast. The wrapped `.catch` is guaranteed to run in the
 * microtask queue before any other handler we chain on top.
 */

import type * as vscode from 'vscode';

import { getCurrentCorrelationId, getLogger } from './logger';

/**
 * Options bag for `safeFireAndForget`. Kept on the public signature for
 * back-compat with existing call sites; the `outputChannel` field is no
 * longer read.
 *
 * @see docs/adr/ADR-011-structured-logger.md — the OutputChannel sink on
 *      the Logger is now the single mirror path; this helper no longer
 *      maintains a parallel one.
 */
export interface ISafeFireAndForgetOptions {
  /**
   * @deprecated Unused since the Logger consolidation in task 7.1
   *   (see `docs/adr/ADR-011-structured-logger.md`). The Logger's
   *   OutputChannel sink renders every rejection emitted by this helper
   *   into the shared `IntelliG` channel uniformly with the rest of the
   *   structured log stream, so a per-call channel override is no longer
   *   meaningful. Field is retained on the public signature so existing
   *   call sites compile without churn; the value is ignored.
   */
  outputChannel?: vscode.OutputChannel;
}

/**
 * Fire the given promise without awaiting, routing any rejection through
 * the IntelliG Logger as an error-level record tagged with
 * `context` and the current Correlation_Id (Requirement 5.3, 6.7).
 *
 * The current Correlation_Id is captured *at call time* — i.e. inside the
 * caller's synchronous frame, before the promise's microtask queue runs.
 * That value is closed over in the rejection handler so the emitted
 * record carries the cid that was active when the work was scheduled,
 * even if the `AsyncLocalStorage` frame has since popped.
 *
 * @param promise - The promise to observe. VS Code's `Thenable<void>` is
 *   accepted alongside native `Promise<void>`.
 * @param context - A grep-friendly tag identifying the call site. Include
 *   the class name, method name, and trigger — e.g. `'ShelfView.unshelve:
 *   refresh after success'`.
 * @param _options - Retained for back-compat; the `outputChannel` field
 *   is ignored. See {@link ISafeFireAndForgetOptions} and
 *   `docs/adr/ADR-011-structured-logger.md`.
 */
export function safeFireAndForget(
  promise: Promise<void> | Thenable<void>,
  context: string,
  _options?: ISafeFireAndForgetOptions
): void {
  // Capture the current Correlation_Id eagerly. Reading inside the
  // `.catch` would observe an empty store once the caller's
  // synchronous frame has unwound, so the cid we want is the one that
  // is in scope right now (Requirement 5.3).
  const cid = getCurrentCorrelationId();

  Promise.resolve(promise).catch((err: unknown) => {
    // Route through the Logger's `error` overload. When `err` is a
    // proper `Error` we forward it as the third positional so the
    // Logger renders the message + stack into the `err=` block; for
    // non-Error rejections the third argument is `undefined`, which
    // matches the Logger's expectation that `error.stack` is only
    // attached for true `Error` instances.
    //
    // The `correlationId` binding is supplied explicitly when present;
    // when absent we omit the field rather than passing `undefined`,
    // so the resulting `LogRecord` follows the "omit when no frame"
    // convention (Requirement 5.5).
    const bindings = cid !== undefined ? { correlationId: cid } : undefined;
    getLogger().error(context, bindings, err instanceof Error ? err : undefined);
  });
}
