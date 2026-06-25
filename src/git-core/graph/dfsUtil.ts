/**
 * Faithful port of IntelliJ's `DfsUtil` (platform/vcs-log/graph) — the
 * stack-based DFS driver `GraphLayoutBuilder` uses to walk a graph fragment.
 *
 * `walk(start, nextNodeFun)` pushes `start`, then repeatedly asks `nextNodeFun`
 * for the next node from the stack top: `NODE_NOT_FOUND` pops (backtrack),
 * `EXIT` aborts, any other value is pushed (descend). Identical control flow to
 * the Kotlin original so the ownership walk reproduces exactly.
 */

export const Dfs = {
  NextNode: {
    NODE_NOT_FOUND: -1,
    EXIT: -10,
  },
} as const;

/**
 * Iterative DFS. `nextNodeFun` is called with the current stack-top node and
 * returns the next node to descend into, or {@link Dfs.NextNode.NODE_NOT_FOUND}
 * to backtrack, or {@link Dfs.NextNode.EXIT} to stop the whole walk.
 */
export function walk(start: number, nextNodeFun: (node: number) => number): void {
  const stack: number[] = [start];
  while (stack.length > 0) {
    const nextNode = nextNodeFun(stack[stack.length - 1]);
    if (nextNode === Dfs.NextNode.EXIT) {
      return;
    }
    if (nextNode !== Dfs.NextNode.NODE_NOT_FOUND) {
      stack.push(nextNode);
    } else {
      stack.pop();
    }
  }
}
