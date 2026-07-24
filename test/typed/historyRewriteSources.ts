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

/** Concatenated family source for cross-module structural pins. */
export function readHistoryRewriteFamily(): string {
  return HISTORY_REWRITE_MODULES.map((rel) =>
    fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
  ).join('\n');
}
