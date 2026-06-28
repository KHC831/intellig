/**
 * Staleness guard for concurrent async graph loads.
 *
 * When the user switches repos or changes a filter quickly, multiple loads
 * can be in-flight at once. The guard assigns each load a generation number
 * at start-time; only the load whose generation is still the latest may
 * call `updateLogState`. An older load that resolves last is silently
 * discarded — the newer result stands.
 *
 * These specs pin three properties:
 *   - bump() strictly increments the generation counter;
 *   - isCurrent() returns true iff no newer load has started;
 *   - two concurrent async loads: the older one that resolves LAST
 *     is detected as stale and does NOT write to the render target.
 */

import '../../setup';
import * as assert from 'assert';
import { createStalenessGuard } from '../../../src/registration/stalenessGuard';

describe('createStalenessGuard', () => {
  it('starts at generation 0 (nothing current yet — bump before checking)', () => {
    const guard = createStalenessGuard();
    // Before any load has bumped, generation 0 is not yet active.
    // isCurrent(0) returns true because nothing has started yet (0 === 0).
    // The first bump() lifts the current generation to 1.
    assert.strictEqual(guard.isCurrent(0), true);
    guard.bump();
    assert.strictEqual(guard.isCurrent(0), false, 'generation 0 is now stale');
    assert.strictEqual(guard.isCurrent(1), true, 'generation 1 is current');
  });

  it('bump() increments and returns the new generation', () => {
    const guard = createStalenessGuard();
    assert.strictEqual(guard.bump(), 1);
    assert.strictEqual(guard.bump(), 2);
    assert.strictEqual(guard.bump(), 3);
  });

  it('isCurrent() returns false once a newer load has bumped the counter', () => {
    const guard = createStalenessGuard();
    const gen1 = guard.bump(); // load 1 starts
    const gen2 = guard.bump(); // load 2 starts — load 1 is now stale
    assert.strictEqual(guard.isCurrent(gen1), false, 'older generation is stale');
    assert.strictEqual(guard.isCurrent(gen2), true, 'latest generation is current');
  });

  it('older load that resolves last is discarded; newer result stands', async () => {
    const guard = createStalenessGuard();
    const rendered: number[] = [];

    async function simulateLoad(delayMs: number): Promise<void> {
      const myGeneration = guard.bump();
      await new Promise<void>((r) => setTimeout(r, delayMs));
      // The guard checked before the render:
      if (!guard.isCurrent(myGeneration)) {
        return; // stale — discard
      }
      rendered.push(myGeneration);
    }

    // Load 1 starts first but is SLOWER (20ms); load 2 starts second and is faster (5ms).
    // When load 2 bumps the counter, load 1's generation is already stale.
    const p1 = simulateLoad(20); // gen=1, slow
    const p2 = simulateLoad(5); //  gen=2, fast — renders first, gen=2 is still current
    await Promise.all([p1, p2]);

    // gen=2 finishes first → isCurrent(2) is true → renders.
    // gen=1 finishes last → isCurrent(1) is false (current=2) → discarded.
    assert.deepStrictEqual(
      rendered,
      [2],
      'only the newest load renders; stale slow load is discarded'
    );
  });

  it('all loads are discarded when a very rapid sequence only lets the last one render', async () => {
    const guard = createStalenessGuard();
    const rendered: number[] = [];

    async function load(delayMs: number) {
      const gen = guard.bump();
      await new Promise<void>((r) => setTimeout(r, delayMs));
      if (!guard.isCurrent(gen)) {
        return;
      }
      rendered.push(gen);
    }

    // Rapid sequence of loads; only the last (gen=4, delay=1ms) wins.
    await Promise.all([load(30), load(25), load(20), load(1)]);

    assert.deepStrictEqual(rendered, [4], 'only the last load in a rapid sequence renders');
  });

  it('independent guards do not interfere with each other', () => {
    const guardA = createStalenessGuard();
    const guardB = createStalenessGuard();
    const genA1 = guardA.bump();
    const genB1 = guardB.bump();
    guardA.bump(); // A moves on; B stays at gen 1
    assert.strictEqual(guardA.isCurrent(genA1), false, 'A: first gen is stale');
    assert.strictEqual(guardB.isCurrent(genB1), true, 'B: unaffected by A bumping');
  });
});
