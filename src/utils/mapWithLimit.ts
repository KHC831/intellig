/**
 * Bounded-concurrency map.
 *
 * The alternative at both call sites is an unbounded `Promise.all`, which
 * starts every unit of work at once: a normalization-scale commit exhausts the
 * process descriptor limit, and a several-hundred-commit selection spawns one
 * git process per commit simultaneously.
 */

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the result.
 */
export async function mapWithLimit<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // A limit below one — or a non-finite one, which Math.max propagates as NaN
  // straight into `Array.from({length: NaN})` — would spawn no runners at all,
  // resolving an array of holes while reporting success. Always keep at least one.
  const requested = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const runnerCount = Math.min(requested, items.length);
  const runners = Array.from({ length: runnerCount }, async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}
