/**
 * `logger.ts` — the structured `Logger` facade for the IntelliG extension.
 *
 * This module owns:
 *
 * - The `Logger` class: a passive facade exposing the level methods
 *   (`trace`/`debug`/`info`/`warn`/`error`) and `child(bindings)` for
 *   accumulating structured fields across descendants.
 * - Module-level singleton state: the shared `LogLevelResolver`, the
 *   list of registered `LogSink` instances, the
 *   `vscode.workspace.onDidChangeConfiguration` listener disposable,
 *   and the lazy root `Logger` reference.
 * - The lifecycle accessors `getLogger()`, `initLogger(context)`, and
 *   `__resetLoggerForTest()`.
 *
 * ### Hot-path discipline
 *
 * The Logger short-circuits BEFORE any record allocation when the
 * configured threshold rejects the record's level. Sanitization,
 * timestamp construction, and context merging only happen for admitted
 * records. At `intellig.log.level = "off"` the per-call cost is one
 * numeric comparison plus the level-method's own call overhead.
 *
 * ### Emission flow
 *
 * 1. Resolver-level admits-check — short-circuit on miss.
 * 2. Build the record: timestamp (`new Date().toISOString()`),
 *    effective component, merged context (inherited bindings →
 *    per-call context, per-call wins), correlation id (per-call >
 *    inherited > `_readCorrelationStore()`), optional error split.
 * 3. Pass the record through `sanitizeRecord`. On failure,
 *    fall back to a fixed-content warn record.
 * 4. Multicast the (sanitized) record to every registered sink whose
 *    `admits` returns `true`. Catch per-sink `emit` throws; emit a
 *    separate warn naming the failing sink (recursion-guarded).
 *
 * ### Bindings inheritance
 *
 * `child(bindings)` returns a fresh `Logger` whose internal state is
 * built non-destructively: parent state is **not** mutated, and the
 * caller's `bindings` object is never written through. Inherited
 * bindings are shallow-merged with per-call `context`, with per-call
 * keys winning. The `component` and `correlationId` keys are
 * special-cased onto top-level `LogRecord` fields; every other key
 * lands inside `LogRecord.context`.
 *
 * ### Correlation read at emit time
 *
 * `child(bindings)` does NOT read the correlation store. The store is
 * read at *emit time* so a child Logger constructed inside one
 * command frame and called inside another correctly attributes
 * records to the *current* frame. An explicit `correlationId` in
 * `bindings` (or in the per-call context) overrides the store read.
 */

import * as vscode from 'vscode';

import { _readCorrelationStore } from './correlation';
import { LogLevelResolver } from './levels';
import { sanitizeRecord } from './sanitize';
import { ConsoleSink } from './sinks/ConsoleSink';
import { OutputChannelSink } from './sinks/OutputChannelSink';
import type { JsonValue, LogLevel, LogRecord, LogSink } from './sinks/types';

/**
 * Public binding shape for `Logger.child(bindings)` and the per-call
 * `context` argument.
 *
 * Two keys are special-cased onto top-level `LogRecord` fields:
 *
 * - `component`: rebinds the rendered component name. Most-recent
 *   `child(...)` call wins.
 * - `correlationId`: overrides the `AsyncLocalStorage` read at emit
 *   time. Rarely used in production.
 *
 * Every other string-keyed entry is merged into `LogRecord.context`.
 * Values are restricted to JSON-serializable types so the sanitizer's
 * walker has a closed value-space to traverse.
 *
 * `Symbol`-keyed entries (if any sneak in via `as` casts) are dropped
 * silently by the sanitizer's `Object.keys` traversal — consistent
 * with `JSON.stringify` semantics.
 */
export interface Bindings {
  readonly component?: string;
  readonly correlationId?: string;
  readonly [key: string]: JsonValue | undefined;
}

/**
 * Public Logger surface. Created via `getLogger()` (root instance) or
 * `child(bindings)` (descendant instances).
 *
 * The `error` method has the documented overload: the second argument
 * may be either a `Bindings` context bag OR an `Error` (shorthand for
 * `error(message, undefined, err)`).
 */
