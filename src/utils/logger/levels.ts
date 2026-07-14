/**
 * Log levels, threshold ordering, and the level-resolver state for the
 * structured Logger.
 *
 * This module owns:
 *
 * - The `LogLevel` / `LogThreshold` type pair. `LogLevel` is re-exported
 *   from `./sinks/types` so the sink-side and resolver-side types
 *   remain a single source of truth.
 * - The readonly `LEVEL_RANK` table (`trace=0` … `off=5`) used by every
 *   threshold comparison in the Logger hot path.
 * - The `LogLevelResolver` class that caches the configured threshold
 *   and the developer-console mirror flag, and re-reads them from the
 *   typed config seam (`readConfig`) on demand.
 *
 * The resolver does NOT emit log records itself (it has no Logger
 * reference and no sinks). Instead, when an invalid `intellig.log.level`
 * string is observed, `refresh()` returns the offending value the
 * *first* time it's seen so the caller (the Logger lifecycle) can
 * emit the section 2.5 fallback warn record exactly once per Logger
 * instance lifetime. The internal `invalidLevelWarned` set provides
 * the de-duplication, so a user repeatedly saving a typo'd setting
 * does not flood the channel.
 *
 * ### Bootstrap order rationale
 *
 * The resolver reads the config seam (`readConfig`) directly rather
 * than going through `ConfigurationService`. This avoids a bootstrap circular:
 * `ConfigurationService` is constructed by `ExtensionServices`, which
 * runs *after* `initLogger(context)` so the Logger can be ready for
 * service constructors that emit their first record during their own
 * construction.
 *
 * @see {@link LogLevelResolver}
 */

import { readConfig } from '../../config/configKeys';

import type { LogLevel } from './sinks/types';

export type { LogLevel };

/**
 * Configurable severity threshold. Records at strictly lower levels
 * are dropped before allocation.
 *
 * `'off'` is a *threshold* value only — a record itself can never
 * carry `'off'` as its level. When the threshold is `'off'`, the
 * resolver admits no records.
 */
export type LogThreshold = LogLevel | 'off';

/**
 * Total order over `LogThreshold`: `trace < debug < info < warn <
 * error < off`. A record at level `L` is admitted by a threshold `T`
 * iff `LEVEL_RANK[L] >= LEVEL_RANK[T]` AND `L !== 'off'` (which the
 * type system already prevents).
 *
 * Frozen at module-init so consumers can rely on the table's
 * structural identity in tests.
 */
export const LEVEL_RANK: Readonly<Record<LogThreshold, number>> = Object.freeze({
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  off: 5,
});

/**
 * The six valid threshold strings, as a `Set` for O(1) validation
 * inside `refresh()`. Kept private because the public surface is the
 * `LogThreshold` type alias plus `LEVEL_RANK` keys.
 */
const VALID_THRESHOLDS: ReadonlySet<string> = new Set<LogThreshold>([
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'off',
]);

/**
 * Default threshold when the configured value is missing or invalid.
 * The configured default is `"info"`; invalid values also fall back
 * to `"info"`.
 */
const DEFAULT_THRESHOLD: LogThreshold = 'info';

/**
 * Caches the `intellig.log.level` threshold and `intellig.log.console`
 * mirror flag for the structured Logger. The resolver is owned by the
 * Logger module and refreshed on every
 * `vscode.workspace.onDidChangeConfiguration` event whose
 * `affectsConfiguration` matches the IntelliG section.
 *
 * The resolver is intentionally separable from the Logger class so it
 * can be unit-tested in isolation against the stubbed
 * `vscode.workspace` from `src/test/mocks/vscode.ts`.
 *
 * #### State
 *
 * | Field | Type | Purpose |
 * |---|---|---|
 * | `threshold` | `LogThreshold` | Cached effective threshold; updated on `refresh()`. |
 * | `consoleEnabled` | `boolean` | Cached `intellig.log.console`; updated on `refresh()`. |
 * | `invalidLevelWarned` | `Set<string>` | De-dup the section 2.5 fallback warning per invalid value. |
 *
 * #### Validation
 *
 * `refresh()` validates the configured `intellig.log.level` against
 * the six-string enum. On mismatch (any non-string, or any string
 * outside the enum), the resolver:
 *
 * 1. Sets the cached threshold to `'info'`.
 * 2. Records the offending value in `invalidLevelWarned` if not
 *    already present, and returns it from `refresh()` so the Logger
 *    can emit one warn-level record naming the sanitized value.
 *
 * Subsequent `refresh()` calls that see the same invalid value
 * return `undefined` — the Logger does not warn again until the user
 * either fixes the setting or types a *different* invalid value.
 */
