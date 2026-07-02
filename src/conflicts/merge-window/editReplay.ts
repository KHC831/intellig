// Replays Monaco content-change events onto the merge model's document of
// record. Monaco reports each batch's ranges in pre-change coordinates, so
// applying from the highest offset down keeps every earlier offset valid.

import type { IMergeDocument } from '../merge-model/MergeDocument';

/** The subset of Monaco's IModelContentChange the replay needs. */
export interface IMonacoLikeChange {
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly text: string;
}

export function replayMonacoChanges(
  document: IMergeDocument,
  changes: readonly IMonacoLikeChange[]
): void {
  const ordered = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  for (const change of ordered) {
    document.replaceString(
      change.rangeOffset,
      change.rangeOffset + change.rangeLength,
      change.text
    );
  }
}