export interface Logger {
  trace(message: string, context?: Bindings): void;
  debug(message: string, context?: Bindings): void;
  info(message: string, context?: Bindings): void;
  warn(message: string, context?: Bindings): void;
  error(message: string, contextOrError?: Bindings | Error, errorArg?: Error): void;
  child(bindings: Bindings): Logger;
}

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

/**
 * Shared resolver. Lazily constructed on first `getLogger()` call so
 * tests that drive the Logger before VS Code activation runs (or
 * outside the activation context altogether) still work — the
 * resolver's defaults (`'info'` / `false`) are safe.
 */
let _resolver: LogLevelResolver | undefined;

/**
 * Currently-registered sinks. The Logger multicasts every emitted
 * record to every entry whose `admits` returns `true` (Requirement
 * 1.7). Populated by `initLogger(context)`; cleared by
 * `__resetLoggerForTest()`.
 */
const _sinks: LogSink[] = [];

/**
 * Cached root Logger. Returned by `getLogger()`. The cache is dropped
 * by `__resetLoggerForTest()` so every test starts from a fresh root.
 */
let _rootLogger: LoggerImpl | undefined;

/**
 * Disposable for the `vscode.workspace.onDidChangeConfiguration`
 * listener registered by `initLogger`. Held module-level so
 * `__resetLoggerForTest()` can detach the listener even when the
 * production `context.subscriptions` array is no longer in scope.
 */
let _configListenerDisposable: vscode.Disposable | undefined;

/**
 * Idempotency guard for `initLogger(context)`. Set true after a
 * successful first init; reset to false by `__resetLoggerForTest()`
 * so a fresh `ExtensionContext` stub can re-register cleanly.
 */
let _initialized = false;

/**
 * Recursion guard for the per-sink-failure warning emit path. When a
 * sink throws inside `emit()` the Logger emits a warn record naming
 * the failing sink; if that warn record also lands a sink that
 * throws, we MUST NOT recurse forever. The guard is module-scoped
 * (rather than per-instance) because failure reporting walks the
 * shared `_sinks` array.
 */
let _reportingFailure = false;

// ---------------------------------------------------------------------------
// Logger implementation
// ---------------------------------------------------------------------------

/**
 * Internal Logger implementation. Held by `_rootLogger` and returned
 * (as the `Logger` interface) from `getLogger()` and
 * `Logger.child(...)`. Each instance captures only its own effective
 * state — no parent reference is retained, so a child can outlive its
 * parent without resource leaks.
 *
 * Captured state per instance:
 *
 * - `_component`: the most-recently-bound component name, or `'root'`.
 * - `_inheritedContext`: shallow-merged map of every non-special
 *   binding key from the chain of ancestor `child(...)` calls.
 * - `_correlationOverride`: the explicit `correlationId` binding from
 *   any ancestor `child(...)` call, or `undefined` to defer to the
 *   `AsyncLocalStorage` store at emit time.
 *
 * The implementation accesses module-level `_resolver` and `_sinks`
 * directly at emit time so configuration / sink-registration changes
 * take effect without re-walking the tree of children.
 */
class LoggerImpl implements Logger {
  private readonly _component: string;
  private readonly _inheritedContext: Readonly<Record<string, JsonValue>>;
  private readonly _correlationOverride: string | undefined;

  constructor(
    component: string,
    inheritedContext: Readonly<Record<string, JsonValue>>,
    correlationOverride: string | undefined
  ) {
    this._component = component;
    this._inheritedContext = inheritedContext;
    this._correlationOverride = correlationOverride;
  }

  trace(message: string, context?: Bindings): void {
    this._emit('trace', message, context, undefined);
  }

  debug(message: string, context?: Bindings): void {
    this._emit('debug', message, context, undefined);
  }

  info(message: string, context?: Bindings): void {
    this._emit('info', message, context, undefined);
  }

  warn(message: string, context?: Bindings): void {
    this._emit('warn', message, context, undefined);
  }

  /**
   * Error-level emission with the documented overload. When the
   * second argument is an `Error`, callers writing the common
   * shorthand `logger.error('failed', err)` get the right behaviour
   * without having to spell out the third positional. When the
   * second argument is a `Bindings` bag (or `undefined`), the third
   * argument is the optional `Error`.
   *
   * `instanceof Error` is the discriminator — robust across realm
   * boundaries on the same Node process (the `Error` class identity
   * is shared) and matches the convention used elsewhere in the
   * codebase (e.g. `safeFireAndForget`).
   */
  error(message: string, contextOrError?: Bindings | Error, errorArg?: Error): void {
    if (contextOrError instanceof Error) {
      this._emit('error', message, undefined, contextOrError);
    } else {
      this._emit('error', message, contextOrError, errorArg);
    }
  }

