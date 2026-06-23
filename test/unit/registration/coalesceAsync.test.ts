/**
 * Unit test for the concurrent-run coalescer behind the startup graph-load
 * de-duplication.
 *
 * Guarantees: (1) a burst of concurrent calls runs the task only ONCE while it
 * is in flight (no competing concurrent `git log --topo-order` walks); (2) the
 * runs never overlap; (3) a call arriving mid-run triggers exactly one trailing
 * re-run so a real change isn't dropped.
 */

import '../../setup';
import * as assert from 'assert';
import { createCoalescedRunner } from '../../../src/registration/coalesceAsync';

describe('createCoalescedRunner', () => {
  it('collapses a concurrent burst to a single in-flight run (+ one trailing)', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    let release!: () => void;
    let gate = new Promise<void>((r) => {
      release = r;
    });

    const run = createCoalescedRunner(async () => {
      runs += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
    });

    // Three near-simultaneous triggers (initialData + refresh + repoChange).
    const a = run();
    const b = run();
    const c = run();

    // Let the trailing run (if any) use a resolved gate so the test completes.
    const firstGate = gate;
    gate = Promise.resolve();
    release(); // release the first run
    void firstGate;
    await Promise.all([a, b, c]);
    // Allow the fire-and-forget trailing run to settle.
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(maxActive, 1, 'runs must never overlap');
    assert.strictEqual(runs, 2, 'a burst of 3 → one in-flight run + one trailing run');
  });

  it('runs again on a fresh, non-overlapping call', async () => {
    let runs = 0;
    const run = createCoalescedRunner(async () => {
      runs += 1;
    });

    await run();
    await run();

    assert.strictEqual(runs, 2, 'sequential (non-overlapping) calls each run');
  });
});
