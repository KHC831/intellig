/**
 * Persisted numeric state must be validated to the shape its consumer needs.
 *
 * A hand-edited `minParents: -1` or `2.5` survived readNumber and reached
 * `git log --min-parents=-1`, which errors on EVERY log load until the filter
 * is cleared — the storage layer's stated contract is that a soured value
 * degrades to the default, never breaks the log.
 *
 * mapWithLimit's concurrency floor is the same shape: `limit < 1` spawned zero
 * runners, so it resolved an array of holes and reported success.
 */

import '../../setup';
import * as assert from 'assert';
import { readNonNegativeInteger } from '../../../src/utils/persistedState';
import { mapWithLimit } from '../../../src/utils/mapWithLimit';

describe('readNonNegativeInteger', () => {
  it('accepts zero and positive integers', () => {
    assert.strictEqual(readNonNegativeInteger(0), 0);
    assert.strictEqual(readNonNegativeInteger(3), 3);
  });

  it('rejects negatives', () => {
    assert.strictEqual(readNonNegativeInteger(-1), undefined);
  });

  it('rejects non-integers', () => {
    assert.strictEqual(readNonNegativeInteger(2.5), undefined);
  });

  it('rejects non-finite and non-numeric values', () => {
    assert.strictEqual(readNonNegativeInteger(Number.NaN), undefined);
    assert.strictEqual(readNonNegativeInteger(Number.POSITIVE_INFINITY), undefined);
    assert.strictEqual(readNonNegativeInteger('3'), undefined);
    assert.strictEqual(readNonNegativeInteger(undefined), undefined);
  });
});

describe('mapWithLimit concurrency floor', () => {
  it('still processes every item when the limit is below one', async () => {
    const result = await mapWithLimit([1, 2, 3], 0, async (n) => n * 2);

    assert.deepStrictEqual(result, [2, 4, 6], 'a degenerate limit must not silently drop work');
  });

  it('handles a negative limit', async () => {
    const result = await mapWithLimit([1, 2], -5, async (n) => n + 1);

    assert.deepStrictEqual(result, [2, 3]);
  });

  it('still processes every item when the limit is not a number', async () => {
    const result = await mapWithLimit([1, 2, 3], Number.NaN, async (n) => n * 2);

    assert.deepStrictEqual(result, [2, 4, 6], 'NaN must not collapse to zero runners');
  });

  it('still processes every item when the limit is undefined', async () => {
    const result = await mapWithLimit([1, 2], undefined as unknown as number, async (n) => n + 1);

    assert.deepStrictEqual(result, [2, 3]);
  });

  it('is unchanged for a normal limit', async () => {
    const result = await mapWithLimit([1, 2, 3, 4], 2, async (n) => n * 10);

    assert.deepStrictEqual(result, [10, 20, 30, 40]);
  });
});
