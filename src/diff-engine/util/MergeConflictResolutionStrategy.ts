// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/MergeConflictResolutionStrategy.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

/**
 * The strategy that will be used to resolve merge conflicts.
 * - DEFAULT: only available when there is no conflict
 * - TEXT: uses the fact that changes do not overlap at the word level (see comparison/ComparisonMergeUtil)
 * - SEMANTIC: uses the structure of the file (language-specific; not implemented in this port)
 */
export enum MergeConflictResolutionStrategy {
  DEFAULT = 'DEFAULT',
  TEXT = 'TEXT',
  SEMANTIC = 'SEMANTIC',
}
