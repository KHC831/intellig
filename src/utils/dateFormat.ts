/**
 * Commit-date formatting for the Git tool window.
 *
 * The commit-row date column shows a LOCALE-AWARE ABSOLUTE timestamp
 * (date + time, no seconds), matching IntelliJ's log — which shows an
 * absolute date/time, not a relative distance.
 *
 * Why absolute, not relative ("2h", "yesterday"):
 *   1. Parity — IntelliJ does not show relative labels in the log.
 *   2. Correctness — the label is baked into the static row HTML at
 *      render time. A relative label captures `now` once and then goes
 *      stale: a "5m" row still reads "5m" an hour later because nothing
 *      re-renders the row on a clock tick. An absolute timestamp can
 *      never go out of date.
 *
 * The inline label omits seconds (the column stays compact); the tooltip
 * always carries the full `toLocaleString()` precision (with seconds) so
 * the exact instant is one hover away.
 *
 * This is a pure function: it reads no module state and takes the date
 * by argument, so it is unit-testable without clock mocking.
 */

/** Result of {@link formatCommitDate}: the inline label + the hover tooltip. */
export interface IFormattedCommitDate {
  /** Short label rendered inline in the commit row's date column. */
  display: string;
  /** Full-precision string for the `title=` tooltip (hover reveal). */
  tooltip: string;
}

/**
 * Cached formatter for the inline absolute label. `Intl.DateTimeFormat`
 * construction is relatively expensive and the log can render hundreds
 * of rows per refresh, so the formatter is built once and reused.
 *
 * `undefined` locale honours the host's locale/region; seconds are
 * intentionally omitted from the inline label (they live in the tooltip).
 */
const DISPLAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Format a commit date as a locale-aware absolute timestamp.
 *
 * @param date - The commit's author (or commit) date.
 * @returns The inline `display` label and the full-precision `tooltip`.
 */
export function formatCommitDate(date: Date): IFormattedCommitDate {
  return {
    display: DISPLAY_FORMATTER.format(date),
    tooltip: date.toLocaleString(),
  };
}
