/**
 * Correlation-id propagation for the structured Logger.
 *
 * Every IntelliG-owned command handler runs inside a fresh
 * `AsyncLocalStorage` frame keyed by a randomly-generated
 * `correlationId` (and the registered `commandId`). The Logger reads
 * the current frame at *emit time* (not at `child(bindings)`-time) so
 * a child Logger constructed inside one frame and called inside
 * another correctly attributes records to the *current* frame; this
 * matches the propagation contract documented in
 * `design.md` → Architecture → Correlation-id propagation.
 *
 * Key properties:
 *
 * - **Non-fabrication**: when no command-handler frame is on the
 *   stack (e.g. a watcher event handler firing outside a
 *   `_store.run(...)` callback), `getCurrentCorrelationId()` returns
 *   `undefined`. The Logger omits the `correlationId` field rather
 *   than synthesizing one (Requirement 5.5, 14.9).
 * - **Capture at call time**: `safeFireAndForget` reads
 *   `getCurrentCorrelationId()` at call time and closes over the
 *   value for its rejection log. The `AsyncLocalStorage` frame may
 *   have already popped by the time the rejection fires; the captured
 *   string still propagates (Requirement 5.3).
 * - **No mutation**: the frame object is never mutated; child
 *   loggers cannot rebind `correlationId` on the in-flight frame
 *   (Requirement 5.2 — `child(bindings)` may override the rendered
 *   value, but the underlying store is left alone).
 *
 * Scope: this module owns the store and the `registerLoggedCommand`
 * wrapper. The Logger module (task 3.1) consumes
 * `_readCorrelationStore()` at emit time. `safeFireAndForget`
 * (task 7.1) consumes `getCurrentCorrelationId()` at call time.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
// Forward-declare `getLogger` via a circular-safe ES import. `logger.ts`
// imports `_readCorrelationStore` from this file, so this forms a
// circular dependency. Node + ts-node both handle the cycle at runtime
// because `getLogger` is invoked LAZILY inside `registerLoggedCommand`'s
// per-call closure — by the time a command actually runs, both modules
// have finished initialising and the import binding is live.
import { getLogger } from './logger';

/**
 * One per-command frame stored in `AsyncLocalStorage`.
 *
 * - `correlationId`: 16-char lowercase hex string from
 *   `crypto.randomBytes(8).toString('hex')`. Stable for the lifetime
 *   of the frame.
 * - `commandId`: the VS Code command id passed to
 *   `registerLoggedCommand`. Populated for command-rooted frames; may
 *   be omitted by other (future) callers that establish a frame
 *   without a registered command. Kept optional so the type also
 *   models the synthetic frames test code may set up.
 */
export interface ICorrelationFrame {
  readonly correlationId: string;
  readonly commandId?: string;
}

/**
 * Module-level store. Underscore-prefixed because no consumer outside
 * this file should reach into it directly — read access goes through
 * `getCurrentCorrelationId` / `getCurrentCommandId` /
 * `_readCorrelationStore`, and writes happen only inside
 * `registerLoggedCommand`'s `_store.run(...)` call.
 */
const _store = new AsyncLocalStorage<ICorrelationFrame>();

/**
 * Returns the current frame's `correlationId`, or `undefined` when no
 * command-handler frame is on the stack.
 *
 * Callers MUST treat `undefined` as "no correlation"; they MUST NOT
 * synthesize an id of their own — that breaks Requirement 14.9 (no
 * fabrication).
 */
export function getCurrentCorrelationId(): string | undefined {
  return _store.getStore()?.correlationId;
}

/**
 * Returns the current frame's `commandId`, or `undefined` when no
 * command-handler frame is on the stack (or the frame was established
 * without a command id).
 */
export function getCurrentCommandId(): string | undefined {
  return _store.getStore()?.commandId;
}

/**
 * Internal accessor used by the Logger at emit time. Public callers
 * should prefer `getCurrentCorrelationId()` / `getCurrentCommandId()`.
 *
 * Underscore-prefixed to signal the cross-module-but-internal nature
 * of the call — the Logger and this module ship together as a unit.
 *
 * @internal
 */
export function _readCorrelationStore(): ICorrelationFrame | undefined {
  return _store.getStore();
}

