/**
 * Commit-date formatting for the Git tool window.
 *
 * IntelliJ shows a relative timestamp for recent commits ("5m", "2h",
 * "yesterday", "3d") and an absolute date for older ones ("Mar 17
 * 2026"). The 7-day boundary matches IntelliJ's "Last week" cut: under
 * a week reads as a relative distance the user can reason about at a
 * glance; beyond that the absolute calendar date is more useful than
 * "29 days ago".
 *
 * The tooltip always carries the full `toLocaleString()` precision so
 * the exact timestamp is one hover away regardless of which form the
 * inline label takes.
 *
 * This is a pure function (the `now` parameter is injectable) so it can
 * be unit-tested without clock mocking.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const RELATIVE_CUTOFF_MS = 7 * MS_PER_DAY;

/** Result of {@link formatCommitDate}: the inline label + the hover tooltip. */
export interface IFormattedCommitDate {
  /** Short label rendered inline in the commit row's date column. */
  display: string;
  /** Full-precision string for the `title=` tooltip (hover reveal). */
  tooltip: string;
}

/**
 * Cached part formatters for the absolute date form. `Intl.DateTimeFormat`
 * construction is relatively expensive; the log can render hundreds of
 * rows per refresh, so we build the formatters once and reuse them.
 *
 * We format the month name on its own and assemble "MMM dd yyyy" by hand
 * (e.g. "Mar 17 2026") rather than letting the locale join the parts —
 * en-US's default join inserts a comma ("Mar 17, 2026"), which we don't
 * want. Building the string ourselves keeps the output deterministic and
 * comma-free across locales. `day` is zero-padded to two digits so the
 * column width stays stable and the date column doesn't jitter.
 */
const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', { month: 'short' });

function formatAbsolute(date: Date): string {
  const month = MONTH_FORMATTER.format(date);
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month} ${day} ${year}`;
}

/**
 * Format a commit date as an IntelliJ-style relative-or-absolute label.
 *
 * @param date - The commit's author (or commit) date.
 * @param now  - The reference "current" time. Injectable for tests;
 *               defaults to `new Date()`.
 * @returns The inline `display` label and the full-precision `tooltip`.
 */
export function formatCommitDate(date: Date, now: Date = new Date()): IFormattedCommitDate {
  const tooltip = date.toLocaleString();
  const deltaMs = now.getTime() - date.getTime();

  // Future-dated commits (clock skew, rebased committerDate ahead of the
  // local clock) fall back to the absolute form — a negative relative
  // label ("-3m") would be nonsense.
  if (deltaMs < 0 || deltaMs >= RELATIVE_CUTOFF_MS) {
    return { display: formatAbsolute(date), tooltip };
  }

  if (deltaMs < MS_PER_MINUTE) {
    return { display: 'now', tooltip };
  }
  if (deltaMs < MS_PER_HOUR) {
    const minutes = Math.floor(deltaMs / MS_PER_MINUTE);
    return { display: `${minutes}m`, tooltip };
  }
  if (deltaMs < MS_PER_DAY) {
    const hours = Math.floor(deltaMs / MS_PER_HOUR);
    return { display: `${hours}h`, tooltip };
  }

  const days = Math.floor(deltaMs / MS_PER_DAY);
  if (days === 1) {
    return { display: 'yesterday', tooltip };
  }
  return { display: `${days}d`, tooltip };
}
