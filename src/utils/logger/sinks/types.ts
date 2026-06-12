/**
 * `LogSink` contract — the consumer side of the structured Logger.
 *
 * A `LogSink` accepts already-sanitized `LogRecord` instances from the
 * Logger and renders them somewhere user- or developer-visible. The
 * IntelliG extension ships two sinks today (see design.md → Components
 * and Interfaces → Logger module location):
 *
 * - `'output-channel'` — backed by the shared `IntelliG`
 *   `vscode.OutputChannel` (the singleton from `src/utils/outputChannel.ts`)
 *   so users can copy logs into a bug report without enabling
 *   extension-development mode.
 * - `'console'` — developer-only mirror that fires `console[level]` when
 *   `intellig.log.console` is `true`.
 *
 * Both sinks share the threshold computed by the Logger's level
 * resolver. The Logger short-circuits before allocating a
 * `LogRecord` when no sink would admit it; even
 * so, every sink's `admits(record)` is consulted at emit time so a
 * future per-sink threshold (e.g. a test sink that only captures
 * warn/error) Just Works without changes to the Logger.
 *
 * ### Disposal contract
 *
 * `dispose()` is idempotent — calling it twice MUST NOT throw. Sinks
 * that wrap an externally-owned resource (the `OutputChannelSink`
 * borrows the channel from `initOutputChannel(context)`) MUST detach
 * their own subscription only; the underlying resource remains owned
 * by the original lifecycle owner.
 *
 * ### Scope of this file
 *
 * This file is the home of the `LogSink` interface and the two sink
 * `name` constants. The supporting `LogRecord`, `LogLevel`, and
 * `JsonValue` types are co-located here so the `LogSink` interface
 * compiles standalone before later tasks land. The logger module
 * (`src/utils/logger/logger.ts`) and the `index.ts` public barrel own
 * the final canonical export surface; this file is the source of truth
 * for the sink-side types until then.
 */

/**
 * Five record-level severities, ordered (least → most severe):
 * `trace < debug < info < warn < error`.
 *
 * The configured *threshold* may also be `'off'` (drop everything),
 * but a record itself can never be at level `'off'`. The full
 * `LogThreshold` type lives in `../levels.ts`.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * JSON-serializable value-space for `LogRecord.context` leaves. The
 * sanitizer recurses into arrays and plain objects and applies
 * `sanitizeGitError` to every string leaf.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * A single emitted log event. Fields match the OutputChannel
 * rendering grammar.
 *
 * - `timestamp`: ISO-8601 UTC string with millisecond precision.
 * - `level`: the called Logger method's name.
 * - `component`: value bound by the most recent `child(bindings)` call,
 *   or `'root'` when no child binding has been applied.
 * - `message`: the first argument verbatim, after sanitization.
 * - `context`: optional sanitized JSON-shaped bag.
 * - `correlationId`: optional 16-char hex string, present iff a
 *   command-handler frame is on the stack.
 * - `error`: optional sanitized rendering of an `Error` (message +
 *   stack); the original `Error` object never appears verbatim.
 */
export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly message: string;
  readonly context?: { readonly [key: string]: JsonValue | undefined };
  readonly correlationId?: string;
  readonly error?: {
    readonly message: string;
    readonly stack?: string;
  };
}

/**
 * A consumer of `LogRecord`s. The Logger multicasts every record it
 * emits to every currently-registered sink whose `admits` returns
 * `true`.
 *
 * Implementations:
 * - `OutputChannelSink` — the shared `IntelliG` channel.
 * - `ConsoleSink` — opt-in developer console mirror.
 * - test-only sinks may use any `name` value distinct from the two
 *   shipped names; the Logger never inspects sink names beyond
 *   identifying duplicates.
 */
export interface LogSink {
  /**
   * Stable identifier for this sink. Production sinks use one of the
   * exported `SINK_NAME_*` constants; test sinks may use any other
   * string.
   */
  readonly name: string;

  /**
   * Returns `true` if this sink's threshold admits the record. The
   * Logger only calls `emit` on sinks whose `admits` returned `true`
   * for the same record.
   */
  admits(record: LogRecord): boolean;

  /**
   * Emit one already-sanitized record. Implementations MUST NOT throw
   * for non-fatal rendering issues; the Logger catches and reports
   * sink emit errors via a separate fallback record.
   */
  emit(record: LogRecord): void;

  /**
   * Tear down the sink (e.g. detach a channel binding). Idempotent:
   * calling `dispose()` more than once MUST NOT throw. The sink does
   * NOT dispose externally-owned resources it borrows.
   */
  dispose(): void;
}

/**
 * Stable `name` for the `OutputChannelSink` shipped by the extension
 * (the user-visible `IntelliG` channel). Exposed as a constant so
 * test code and structural guards can reference the literal without
 * embedding the string.
 */
export const SINK_NAME_OUTPUT_CHANNEL = 'output-channel';

/**
 * Stable `name` for the developer-only `ConsoleSink` activated by
 * `intellig.log.console = true`.
 */
export const SINK_NAME_CONSOLE = 'console';
