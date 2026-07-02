// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/LCSBuilder.kt
// Copyright 2000-2025 JetBrains s.r.o. and contributors. Apache 2.0 license.

export interface ILCSBuilder {
  addEqual(length: number): void;
  addChange(first: number, second: number): void;
}
