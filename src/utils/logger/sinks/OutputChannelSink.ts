/**
 * `OutputChannelSink` — the user-visible `LogSink` backed by the shared
 * `IntelliG` `vscode.OutputChannel`.
 *
 * This sink is the canonical user-visible logging surface for the
 * extension. It writes one rendered block per
 * `LogRecord` to the channel returned by
 * `getOutputChannel()` from `src/utils/outputChannel.ts`, so a user
 * reproducing a bug can copy logs from `Output → IntelliG` into a
 * report without enabling extension-development mode.
 *
 * ### Channel ownership boundary
 *
 * The underlying `vscode.OutputChannel` is owned by
 * `initOutputChannel(context)` (which pushes the channel onto
 * `context.subscriptions` exactly once). This sink **borrows** the
 * channel — `dispose()` here detaches the sink only and never calls
 * `outputChannel.dispose()`. VS Code disposes the
 * underlying channel when the extension deactivates, via the
 * subscription registered by `initOutputChannel`. This split keeps the
 * sink independent of the channel's lifecycle: tests that swap the
 * sink in and out via `__resetLoggerForTest()` do not destroy the
 * channel, and `initOutputChannel` does not need to know whether a
 * sink is currently attached.
 *
 * ### Threshold filtering
 *
 * `admits(record)` consults the shared `LogLevelResolver`. The Logger
 * also short-circuits before allocating a record when no sink admits
 * it; this sink's `admits` is consulted again
 * at emit time so a future per-sink override (e.g. a test sink that
 * captures only warn/error) can land without changes to the Logger.
 *
 * ### Rendering grammar
 *
 * `emit(record)` calls `formatRecord` from `../render.ts` and writes
 * the resulting block via `outputChannel.appendLine`. `appendLine`
 * supplies the trailing line terminator, so each record renders as a
 * single block followed by exactly one newline.
 * The Logger guarantees the record is sanitized before reaching this
 * sink, so no further redaction is performed here.
 *
 * @see design.md → "OutputChannel sink rendering grammar"
 */

import { getOutputChannel } from '../../outputChannel';
import type { LogLevelResolver } from '../levels';
import { formatRecord } from '../render';

import type { LogRecord, LogSink } from './types';
import { SINK_NAME_OUTPUT_CHANNEL } from './types';

/**
 * `LogSink` implementation that mirrors records to the shared
 * `IntelliG` `vscode.OutputChannel` returned by `getOutputChannel()`.
 *
 * Instances are constructed by `initLogger(context)` with
 * the Logger's shared `LogLevelResolver`, and registered against
 * `context.subscriptions` so the Logger detaches them on deactivate.
 *
 * Rendering is delegated to `formatRecord` (`../render.ts`) so the
 * grammar is encoded in exactly one place; this sink only owns the
 * `appendLine` boundary.
 */
export class OutputChannelSink implements LogSink {
  /** Stable identifier; matches the `'output-channel'` constant. */
  readonly name = SINK_NAME_OUTPUT_CHANNEL;

  private readonly _resolver: LogLevelResolver;
  private _disposed = false;

  /**
   * @param resolver shared `LogLevelResolver` owned by the Logger.
   *   The sink consults `resolver.admits(record.level)` on every
   *   `admits` call so threshold changes (driven by
   *   `intellig.log.level` updates) take effect on the next record
   *   without re-registering the sink.
   */
  constructor(resolver: LogLevelResolver) {
    this._resolver = resolver;
  }

  /**
   * Returns `true` if the record's level is admitted by the resolver's
   * current threshold. After `dispose()` the sink admits no records
   * so a stale reference held by a test or by the Logger during a
   * teardown race never produces a write to the channel.
   */
  admits(record: LogRecord): boolean {
    if (this._disposed) {
      return false;
    }
    return this._resolver.admits(record.level);
  }

  /**
   * Render `record` via `formatRecord` and write the resulting block
   * to the shared OutputChannel. `appendLine` supplies the trailing
   * newline (one block per record, terminated by newline).
   * After `dispose()` this is a no-op so a late-arriving emit
   * (e.g. a queued microtask) cannot resurrect a torn-down sink.
   */
  emit(record: LogRecord): void {
    if (this._disposed) {
      return;
    }
    const block = formatRecord(record);
    getOutputChannel().appendLine(block);
  }

  /**
   * Detach this sink. Idempotent: subsequent calls are no-ops. Does
   * NOT dispose the underlying `vscode.OutputChannel` — that channel
   * is owned by `initOutputChannel(context)` and is disposed by VS
   * Code when the extension deactivates.
   */
  dispose(): void {
    this._disposed = true;
  }
}
