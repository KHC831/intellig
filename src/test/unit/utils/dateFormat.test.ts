/**
 * Unit tests for formatCommitDate.
 *
 * Contract (post relative-label removal): the commit-row date column
 * shows a LOCALE-AWARE ABSOLUTE timestamp — never a relative distance.
 * IntelliJ's log shows an absolute date/time, and a relative label
 * ("2h") both diverges from IntelliJ AND goes stale because it is baked
 * into static row HTML at render time with no refresh tick. Rendering an
 * absolute timestamp fixes both at once: it matches IntelliJ and can
 * never go out of date.
 *
 *   - display -> locale-aware date + time, no seconds (Intl.DateTimeFormat)
 *   - display -> NEVER a relative token ("now"/"5m"/"2h"/"yesterday"/"3d")
 *   - tooltip -> full toLocaleString() precision (the seconds live here)
 *
 * The display is asserted against a reference Intl formatter rather than
 * a hardcoded string so the suite is robust across runner locale/timezone.
 */

import * as assert from 'assert';
import { formatCommitDate } from '../../../utils/dateFormat';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// The reference shape the display MUST match: locale-aware, no seconds.
const REFERENCE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const RELATIVE_TOKENS = ['now', 'yesterday'];

function assertNotRelative(display: string): void {
  for (const token of RELATIVE_TOKENS) {
    assert.ok(
      !display.includes(token),
      `display must not contain relative token "${token}"; got "${display}"`
    );
  }
  // No bare "<n>m" / "<n>h" / "<n>d" relative distances.
  assert.ok(
    !/^\d+[mhd]$/.test(display.trim()),
    `display must not be a relative distance; got "${display}"`
  );
}

describe('formatCommitDate', () => {
  describe('always absolute (no relative labels)', () => {
    const recentOffsets: Array<[string, number]> = [
      ['30 seconds ago', 30 * SECOND],
      ['5 minutes ago', 5 * MINUTE],
      ['2 hours ago', 2 * HOUR],
      ['1 day ago', DAY],
      ['3 days ago', 3 * DAY],
    ];

    for (const [label, offset] of recentOffsets) {
      it(`renders an absolute timestamp for a commit ${label}`, () => {
        const date = new Date(Date.now() - offset);
        const { display } = formatCommitDate(date);
        assertNotRelative(display);
        assert.strictEqual(display, REFERENCE_FORMATTER.format(date));
      });
    }
  });

  describe('display shape', () => {
    it('is locale-aware date + time without seconds', () => {
      const date = new Date(2026, 5, 13, 14, 30, 45);
      const { display } = formatCommitDate(date);
      assert.strictEqual(display, REFERENCE_FORMATTER.format(date));
      // The 45-second component must not leak into the inline label.
      assert.ok(!display.includes(':45'), `display must omit seconds; got "${display}"`);
    });

    it('renders old commits in the same absolute shape (no special-casing by age)', () => {
      const old = new Date(2020, 11, 25, 9, 5, 0);
      const { display } = formatCommitDate(old);
      assert.strictEqual(display, REFERENCE_FORMATTER.format(old));
    });
  });

  describe('future-dated commits', () => {
    it('renders absolute, never a negative relative label', () => {
      const future = new Date(Date.now() + 3 * MINUTE);
      const { display } = formatCommitDate(future);
      assert.ok(!display.startsWith('-'), 'must not emit a negative relative label');
      assert.strictEqual(display, REFERENCE_FORMATTER.format(future));
    });
  });

  describe('tooltip', () => {
    it('carries full toLocaleString() precision (including seconds)', () => {
      const date = new Date(2026, 5, 13, 14, 30, 45);
      assert.strictEqual(formatCommitDate(date).tooltip, date.toLocaleString());
    });
  });
});
