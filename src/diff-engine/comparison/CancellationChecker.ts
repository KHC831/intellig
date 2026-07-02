// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/CancellationChecker.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

/** Cooperative-cancellation hook polled by the long-running comparison loops. */
export interface ICancellationChecker {
  /** Throws ProcessCanceledException when the computation should stop. */
  checkCanceled(): void;
}

export const EMPTY_CANCELLATION_CHECKER: ICancellationChecker = {
  checkCanceled: () => undefined,
};
