/**
 * No-op `vscode.Event<T>` helper for narrow mocks.
 *
 * Earlier some `IGitService` events were declared optional on the
 * interface so that minimal test mocks didn't have to stub them.
 * Making `onDidRemoveRepository` required spares
 * production code from `?.()` guards across six future subscribers; this
 * helper is the one-line stub mocks reach for instead of building a
 * full `vscode.EventEmitter` per spec.
 *
 * Usage in a mock literal:
 *
 * ```ts
 * import { noopEvent } from '../../mocks/noopEvent';
 *
 * const stub: IGitService = {
 *   onDidChangeRepository: realEmitter.event,
 *   onDidRemoveRepository: noopEvent<IRepository>(),
 *   // …
 * };
 * ```
 *
 * The returned event accepts subscriptions but never fires. Each call
 * returns a fresh `vscode.Event<T>` — there's no shared module-level
 * state, which lets test isolation stay simple.
 */

import type * as vscode from 'vscode';

/**
 * Returns a fresh `vscode.Event<T>` whose subscribe path is a no-op
 * (registers a Disposable but never invokes the listener).
 */
export function noopEvent<T>(): vscode.Event<T> {
  return (_listener: (e: T) => unknown): vscode.Disposable => {
    void _listener;
    return { dispose: (): void => {} };
  };
}
