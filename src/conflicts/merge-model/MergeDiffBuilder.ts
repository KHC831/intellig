// Ported from intellij-community platform/diff-impl/src/com/intellij/diff/merge/MergeDiffBuilder.kt
// Copyright 2000-2026 JetBrains s.r.o. and contributors. Apache 2.0 license.
// Reduced to the text lane: the PSI/import/semantic-resolver machinery is not
// ported, which leaves fragment computation plus per-fragment conflict typing.

import { EMPTY_CANCELLATION_CHECKER } from '../../diff-engine/comparison/CancellationChecker';
import { ComparisonPolicy } from '../../diff-engine/comparison/ComparisonPolicy';
import { mergeLines } from '../../diff-engine/comparison/ComparisonManager';
import { IMergeLineFragment } from '../../diff-engine/fragments/MergeLineFragment';
import { LineOffsetsImpl } from '../../diff-engine/text/LineOffsets';
import { MergeConflictType } from '../../diff-engine/util/MergeConflictType';
import { getLineMergeType } from '../../diff-engine/util/MergeRangeUtil';
import type { IMergeDocument } from './MergeDocument';

export class MergeDiffData {
  constructor(
    readonly fragments: readonly IMergeLineFragment[],
    readonly conflictTypes: readonly MergeConflictType[],
    readonly policy: ComparisonPolicy
  ) {}
}

export function buildMergeDiffData(
  contents: readonly [IMergeDocument, IMergeDocument, IMergeDocument],
  policy: ComparisonPolicy
): MergeDiffData {
  const sequences = contents.map((document) => document.getText());
  const fragments = mergeLines(
    sequences[0],
    sequences[1],
    sequences[2],
    policy,
    EMPTY_CANCELLATION_CHECKER
  );
  const lineOffsets = sequences.map((sequence) => LineOffsetsImpl.create(sequence));

  const conflictTypes = fragments.map((fragment) =>
    getLineMergeType(fragment, sequences, lineOffsets, policy)
  );

  return new MergeDiffData(fragments, conflictTypes, policy);
}
