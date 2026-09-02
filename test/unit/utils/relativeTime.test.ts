import '../../setup';
import * as assert from 'assert';
import { relativeTime } from '../../../src/utils/relativeTime';

describe('relativeTime', () => {
  const NOW = new Date('2026-06-15T12:00:00Z');
  const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  for (const [label, date, expected] of [
    ['under a minute', ago(30 * SECOND), 'just now'],
    ['one minute', ago(MINUTE), '1 minute ago'],
    ['several minutes', ago(5 * MINUTE), '5 minutes ago'],
    ['one hour', ago(HOUR), '1 hour ago'],
    ['several hours', ago(3 * HOUR), '3 hours ago'],
    ['one day', ago(DAY), '1 day ago'],
    ['several days', ago(3 * DAY), '3 days ago'],
    ['one week', ago(7 * DAY), '1 week ago'],
    ['several weeks', ago(21 * DAY), '3 weeks ago'],
    ['months', ago(90 * DAY), '3 months ago'],
  ] as const) {
    it(`renders ${label}`, () => {
      assert.strictEqual(relativeTime(date, NOW), expected);
    });
  }

  it('singularises exactly one unit and pluralises the rest', () => {
    assert.strictEqual(relativeTime(ago(2 * DAY), NOW), '2 days ago');
    assert.strictEqual(relativeTime(ago(DAY), NOW), '1 day ago');
  });

  it('reads a future date as just now rather than a negative age', () => {
    assert.strictEqual(relativeTime(new Date(NOW.getTime() + HOUR), NOW), 'just now');
  });
});
