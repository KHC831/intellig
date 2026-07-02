// Ported from intellij-community platform/util/diff/src/com/intellij/util/diff/FilesTooBigForDiffException.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

export class FilesTooBigForDiffException extends Error {
  constructor() {
    super('Unable to calculate diff. File is too big and there are too many changes.');
    this.name = 'FilesTooBigForDiffException';
  }
}