export class LogLevelResolver {
  private _threshold: LogThreshold = DEFAULT_THRESHOLD;
  private _consoleEnabled = false;
  private readonly _invalidLevelWarned = new Set<string>();

  /**
   * The currently effective threshold. The Logger's hot-path level
   * check reads this getter. Defaults to `'info'` until `refresh()`
   * is called for the first time.
   */
  get threshold(): LogThreshold {
    return this._threshold;
  }

  /**
   * `true` iff `intellig.log.console` is the boolean `true`. The
   * `ConsoleSink` consults this to decide whether to mirror records
   * to `console[level]`.
   */
  get consoleEnabled(): boolean {
    return this._consoleEnabled;
  }

  /**
   * Re-read `intellig.log.level` and `intellig.log.console` from the typed
   * config seam (`readConfig`) and refresh the cached state.
   *
   * Returns the offending invalid level string the **first** time it
   * is observed (per Logger instance lifetime), so the caller can
   * emit the section 2.5 fallback warn record exactly once for that value.
   * Returns `undefined` when:
   *
   * - the configured value is one of the six valid enum strings, or
   * - the configured value is invalid but matches a previously-warned
   *   invalid value (already in `invalidLevelWarned`).
   *
   * Non-string invalid values (e.g. a misconfigured `null` or number)
   * are coerced to a stable string key for de-dup purposes via
   * `JSON.stringify`; the Logger sanitizes the returned value before
   * embedding it in a record.
   *
   * @returns the invalid level string to warn about, or `undefined`.
   */
  refresh(): string | undefined {
    // Read through the config seam but keep the values loose: this resolver
    // runs pre-getLogger and validates the raw setting itself, so it must not
    // trust the typed union.
    const rawLevel: unknown = readConfig('log.level');
    const rawConsole: unknown = readConfig('log.console');

    let invalidToWarn: string | undefined;
    if (typeof rawLevel === 'string' && VALID_THRESHOLDS.has(rawLevel)) {
      this._threshold = rawLevel as LogThreshold;
    } else if (rawLevel === undefined) {
      // Setting absent: use the default. Not an invalid value.
      this._threshold = DEFAULT_THRESHOLD;
    } else {
      this._threshold = DEFAULT_THRESHOLD;
      const invalidKey = typeof rawLevel === 'string' ? rawLevel : JSON.stringify(rawLevel);
      if (!this._invalidLevelWarned.has(invalidKey)) {
        this._invalidLevelWarned.add(invalidKey);
        invalidToWarn = invalidKey;
      }
    }

    // intellig.log.console: strict-equality with true so any non-true
    // value (undefined/missing, null, non-boolean) reads as disabled.
    this._consoleEnabled = rawConsole === true;

    return invalidToWarn;
  }

  /**
   * Returns `true` if a record at `level` is admitted by the current
   * threshold. The check is a single numeric comparison — see the
   * Logger hot-path note.
   *
   * A record at any level is rejected when the threshold is `'off'`
   * because `LEVEL_RANK['off']` is the maximum (5) and no
   * `LogLevel` rank exceeds 4.
   */
  admits(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this._threshold];
  }

  /**
   * Test seam: drop the cached threshold, console flag, and the
   * `invalidLevelWarned` de-dup set. Called from
   * `__resetLoggerForTest()` so each test starts from a clean
   * resolver state. Idempotent.
   */
  reset(): void {
    this._threshold = DEFAULT_THRESHOLD;
    this._consoleEnabled = false;
    this._invalidLevelWarned.clear();
  }
}
