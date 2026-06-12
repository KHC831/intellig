/**
 * Public barrel for the structured Logger module.
 *
 * This file is the single import surface for every consumer outside
 * `src/utils/logger/`. Components, services, command handlers, and the
 * `safeFireAndForget` helper all import from here:
 *
 * ```ts
 * import { getLogger, registerLoggedCommand } from '../utils/logger';
 * import type { Logger, LogRecord } from '../utils/logger';
 * ```
 *
 * Importing directly from internal files (e.g. `./logger`,
 * `./correlation`, `./sinks/types`) is allowed within the module
 * itself but discouraged elsewhere — the barrel is what stays stable
 * across the topical-source-tree restructure and across
 * any future internal reorganization of the Logger's pieces.
 *
 * ### Surface (per design.md → "Logger module location")
 *
 * Lifecycle accessors:
 *   - `getLogger()` — lazy singleton accessor.
 *   - `initLogger(context)` — registers sinks and the configuration
 *     listener against `context.subscriptions`.
 *   - `__resetLoggerForTest()` — test-only seam.
 *     Production references are forbidden by the structural CI guard
 *     `scripts/check-test-only-surface.sh`.
 *
 * Correlation-id helpers:
 *   - `registerLoggedCommand(id, handler)` — wrap
 *     `vscode.commands.registerCommand` with a fresh correlation
 *     frame.
 *   - `getCurrentCorrelationId()` / `getCurrentCommandId()` — read
 *     the current frame, returning `undefined` when no frame is on
 *     the stack.
 *
 * Types:
 *   - `Logger`, `Bindings` — the public Logger surface and the shape
 *     accepted by `child(bindings)` and per-call `context`.
 *   - `LogRecord`, `LogSink` — the consumer-side record shape and
 *     sink contract.
 *   - `LogLevel`, `LogThreshold` — the five record severities and
 *     the configurable threshold superset (`LogLevel | 'off'`).
 */

export { getLogger, initLogger, __resetLoggerForTest } from './logger';
export type { Logger, Bindings } from './logger';

export { registerLoggedCommand, getCurrentCorrelationId, getCurrentCommandId } from './correlation';

export type { LogLevel, LogThreshold } from './levels';

export type { LogRecord, LogSink } from './sinks/types';
