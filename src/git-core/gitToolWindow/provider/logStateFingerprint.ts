/**
 * Pure fingerprint of the log-state inputs the graph render depends on.
 *
 * Two updates with the same fingerprint would paint identical graph DOM, so
 * the provider can skip the rebuild (see GitToolWindowProvider.updateLogState).
 * Commit hashes cover everything inside a commit (message, author, parents);
 * the maps, head anchor, and total cover the rest of the rendered state. Map
 * keys are sorted so construction order can never fake a difference, and every
 * joiner is a control character (git-check-ref-format forbids them in ref
 * names), so no branch/tag name can collide two different states into one
 * fingerprint.
 */

import { ICommit } from '../../interfaces/IGitService';
import { IBranchRef } from '../../commitGraph';

const FIELD_SEP = '\u0000';
const SECTION_SEP = '\u0001';
const ENTRY_SEP = '\u0002';
const NAME_SEP = '\u0003';

export function fingerprintLogState(
  commits: ICommit[],
  branchMap: Map<string, IBranchRef[]> | undefined,
  tagMap: Map<string, string[]> | undefined,
  headHash: string | undefined,
  headBranchName: string | undefined,
  totalAvailable: number | undefined
): string {
  const parts: string[] = [];
  for (const commit of commits) {
    // repoRoot participates: in the merged view the same hash can appear once
    // per checkout, and rows are keyed by (hash, root).
    parts.push(commit.hash + (commit.repoRoot ?? ''));
  }
  parts.push(SECTION_SEP);
  if (branchMap) {
    // row-key-exempt: opaque fingerprint token, never a commit hash — ref-sort-exempt: never a displayed name either
    for (const key of [...branchMap.keys()].sort()) {
      const refs = branchMap.get(key) ?? [];
      parts.push(
        key +
          NAME_SEP +
          refs
            .map((ref) => ref.name + NAME_SEP + ref.type)
            .sort() // ref-sort-exempt: opaque fingerprint token
            .join(ENTRY_SEP)
      );
    }
  }
  parts.push(SECTION_SEP);
  if (tagMap) {
    // row-key-exempt: opaque fingerprint token, never a commit hash — ref-sort-exempt: never a displayed name either
    for (const key of [...tagMap.keys()].sort()) {
      parts.push(
        key + NAME_SEP + [...(tagMap.get(key) ?? [])].sort().join(ENTRY_SEP) // ref-sort-exempt: opaque fingerprint token
      );
    }
  }
  parts.push(SECTION_SEP, headHash ?? '', headBranchName ?? '', String(totalAvailable ?? ''));
  return parts.join(FIELD_SEP);
}
