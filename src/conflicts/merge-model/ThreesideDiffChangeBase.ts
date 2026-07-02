// Ported from intellij-community platform/diff-impl/src/com/intellij/diff/tools/simple/ThreesideDiffChangeBase.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { MergeConflictType, MergeConflictTypeKind } from '../../diff-engine/util/MergeConflictType';
import { Side } from '../../diff-engine/util/Side';
import { ThreeSide } from '../../diff-engine/util/ThreeSide';

export abstract class ThreesideDiffChangeBase {
  constructor(readonly conflictType: MergeConflictType) {}

  abstract getStartLine(side: ThreeSide): number;

  abstract getEndLine(side: ThreeSide): number;

  abstract isResolved(side?: Side | ThreeSide): boolean;

  get isConflict(): boolean {
    return this.conflictType.type === MergeConflictTypeKind.CONFLICT;
  }

  isChange(side: Side | ThreeSide): boolean {
    return this.conflictType.isChange(side);
  }
}
