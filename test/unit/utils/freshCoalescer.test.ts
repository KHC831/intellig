/**
 * FreshCoalescer: concurrent callers share runs, but no caller is ever
 * answered by a run that started before it asked. A caller that arrives while
 * a run is in flight gets the ONE follow-up run that starts once it settles.
 */

import * as assert from 'assert';
import { FreshCoalescer } from '../../../src/utils/freshCoalescer';

/** A task whose runs are numbered and released by hand. */
function gatedTask(): {
  task: () => Promise<number>;
  started: () => number;
  release: (n: number, fail?: boolean) => void;
} {
  let count = 0;
  const gates: Array<{ resolve: (v: number) => void; reject: (e: Error) => void }> = [];
  return {
    task: () =>
      new Promise<number>((resolve, reject) => {
        count += 1;
        gates.push({ resolve, reject });
      }),
    started: () => count,
    release: (n, fail) =>
      fail ? gates[n - 1].reject(new Error(`run ${n}`)) : gates[n - 1].resolve(n),
  };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('FreshCoalescer', () => {
  it('runs the task at once when nothing is in flight', async () => {
    const c = new FreshCoalescer<number>();
    const g = gatedTask();
    const first = c.run('repo', g.task);
    assert.strictEqual(g.started(), 1);
    g.release(1);
    assert.strictEqual(await first, 1);
  });

  it('answers a caller arriving mid-run with a run that starts after it', async () => {
    const c = new FreshCoalescer<number>();
    const g = gatedTask();
    const first = c.run('repo', g.task);
    const second = c.run('repo', g.task);
    assert.strictEqual(g.started(), 1, 'no second run while one is in flight');
    g.release(1);
    await tick();
    assert.strictEqual(g.started(), 2, 'the follow-up starts once the first settles');
    g.release(2);
    assert.strictEqual(await first, 1);
    assert.strictEqual(await second, 2, 'the late caller is NOT answered by the earlier run');
  });

  it('shares ONE follow-up among every caller arriving during a run', async () => {
    const c = new FreshCoalescer<number>();
    const g = gatedTask();
    void c.run('repo', g.task);
    const late = [c.run('repo', g.task), c.run('repo', g.task), c.run('repo', g.task)];
    g.release(1);
    await tick();
    g.release(2);
    assert.deepStrictEqual(await Promise.all(late), [2, 2, 2]);
    assert.strictEqual(g.started(), 2);
  });

  it('queues behind the follow-up once it has started', async () => {
    const c = new FreshCoalescer<number>();
    const g = gatedTask();
    void c.run('repo', g.task);
    const second = c.run('repo', g.task);
    g.release(1);
    await tick();
    const third = c.run('repo', g.task);
    assert.strictEqual(g.started(), 2, 'the third waits for the running follow-up');
    g.release(2);
    await tick();
    assert.strictEqual(g.started(), 3);
    g.release(3);
    assert.strictEqual(await second, 2);
    assert.strictEqual(await third, 3);
  });

  it('still runs the follow-up when the earlier run fails, and reports each failure to its own callers', async () => {
    const c = new FreshCoalescer<number>();
    const g = gatedTask();
    const first = c.run('repo', g.task);
    const second = c.run('repo', g.task);
    g.release(1, true);
    await assert.rejects(first, /run 1/);
    await tick();
    g.release(2);
    assert.strictEqual(await second, 2);
  });

  it('starts fresh once everything has settled', async () => {
    const c = new FreshCoalescer<number>();
    const g = gatedTask();
    const first = c.run('repo', g.task);
    g.release(1);
    await first;
    await tick();
    const again = c.run('repo', g.task);
    assert.strictEqual(g.started(), 2);
    g.release(2);
    assert.strictEqual(await again, 2);
  });

  it('keeps keys independent', async () => {
    const c = new FreshCoalescer<number>();
    const a = gatedTask();
    const b = gatedTask();
    void c.run('a', a.task);
    void c.run('b', b.task);
    assert.strictEqual(a.started() + b.started(), 2);
  });
});
