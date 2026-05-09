/**
 * Deterministic commit ordering for "multi-commit diff"-style consumers.
 *
 * Context
 * -------
 * {@link GitService.getMultiCommitDiff} and its mock counterpart both need
 * to pick an "oldest" and "newest" commit from an arbitrary user selection.
 * Sorting only by `%cI` timestamp is not enough: when two commits share a
 * timestamp (same-second fixups, imported histories, squash-and-rebase tooling
 * that reuses a committer date, etc.) V8's sort is stable but the *input*
 * ordering is not — the same selection reached through different UI paths
 * can produce different oldest/newest picks, which in turn produces a
 * different diff range.
 *
 * Round-2 fix (TR-4) added an alphabetical `hash.localeCompare` tie-break to
 * the mock. Round-3 review (TR-5) then found that the tie-break is
 * deterministic but causally *wrong*: when a delete-commit collides with its
 * parent modify-commit's timestamp, the lower-alphabet hash can put the
 * delete ahead of its own parent in the order, and the cumulative "base
 * state → final state" diff loses the deletion.
 *
 * This helper fixes the causal bug: within a date-tied group, parents are
 * guaranteed to sort before their children (topological tie-break via
 * Kahn's algorithm on the intra-group parent edges). Hash order is the
 * final, purely-alphabetic tiebreaker inside the ready-queue — it only
 * matters when commits are genuinely unrelated within the group.
 *
 * Consumers without `parents` data can still use this helper: with no
 * parent edges every commit is "ready" from the start, and the sort
 * degenerates to the hash-alphabetical form from the Round-2 fix, which
 * is still deterministic across input orderings. Production's
 * `getMultiCommitDiff` was updated to fetch `%cI%x09%P` so it always has
 * parents available; the fallback is here for other future callers and
 * for the cycle-in-fuzz-input case described below.
 */

/**
 * Minimum shape `sortCommitsStable` needs. Any type with `hash` and
 * `commitDate` works; `parents` is optional and unlocks the causal
 * topological tie-break when present.
 */
export interface ISortableCommit {
  readonly hash: string;
  readonly commitDate: Date;
  readonly parents?: readonly string[];
}

/**
 * Sort `commits` by `commitDate` ascending (oldest first), using a
 * topological tie-break when `parents` is available and an alphabetical
 * hash tie-break otherwise. Pure: returns a new array; does not mutate
 * the input.
 *
 * Properties:
 * - Stable across V8 versions.
 * - Stable across different input orderings (swap inputs around → same output).
 * - For any date-tied pair where one commit lists the other in its
 *   `parents`, the parent is placed first.
 */
export function sortCommitsStable<T extends ISortableCommit>(commits: readonly T[]): T[] {
  if (commits.length <= 1) {
    return commits.slice();
  }

  // Primary sort by commit date (oldest first). V8's sort is stable, but we
  // rely on the group pass below rather than stability to get determinism
  // across input orderings.
  const byDate = commits.slice().sort(
    (a, b) => a.commitDate.getTime() - b.commitDate.getTime()
  );

  // Walk runs of identical timestamps and resolve each run with the
  // topological tie-break.
  const out: T[] = [];
  let i = 0;
  while (i < byDate.length) {
    let j = i + 1;
    const time = byDate[i].commitDate.getTime();
    while (j < byDate.length && byDate[j].commitDate.getTime() === time) {
      j += 1;
    }
    if (j - i === 1) {
      out.push(byDate[i]);
    } else {
      out.push(...resolveDateTiedGroup(byDate.slice(i, j)));
    }
    i = j;
  }

  return out;
}

/**
 * Kahn's topological sort restricted to the given group. Parent edges that
 * reference commits outside the group are ignored (they're either earlier
 * in the overall order — already placed by the date sort — or not selected
 * at all, neither of which constrains intra-group ordering).
 *
 * Among ready nodes (zero in-degree) we always pop the lexicographically
 * smallest hash first, which means two differently-permuted inputs produce
 * the same output.
 *
 * If the input contains a cycle (shouldn't happen for real git history
 * but can with fuzzed property-test input), any commits still trapped in
 * the cycle are appended in hash-alphabetical order so the function still
 * returns every commit it received.
 */
function resolveDateTiedGroup<T extends ISortableCommit>(group: T[]): T[] {
  const byHash = new Map<string, T>();
  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();

  for (const c of group) {
    byHash.set(c.hash, c);
    inDegree.set(c.hash, 0);
    children.set(c.hash, []);
  }

  for (const c of group) {
    const parents = c.parents ?? [];
    for (const p of parents) {
      if (byHash.has(p)) {
        // Intra-group edge: p → c
        inDegree.set(c.hash, (inDegree.get(c.hash) ?? 0) + 1);
        children.get(p)!.push(c.hash);
      }
    }
  }

  // Build the initial "ready" queue kept sorted by hash ascending so the
  // smallest-hash candidate is always at index 0.
  const ready: string[] = [];
  for (const c of group) {
    if ((inDegree.get(c.hash) ?? 0) === 0) {
      ready.push(c.hash);
    }
  }
  ready.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const placed = new Set<string>();
  const out: T[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    placed.add(next);
    out.push(byHash.get(next)!);
    for (const child of children.get(next) ?? []) {
      const remaining = (inDegree.get(child) ?? 1) - 1;
      inDegree.set(child, remaining);
      if (remaining === 0) {
        // Insertion sort into the ready queue (preserves hash-asc order).
        let pos = 0;
        while (pos < ready.length && ready[pos] < child) {
          pos += 1;
        }
        ready.splice(pos, 0, child);
      }
    }
  }

  // Defensive fallback: anything left unplaced sits in a cycle. Flush it in
  // hash-alphabetical order so the function is still total.
  if (out.length < group.length) {
    const leftovers = group
      .filter((c) => !placed.has(c.hash))
      .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    out.push(...leftovers);
  }

  return out;
}