/**
 * Test-only seam.
 *
 * `AsyncLocalStorage` exposes no public reset API: every frame is
 * scoped to its own `_store.run(...)` call, and the store has no
 * global outside-of-frame state to clear. This export exists for
 * symmetry with the rest of the Logger module's
 * `__resetXxxForTest()` helpers and as a documentation anchor — test
 * code that calls it after a `_store.run(...)` block has already
 * exited is a no-op, which is correct.
 *
 * @internal
 */
export function __resetCorrelationStoreForTest(): void {
  // Intentional no-op: AsyncLocalStorage frames are run-scoped; there
  // is no global state to drop. See comment above.
}

/**
 * Wrap `vscode.commands.registerCommand` with a fresh correlation
 * frame.
 *
 * Use this for every IntelliG-owned command handler. From the VS Code
 * side the returned `Disposable` is indistinguishable from one
 * produced by `vscode.commands.registerCommand` directly: same
 * dispose semantics, same arg-passing, same `Promise` propagation.
 * The only difference is that the body of `handler` runs inside an
 * `_store.run({ correlationId, commandId }, () => ...)` frame, so any
 * Logger emission from the body (or from awaited descendants — that's
 * the whole point of `AsyncLocalStorage`) carries the frame's
 * `correlationId`.
 *
 * `correlationId` is a 16-character lowercase hex string from
 * `crypto.randomBytes(8).toString('hex')` (Requirement 5.1). A new id
 * is generated per invocation, so two consecutive command runs
 * produce two distinct frames.
 *
 * The wrapper preserves the handler's return value verbatim — VS Code
 * awaits the returned `Promise` (or value) for command-result
 * propagation, and `_store.run(callback, ...)` returns the callback's
 * return value as-is.
 *
 * The `(...args: any[])` argument shape mirrors the VS Code
 * `registerCommand` callback contract verbatim — VS Code's d.ts types
 * the callback as `(...args: any[]) => any`, so command handlers
 * declared with strongly-typed parameters (e.g.
 * `(changelistId?: string)`, `(fileUri?: vscode.Uri)`) must be
 * assignable here without a cast. Tightening to `unknown[]` would
 * reject every typed handler at the call site, defeating the whole
 * purpose of the wrapper. The `T | Promise<T>` return type still
 * preserves the awaited result contract for callers that care.
 */
export function registerLoggedCommand<T>(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (...args: any[]) => T | Promise<T>
): vscode.Disposable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return vscode.commands.registerCommand(id, (...args: any[]) => {
    const correlationId = crypto.randomBytes(8).toString('hex');
    const frame: ICorrelationFrame = { correlationId, commandId: id };

    // Observability — emit a debug-level invocation record and a
    // warn-level rejection record for every command. Without this layer,
    // command handlers that swallow failures (returned the failure shape
    // instead of throwing) left no trace at all in the IntelliG
    // OutputChannel. The original example: "Rebase Current onto This"
    // with a dirty working tree showed no toast and no log entry; the
    // user could not tell whether the click was even received.
    //
    // Both records run inside the correlation frame via `_store.run`, so
    // they pick up `commandId` and `correlationId` automatically through
    // the Logger's frame-aware emit path.
    return _store.run(frame, () => {
      const logger = getLogger().child({ component: 'Command' });
      // Embed `commandId` in the message text so it surfaces as a
      // human-readable substring in `Output → IntelliG`. The renderer
      // does not project frame.commandId into the rendered line; only
      // correlationId is exposed via `cid=`. Keeping the id in the text
      // makes the records both grep-friendly and self-describing.
      logger.debug(`command invoked: ${id}`);

      let outcome: T | Promise<T>;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        outcome = handler(...args);
      } catch (err) {
        logger.warn(`command handler threw synchronously: ${id}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      if (outcome instanceof Promise) {
        return outcome.then(
          (value): T => {
            logger.debug(`command resolved: ${id}`);
            return value;
          },
          (err: unknown): never => {
            // VS Code surfaces command rejections to the user as a generic
            // toast; log them here too so the failure has a record in the
            // IntelliG channel that ties back to the correlation id.
            logger.warn(`command handler rejected: ${id}`, {
              error: err instanceof Error ? err.message : String(err),
            });
            throw err;
          }
        );
      }

      logger.debug(`command resolved: ${id}`);
      return outcome;
    });
  });
}
