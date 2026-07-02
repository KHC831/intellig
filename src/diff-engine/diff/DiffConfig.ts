// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/DiffConfig.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

export const DiffConfig = {
  USE_PATIENCE_ALG: false,
  USE_GREEDY_MERGE_MAGIC_RESOLVE: false,
  DELTA_THRESHOLD_SIZE: 20000,
  /** Do not try to compare lines by-word after that many prior failures. */
  MAX_BAD_LINES: 3,
  UNIMPORTANT_LINE_CHAR_COUNT: 3,
} as const;
