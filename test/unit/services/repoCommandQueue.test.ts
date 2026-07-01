/**
 * Unit tests for the per-repo index-write serializer (Layer 1.5).
 */

import * as assert from 'assert';
import { RepoCommandQueue } from '../../../src/conflicts/repoCommandQueue';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('RepoCommandQueue', () => {
  it('runs ops for one repo strictly serially (never overlapping)', async () => {
    const q = new RepoCommandQueue();
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];

    const op = (n: number) => async (): Promise<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      await tick();
      order.push(n);
      inFlight--;
    };

    await Promise.all([q.withLock('/r', op(1)), q.withLock('/r', op(2)), q.withLock('/r', op(3))]);

    assert.strictEqual(peak, 1, 'no two ops for one repo overlap');
    assert.deepStrictEqual(order, [1, 2, 3], 'ops run in enqueue order');
  });

  it('returns each op result and rejection to its own caller', async () => {
    const q = new RepoCommandQueue();
    const ok = await q.withLock('/r', async () => 42);
    assert.strictEqual(ok, 42);
    await assert.rejects(
      q.withLock('/r', async () => {
        throw new Error('boom');
      }),
      /boom/
    );
  });

  it('does not let a failing op poison the queue for the next op', async () => {
    const q = new RepoCommandQueue();
    const results: string[] = [];
    const p1 = q
      .withLock('/r', async () => {
        throw new Error('fail');
      })
      .catch(() => results.push('caught'));
    const p2 = q.withLock('/r', async () => {
      results.push('ran-after-failure');
    });
    await Promise.all([p1, p2]);
    assert.ok(results.includes('caught'), 'the failing op rejects its own caller');
    assert.ok(
      results.includes('ran-after-failure'),
      'the next op still runs after a failure (queue not poisoned)'
    );
  });

  it('lets different repos run in parallel', async () => {
    const q = new RepoCommandQueue();
    let inFlight = 0;
    let peak = 0;
    const op = async (): Promise<void> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
    };
    await Promise.all([q.withLock('/a', op), q.withLock('/b', op)]);
    assert.strictEqual(peak, 2, 'unrelated repos are not serialized against each other');
  });
});
