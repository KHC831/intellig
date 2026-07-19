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
  const runners = Array.from({ length: Math.min(limit, items.length) }, async (): Promise<void> => {
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