  /**
   * Build a new `Logger` whose state is the parent state shallow-
   * merged with `bindings`. Parent state is **not** mutated; the
   * caller's `bindings` object is **not** mutated.
   *
   * Resolution rules:
   * - `component`: per-call wins, falls back to inherited, then to
   *   `'root'` (already encoded in the parent's `_component` field).
   * - `correlationId`: per-call wins, falls back to inherited
   *   override; absent in both → defer to the correlation store at
   *   emit time.
   * - every other key: shallow-merge into `_inheritedContext`,
   *   per-call wins on conflict.
   */
  child(bindings: Bindings): Logger {
    // Resolve component (most-recent-wins).
    const newComponent =
      typeof bindings.component === 'string' ? bindings.component : this._component;

    // Resolve correlation override.
    const newCorrelationOverride =
      typeof bindings.correlationId === 'string'
        ? bindings.correlationId
        : this._correlationOverride;

    // Merge non-special bindings into the inherited context. Build a
    // mutable map first, then freeze the structural shape via
    // `Readonly<...>` for the field type.
    const merged: Record<string, JsonValue> = { ...this._inheritedContext };
    for (const key of Object.keys(bindings)) {
      if (key === 'component' || key === 'correlationId') {
        continue;
      }
      const value = bindings[key];
      // Drop `undefined` so explicit `key: undefined` in `bindings`
      // does not clobber an inherited value via JSON-walker rules.
      // This matches the JSON-serializable contract documented on
      // `Bindings`.
      if (value === undefined) {
        continue;
      }
      merged[key] = value;
    }

    return new LoggerImpl(newComponent, merged, newCorrelationOverride);
  }

  /**
   * Single emission entry-point. The first action is the hot-path
   * resolver check: a level-rejected call
   * exits before any allocation.
   */
  private _emit(
    level: LogLevel,
    message: string,
    context: Bindings | undefined,
    error: Error | undefined
  ): void {
    const resolver = _ensureResolver();
    if (!resolver.admits(level)) {
      return;
    }

    // Build the record. Order matters: per-call context may override
    // both `correlationId` and ordinary fields from the inherited
    // bindings.
    const record = this._buildRecord(level, message, context, error);

    // Sanitize. On failure the sanitizer returns a
    // sentinel record we forward as-is; the sanitization-failure
    // branch deliberately bypasses a second sanitize pass.
    const result = sanitizeRecord(record);
    const recordToEmit: LogRecord = result.ok ? result.record : result.record;

    _multicast(recordToEmit);
  }

  /**
   * Construct a `LogRecord` from the current Logger state and the
   * per-call arguments. The per-call `context` is applied AFTER the
   * inherited context so per-call keys win on conflict.
   *
   * Correlation id resolution:
   *   per-call.correlationId
   *     ?? this._correlationOverride
   *     ?? _readCorrelationStore()?.correlationId
   *     ?? omit
   */
  private _buildRecord(
    level: LogLevel,
    message: string,
    context: Bindings | undefined,
    error: Error | undefined
  ): LogRecord {
    const timestamp = new Date().toISOString();

    // Effective component: per-call override > captured component.
    const effectiveComponent =
      context !== undefined && typeof context.component === 'string'
        ? context.component
        : this._component;

    // Effective correlation id: per-call > inherited override > store > undefined.
    let effectiveCorrelationId: string | undefined;
    if (context !== undefined && typeof context.correlationId === 'string') {
      effectiveCorrelationId = context.correlationId;
    } else if (this._correlationOverride !== undefined) {
      effectiveCorrelationId = this._correlationOverride;
    } else {
      effectiveCorrelationId = _readCorrelationStore()?.correlationId;
    }

    // Merge inherited + per-call into the record context. Skip
    // special keys (component / correlationId) — they are top-level
    // fields, not context fields.
    const mergedContext: Record<string, JsonValue> = { ...this._inheritedContext };
    if (context !== undefined) {
      for (const key of Object.keys(context)) {
        if (key === 'component' || key === 'correlationId') {
          continue;
        }
        const value = context[key];
        if (value === undefined) {
          continue;
        }
        mergedContext[key] = value;
      }
    }
    const hasContext = Object.keys(mergedContext).length > 0;

    // Convert Error to the dedicated `error` field if present.
    // `error.message` and `error.stack` are split here; the sanitizer
    // walks both as ordinary strings.
    const errorField =
      error !== undefined
        ? error.stack !== undefined
          ? { message: error.message, stack: error.stack }
          : { message: error.message }
        : undefined;

    // Build the record with optional fields omitted (rather than set
    // to `undefined`) so deep-equality checks see the documented
    // shape.
    return {
      timestamp,
      level,
      component: effectiveComponent,
      message,
      ...(hasContext ? { context: mergedContext } : {}),
      ...(effectiveCorrelationId !== undefined ? { correlationId: effectiveCorrelationId } : {}),
      ...(errorField !== undefined ? { error: errorField } : {}),
    };
  }
}

