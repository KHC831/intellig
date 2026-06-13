/**
 * `ConsoleSink` — developer-only mirror that forwards rendered log
 * blocks to `console[level]` when `intellig.log.console` is `true`.
 *
 * This sink is the **one sanctioned production reference to
 * `console.*`** in the IntelliG codebase. The structural guard
 * `scripts/check-no-bare-console.sh` allowlists this
 * single file. Every other production call site routes through the
 * structured Logger, whose `OutputChannelSink` writes to the
 * user-visible `IntelliG` channel and whose optional `ConsoleSink`
 * (this module) provides the developer-mode mirror visible only in
 * the Extension Development Host.
 *
 * ### Behaviour
 *
 * - The sink reuses the **same rendered string** the
 *   `OutputChannelSink` would produce, by calling `formatRecord`
 *   directly. This guarantees byte-for-byte parity between the two
 *   sinks (asserted by the property test
 *   `loggerConsoleMirror.property.test.ts`).
 * - Each record is forwarded to the matching `console[level]` method
 *   with one exception: `trace` → `console.debug`. The mapping is a
 *   frozen lookup table to keep the per-emit
 *   cost predictable.
 * - The sink is **active only when** `LogLevelResolver.consoleEnabled`
 *   is `true` (driven by the `intellig.log.console` setting). When the
 *   flag is `false`, `admits` returns `false` and the Logger never
 *   calls `emit` — no allocation, no console call.
 * - The sink **shares the resolver's threshold** with
 *   `OutputChannelSink`. When the configured `intellig.log.level`
 *   rejects a record at the OutputChannel sink, this sink rejects it
 *   too — both sinks consult the same `LogLevelResolver` instance.
 *
 * ### Disposal
 *
 * `dispose()` is idempotent. It owns no external resource — the
 * `console` global is process-scoped — so disposal merely sets an
 * internal flag that causes subsequent `admits` calls to return
 * `false`. This matches the `LogSink` contract documented in
 * `./types.ts` (a sink only detaches its own
 * subscription; it does not dispose externally-owned resources).
 */

import { formatRecord } from '../render';
import type { LogLevel, LogRecord, LogSink } from './types';
import { SINK_NAME_CONSOLE } from './types';
import type { LogLevelResolver } from '../levels';

/**
 * Frozen mapping from record `LogLevel` to the `console` method name
 * the sink invokes. The only non-identity entry is `trace`, which
 * maps to `console.debug` (the `console`
 * global has a `trace` method but it prepends a stack trace, which is
 * not what we want here).
 *
 * The codomain is the discriminated subset of `console`'s method names
 * the Logger ever invokes; narrowing it makes the dispatch in `emit`
 * a typed indexed access rather than an arbitrary key lookup.
 */
const LEVEL_TO_CONSOLE_METHOD: Readonly<Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'>> =
  Object.freeze({
    trace: 'debug',
    debug: 'debug',
    info: 'info',
    warn: 'warn',
    error: 'error',
  });

/**
 * Developer-only console mirror sink. Construct with the same
 * `LogLevelResolver` instance the `OutputChannelSink` is using so the
 * two sinks share threshold and console-enabled state.
 */
export class ConsoleSink implements LogSink {
  readonly name = SINK_NAME_CONSOLE;

  private _disposed = false;

  constructor(private readonly resolver: LogLevelResolver) {}

  /**
   * Returns `true` iff:
   *
   * 1. the sink has not been disposed,
   * 2. `intellig.log.console` is `true` (resolver flag), AND
   * 3. the configured threshold admits the record's level.
   *
   * The Logger short-circuits before allocation when no sink would
   * admit; this `admits` is therefore the gate that lets a disabled
   * console mirror skip the `formatRecord` cost entirely.
   */
  admits(record: LogRecord): boolean {
    if (this._disposed) {
      return false;
    }
    if (!this.resolver.consoleEnabled) {
      return false;
    }
    return this.resolver.admits(record.level);
  }

  /**
   * Render `record` through the same `formatRecord` the OutputChannel
   * sink uses, then forward the rendered block to `console[level]`
   * (with `trace` → `console.debug`).
   *
   * The Logger only calls `emit` after `admits(record)` has returned
   * `true`, so this method intentionally does not re-check the
   * threshold. A defensive disposed-check is preserved in case a sink
   * reference is held outside the Logger's registration table.
   *
   * The single `console[method]` call below is the ONE production
   * reference to `console.*` allowlisted by the structural guard
   * `scripts/check-no-bare-console.sh`. Do not add additional
   * `console` calls to this file.
   */
  emit(record: LogRecord): void {
    if (this._disposed) {
      return;
    }
    const rendered = formatRecord(record);
    const method = LEVEL_TO_CONSOLE_METHOD[record.level];
    // The explicit, sanctioned console mirror. See file-level JSDoc.
    // eslint-disable-next-line no-console
    console[method](rendered);
  }

  /**
   * Idempotent teardown. Marks the sink as disposed so subsequent
   * `admits` calls return `false`; no external resource to release
   * (the `console` global is process-scoped and not owned by this
   * sink).
   */
  dispose(): void {
    this._disposed = true;
  }
}
