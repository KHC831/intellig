// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/MergeConflictType.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { MergeConflictResolutionStrategy } from './MergeConflictResolutionStrategy';
import { Side } from './Side';
import { ThreeSide } from './ThreeSide';

export enum MergeConflictTypeKind {
  INSERTED = 'INSERTED',
  DELETED = 'DELETED',
  MODIFIED = 'MODIFIED',
  CONFLICT = 'CONFLICT',
}

export class MergeConflictType {
  resolutionStrategy: MergeConflictResolutionStrategy | undefined;

  // The strategy is required — `undefined` means "cannot be resolved" (Kotlin
  // null). A default parameter here would silently upgrade an explicit
  // `undefined` to DEFAULT, marking unresolvable conflicts resolvable.
  constructor(
    readonly type: MergeConflictTypeKind,
    private readonly leftChange: boolean,
    private readonly rightChange: boolean,
    resolutionStrategy: MergeConflictResolutionStrategy | undefined
  ) {
    this.resolutionStrategy = resolutionStrategy;
  }

  static withResolvability(
    type: MergeConflictTypeKind,
    leftChange: boolean,
    rightChange: boolean,
    canBeResolved: boolean
  ): MergeConflictType {
    return new MergeConflictType(
      type,
      leftChange,
      rightChange,
      canBeResolved ? MergeConflictResolutionStrategy.DEFAULT : undefined
    );
  }

  canBeResolved(): boolean {
    return this.resolutionStrategy !== undefined;
  }

  isChange(side: Side | ThreeSide): boolean {
    if (side instanceof Side) {
      return side.isLeft ? this.leftChange : this.rightChange;
    }
    return side.select(this.leftChange, true, this.rightChange);
  }
}
