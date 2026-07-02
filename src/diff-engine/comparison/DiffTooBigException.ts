// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/DiffTooBigException.kt
// Copyright 2000-2021 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { ProcessCanceledException } from '../util/ProcessCanceledException';

export class DiffTooBigException extends ProcessCanceledException {
  constructor() {
    super('Diff is too big');
  }
}
