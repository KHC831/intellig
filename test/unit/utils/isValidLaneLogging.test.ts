/**
 * L-G2 — isValidLane no longer silently drops out-of-range lanes.
 *
 * A pathological window with >1000 concurrent lanes (or a corrupt index) would
 * have its edges/nodes dropped with no diagnostic. The predicate still returns
 * false (drop is the safe geometry — clamping distinct lanes onto column 1000
 * would collide them), but now logs once per session so the drop is traceable.
 */

import '../../setup';
import * as assert from 'assert';
import { isValidLane, __resetLaneWarningForTest } from '../../../src/utils/graphRenderer';
import { getOutputChannel, __resetOutputChannelForTest } from '../../../src/utils/outputChannel';

function loggedLines(): string[] {
  return (getOutputChannel() as unknown as { _lines: string[] })._lines;
}

describe('isValidLane — out-of-range diagnostics (L-G2)', () => {
  beforeEach(() => {
    __resetOutputChannelForTest();
    __resetLaneWarningForTest();
  });

  afterEach(() => {
    __resetOutputChannelForTest();
    __resetLaneWarningForTest();
  });

  it('accepts an in-range lane and logs nothing', () => {
    assert.strictEqual(isValidLane(500), true);
    assert.strictEqual(loggedLines().length, 0, 'a valid lane must not log');
  });

  it('rejects a lane above the 1000 cap and logs the offending value', () => {
    assert.strictEqual(isValidLane(1001), false);
    assert.ok(
      loggedLines().some((l) => l.includes('1001')),
      `expected a log line naming the dropped lane; got ${JSON.stringify(loggedLines())}`
    );
  });

  it('rejects a negative lane and logs it', () => {
    assert.strictEqual(isValidLane(-1), false);
    assert.ok(loggedLines().some((l) => l.includes('-1')));
  });

  it('logs at most once per session (no hot-loop spam)', () => {
    isValidLane(2000);
    isValidLane(3000);
    isValidLane(4000);
    assert.strictEqual(loggedLines().length, 1, 'repeated drops must throttle to a single log');
  });
});
