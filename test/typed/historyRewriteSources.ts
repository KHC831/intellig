import * as fs from 'fs';
import * as path from 'path';

/**
 * The extracted history-rewrite module family, in declaration order: the
 * shared runner, the message editor, then the flow modules. Structural pins
 * slice function bodies by decl-to-next-decl offsets, so the concatenation
 * order keeps drop → squash → reword adjacency stable.
 */
export const HISTORY_REWRITE_MODULES = [
  'src/commits/commitHistoryRewriteRunner.ts',
  'src/commits/commitMessageEditor.ts',
  'src/commits/commitDropActions.ts',
  'src/commits/commitSquashActions.ts',
  'src/commits/commitRewordActions.ts',
  'src/commits/commitInteractiveRebaseActions.ts',
] as const;

/**
 * Concatenated family source — for FAMILY-WIDE pins only (symbol-presence
 * greps, absence checks, reference counts). Body-slicing pins must read the
 * single owning module via {@link readCommitModule} instead: offset slices
 * across a concatenation silently widen when the array order or module
 * contents shift.
 */
export function readHistoryRewriteFamily(): string {
  return HISTORY_REWRITE_MODULES.map((rel) =>
    fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
  ).join('\n');
}

/** Single-module source for body-slicing structural pins. */
export function readCommitModule(basename: string): string {
  return fs.readFileSync(path.join(process.cwd(), 'src/commits', basename), 'utf8');
}

/**
 * Slice one function's body out of its owning module: from the declaration
 * to the next top-level `export`/`async function` declaration, or EOF.
 * Anchored inside a single file so module reordering can never silently
 * widen a pin's window. Throws when the declaration is missing — a pin
 * must fail loudly, not scan the wrong region.
 */
export function moduleFunctionBody(basename: string, decl: string): string {
  const src = readCommitModule(basename);
  const start = src.indexOf(decl);
  if (start < 0) {
    throw new Error(`declaration not found in ${basename}: ${decl}`);
  }
  const tail = src.substring(start + decl.length);
  const next = tail.search(/\n(?:export |async function )/);
  return next >= 0 ? src.substring(start, start + decl.length + next) : src.substring(start);
}