/**
 * Lazy resolver accessor. The first call constructs the resolver and
 * runs an initial `refresh()` so the cached threshold matches the
 * current `intellig.log.*` settings even if `initLogger(context)` has
 * not been called yet (e.g. tests that drive the Logger directly).
 */
function _ensureResolver(): LogLevelResolver {
  if (_resolver === undefined) {
    _resolver = new LogLevelResolver();
    _resolver.refresh();
  }
  return _resolver;
}

/**
 * Multicast a sanitized record to every registered sink whose
 * `admits` returns `true`. Per-sink `emit` throws are caught and
 * surfaced as a separate warn record naming the failing sink
 * (recursion-guarded by `_reportingFailure`).
 */
function _multicast(record: LogRecord): void {
  // Snapshot the sink list so a sink that mutates `_sinks` mid-emit
  // (e.g. a test sink that detaches itself) does not skip a sibling.
  const sinks = _sinks.slice();
  for (const sink of sinks) {
    if (!sink.admits(record)) {
      continue;
    }
    try {
      sink.emit(record);
    } catch (cause) {
      _reportSinkFailure(sink.name, record, cause);
    }
  }
}

/**
 * Emit a warn record describing a sink-side `emit` failure. Skips the
 * failing sink so a persistently broken sink cannot keep dragging its
 * own failure reports back into itself. Guarded against recursion so
 * a second-level failure (the warn itself failing on a different
 * sink) cannot loop.
 */
