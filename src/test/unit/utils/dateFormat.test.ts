/**
 * Unit tests for formatCommitDate (Phase 3).
 *
 * Pins the IntelliJ-style relative-or-absolute contract:
 *   - under 60s         -> "now"
 *   - under 60min       -> "Nm"
 *   - under 24h         -> "Nh"
 *   - exactly 1 day     -> "yesterday"
 *   - under 7 days      -> "Nd"
 *   - 7 days or older   -> absolute "MMM dd yyyy" (comma-free)
 *   - future-dated      -> absolute (no negative relative labels)
 * The tooltip is ALWAYS the full toLocaleString() precision regardless
 * of which inline form was chosen.
 *
 * `now` is injected so the tests are deterministic without clock mocking.
 */

import * as assert from 'assert';
import { formatCommitDate } from '../../../utils/dateFormat';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// A fixed reference "now" so every case is deterministic.
const NOW = new Date('2026-06-10T12:00:00.000Z');

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('formatCommitDate', () => {
  describe('relative form (under 7 days)', () => {
    it('emits "now" for under 60 seconds', () => {
      assert.strictEqual(formatCommitDate(ago(0), NOW).display, 'now');
      assert.strictEqual(formatCommitDate(ago(59 * SECOND), NOW).display, 'now');
    });

    it('emits "Nm" for under 60 minutes', () => {
      assert.strictEqual(formatCommitDate(ago(MINUTE), NOW).display, '1m');
      assert.strictEqual(formatCommitDate(ago(5 * MINUTE), NOW).display, '5m');
      assert.strictEqual(formatCommitDate(ago(59 * MINUTE), NOW).display, '59m');
    });

    it('emits "Nh" for under 24 hours', () => {
      assert.strictEqual(formatCommitDate(ago(HOUR), NOW).display, '1h');
      assert.strictEqual(formatCommitDate(ago(2 * HOUR), NOW).display, '2h');
      assert.strictEqual(formatCommitDate(ago(23 * HOUR), NOW).display, '23h');
    });

    it('emits "yesterday" for exactly 1 day', () => {
      assert.strictEqual(formatCommitDate(ago(DAY), NOW).display, 'yesterday');
      // Still "yesterday" anywhere in the 1d..<2d window.
      assert.strictEqual(formatCommitDate(ago(DAY + 5 * HOUR), NOW).display, 'yesterday');
    });

    it('emits "Nd" for 2..6 days', () => {
      assert.strictEqual(formatCommitDate(ago(2 * DAY), NOW).display, '2d');
      assert.strictEqual(formatCommitDate(ago(3 * DAY), NOW).display, '3d');
      assert.strictEqual(formatCommitDate(ago(6 * DAY), NOW).display, '6d');
    });
  });

  describe('absolute form (7 days or older)', () => {
    it('emits a comma-free "MMM dd yyyy" shape at exactly 7 days', () => {
      // The exact day depends on the runner's timezone (NOW is a UTC
      // instant; the absolute form uses local-time getDate). Pin the
      // SHAPE (comma-free "MMM DD YYYY") rather than the exact day to
      // stay timezone-robust. The exact-day cases below use explicit
      // local-time Date constructors, which are unambiguous.
      const result = formatCommitDate(ago(7 * DAY), NOW);
      assert.ok(
        /^[A-Z][a-z]{2} \d{2} \d{4}$/.test(result.display),
        `expected comma-free "MMM DD YYYY"; got "${result.display}"`
      );
      assert.ok(!result.display.includes(','), 'absolute form must be comma-free');
    });

    it('emits the absolute form for an old commit', () => {
      const result = formatCommitDate(new Date(2020, 11, 25, 0, 0, 0), NOW);
      assert.strictEqual(result.display, 'Dec 25 2020');
    });

    it('zero-pads the day to two digits', () => {
      const result = formatCommitDate(new Date(2024, 0, 1, 9, 0, 0), NOW);
      assert.strictEqual(result.display, 'Jan 01 2024');
    });

    it('carries no time-of-day component', () => {
      const result = formatCommitDate(new Date(2024, 0, 1, 14, 30, 0), NOW);
      assert.ok(
        !/AM|PM|:/.test(result.display),
        `absolute form must omit time; got ${result.display}`
      );
    });
  });

  describe('future-dated commits', () => {
    it('falls back to the absolute form rather than a negative relative label', () => {
      // committerDate ahead of the local clock (skew / rebase). A "-3m"
      // label would be nonsense.
      const future = new Date(NOW.getTime() + 3 * MINUTE);
      const result = formatCommitDate(future, NOW);
      assert.ok(!result.display.startsWith('-'), 'must not emit a negative relative label');
      // 2026-06-10 -> "Jun 10 2026".
      assert.strictEqual(result.display, 'Jun 10 2026');
    });
  });

  describe('tooltip', () => {
    it('is always the full toLocaleString() precision, regardless of inline form', () => {
      const recent = ago(5 * MINUTE);
      assert.strictEqual(formatCommitDate(recent, NOW).tooltip, recent.toLocaleString());

      const old = new Date(2020, 11, 25, 0, 0, 0);
      assert.strictEqual(formatCommitDate(old, NOW).tooltip, old.toLocaleString());
    });
  });

  describe('boundary precision', () => {
    it('treats the 24h boundary as the relative-day transition', () => {
      // Just under a day is still hours; exactly a day flips to yesterday.
      assert.strictEqual(formatCommitDate(ago(DAY - SECOND), NOW).display, '23h');
      assert.strictEqual(formatCommitDate(ago(DAY), NOW).display, 'yesterday');
    });

    it('treats the 7-day boundary as the relative/absolute transition', () => {
      // Just under 7 days is still "6d"; exactly 7 days flips to absolute.
      assert.strictEqual(formatCommitDate(ago(7 * DAY - SECOND), NOW).display, '6d');
      assert.ok(
        /\d{4}$/.test(formatCommitDate(ago(7 * DAY), NOW).display),
        'flips to absolute at 7d'
      );
    });
  });
});
