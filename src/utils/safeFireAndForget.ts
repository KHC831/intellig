/**
 * Shared helper for state-sync / initialization fire-and-forget calls.
 *
 * The codebase has several `void this.asyncMethod()` patterns where the
 * caller is synchronous (event handler, constructor, debounce timer) and
 * cannot `await`. Before this helper, a rejected promise silently
 * disappeared — no console trace, no telemetry, no way to diagnose
 * user-reported "the UI didn't refresh after X" bugs.
 *
 * `safeFireAndForget` routes those rejections through `console.error` with
 * a caller-supplied context string. The context MUST be specific enough to
 * grep for (class + method + trigger), so an extension-host trace pinpoints
 * the offending call site.
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
 * rejection on the floor is still worse than a console log.
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

/**
 * Fire the given promise without awaiting, logging any rejection to
 * `console.error` tagged with the caller-supplied `context`.
 *
 * @param promise - The promise to observe. VS Code's `Thenable<void>` is
 *   accepted alongside native `Promise<void>`.
 * @param context - A grep-friendly tag identifying the call site. Include
 *   the class name, method name, and trigger — e.g. `'ShelfView.unshelve
 *   refresh after success'`.
 */
export function safeFireAndForget(promise: Promise<void> | Thenable<void>, context: string): void {
  Promise.resolve(promise).catch((err: unknown) => {
    // Keep the log prefix stable so the extension-host troubleshooting
    // docs can grep for it. Do NOT sanitize here — raw stacks belong in
    // the console for debugging; user-facing toasts live at the
    // internalised-catch pattern documented in the module JSDoc.
    console.error(`[intellig] ${context}:`, err);
  });
}