function _reportSinkFailure(failingSinkName: string, original: LogRecord, _cause: unknown): void {
  if (_reportingFailure) {
    return;
  }
  _reportingFailure = true;
  try {
    // Synthesise the failure record. Hard-coded message + sink name
    // (which is a code-supplied identifier, not user input) means we
    // can skip the sanitizer here without leaking anything; routing
    // through `sanitizeRecord` would risk infinite recursion if the
    // sanitizer itself becomes the problem.
    const failureRecord: LogRecord = {
      timestamp: new Date().toISOString(),
      level: 'warn',
      component: original.component,
      message: `log sink '${failingSinkName}' failed during emit`,
    };

    for (const sink of _sinks.slice()) {
      if (sink.name === failingSinkName) {
        continue; // skip the sink that just threw
      }
      if (!sink.admits(failureRecord)) {
        continue;
      }
      try {
        sink.emit(failureRecord);
      } catch {
        // Swallow secondary failures — we have done what we can.
      }
    }
  } finally {
    _reportingFailure = false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle accessors
// ---------------------------------------------------------------------------

/**
 * Lazily construct (or return) the singleton root Logger.
 *
 * Safe to call from any code path, including before
 * `initLogger(context)` has run — the resolver's defaults (`'info'` /
 * `false`) keep emissions safely filtered, and calls land on the
 * empty `_sinks` array (no allocation past the level check). Once
 * `initLogger(context)` registers sinks, the same root Logger
 * instance starts emitting through them — no re-bind required.
 *
 * The root Logger has component `'root'`, no inherited context, and
 * no correlation override. Every other Logger in the extension
 * descends from this instance through `.child(...)` calls.
 */
export function getLogger(): Logger {
  if (_rootLogger === undefined) {
    _ensureResolver();
    _rootLogger = new LoggerImpl('root', Object.freeze({}), undefined);
  }
  return _rootLogger;
}

/**
 * Initialize the Logger against an `ExtensionContext`.
 *
 * Idempotent: a second call is a no-op (the design admits either
 * "throws or no-ops"; we choose no-op to keep test setup robust).
 *
 * On first call this function:
 *
 * 1. Ensures the shared resolver exists and runs an initial
 *    `refresh()` (reads `intellig.log.level` / `intellig.log.console`
 *    from `vscode.workspace.getConfiguration`).
 * 2. Registers a single `vscode.workspace.onDidChangeConfiguration`
 *    listener that re-runs `refresh()` when an `intellig` setting
 *    changes (within 100ms; the listener fires
 *    synchronously). The disposable is pushed onto
 *    `context.subscriptions` for VS Code teardown AND held in the
 *    module-level `_configListenerDisposable` for
 *    `__resetLoggerForTest()`.
 * 3. Constructs the two production sinks (`OutputChannelSink`,
 *    `ConsoleSink`) and registers them in `_sinks`. Both sinks share
 *    the resolver.
 * 4. If the initial `refresh()` reported an invalid
 *    `intellig.log.level` value, emits one warn-level record naming
 *    the offending value.
 */
export function initLogger(context: vscode.ExtensionContext): void {
  if (_initialized) {
    return;
  }

  const resolver = _ensureResolver();
  const initialInvalid = resolver.refresh();

  // Register sinks. Both sinks share the resolver so a single
  // `intellig.log.level` change updates both thresholds at once.
  const outputChannelSink = new OutputChannelSink(resolver);
  const consoleSink = new ConsoleSink(resolver);
  _sinks.push(outputChannelSink, consoleSink);

  // Configuration listener. We listen to the broad `intellig`
  // section because both `log.level` and `log.console` live under
  // it, and resolver.refresh() re-reads both unconditionally.
  const listenerDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration('intellig.log')) {
      return;
    }
    const invalid = resolver.refresh();
    if (invalid !== undefined) {
      getLogger().warn('invalid intellig.log.level value; falling back to info', {
        invalidValue: invalid,
      });
    }
  });

  _configListenerDisposable = listenerDisposable;
  context.subscriptions.push(listenerDisposable);
  // Register the OutputChannel sink as a disposable too so VS Code
  // detaches it on extension teardown. The underlying channel is
  // owned by `initOutputChannel(context)` (separate disposable) so
  // disposing this sink does NOT dispose the channel (Requirement
  // 3.4).
  context.subscriptions.push({ dispose: () => outputChannelSink.dispose() });
  context.subscriptions.push({ dispose: () => consoleSink.dispose() });

  _initialized = true;

  // Surface the section 2.5 fallback warn AFTER the sinks are registered so
  // the warn actually lands somewhere visible.
  if (initialInvalid !== undefined) {
    getLogger().warn('invalid intellig.log.level value; falling back to info', {
      invalidValue: initialInvalid,
    });
  }
}

/**
 * Test-only seam: drop the cached root Logger, detach every
 * registered sink, dispose the configuration listener, and clear the
 * resolver's cached state. Idempotent.
 *
 * Production code MUST NOT call this. The structural CI guard
 * `scripts/check-test-only-surface.sh` (post-rename) forbids any
 * reference outside `src/test/**`.
 *
 * @internal
 */
export function __resetLoggerForTest(): void {
  // Detach sinks first so a stray emit during teardown writes
  // nowhere. Use a snapshot loop in case `dispose()` mutates the
  // array (the production sinks do not, but tests may).
  for (const sink of _sinks.slice()) {
    try {
      sink.dispose();
    } catch {
      // Swallow — test teardown must not throw.
    }
  }
  _sinks.length = 0;

  if (_configListenerDisposable !== undefined) {
    try {
      _configListenerDisposable.dispose();
    } catch {
      // Swallow — test teardown must not throw.
    }
    _configListenerDisposable = undefined;
  }

  if (_resolver !== undefined) {
    _resolver.reset();
    _resolver = undefined;
  }

  _rootLogger = undefined;
  _initialized = false;
  _reportingFailure = false;
}
