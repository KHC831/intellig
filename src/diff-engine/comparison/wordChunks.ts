// Ported from intellij-community platform/util/diff/src/com/intellij/diff/comparison/ByWordRt.kt
// (the InlineChunk family and getInlineChunks). Copyright 2000-2024 JetBrains s.r.o. and
// contributors. Apache 2.0 license.
//
// Kotlin compares chunks via equals/hashCode; here every chunk carries an equalityKey
// and the diff runs on those keys.

import { charCount, codePointAtIndex } from './CharacterUtils';
import { isAlpha, isContinuousScript } from './TrimUtil';

export interface IInlineChunk {
  readonly offset1: number;
  readonly offset2: number;
  /** Chunks are equal for diff purposes iff their keys are equal. */
  readonly equalityKey: string;
}

export class WordChunk implements IInlineChunk {
  constructor(
    private readonly text: string,
    readonly offset1: number,
    readonly offset2: number
  ) {}

  get content(): string {
    return this.text.substring(this.offset1, this.offset2);
  }

  get equalityKey(): string {
    return `w${this.content}`;
  }
}

export class NewlineChunk implements IInlineChunk {
  readonly equalityKey = '\n';

  constructor(readonly offset1: number) {}

  get offset2(): number {
    return this.offset1 + 1;
  }
}

export function isWordChunk(chunk: IInlineChunk): boolean {
  return chunk instanceof WordChunk;
}

export function getInlineChunks(text: string): IInlineChunk[] {
  const chunks: IInlineChunk[] = [];

  const len = text.length;
  let offset = 0;

  let wordStart = -1;

  while (offset < len) {
    const ch = codePointAtIndex(text, offset);
    const chCharCount = charCount(ch);

    const alpha = isAlpha(ch);
    const isWordPart = alpha && !isContinuousScript(ch);

    if (isWordPart) {
      if (wordStart === -1) {
        wordStart = offset;
      }
    } else {
      if (wordStart !== -1) {
        chunks.push(new WordChunk(text, wordStart, offset));
        wordStart = -1;
      }

      if (alpha) {
        // continuous script
        chunks.push(new WordChunk(text, offset, offset + chCharCount));
      } else if (ch === 0x0a) {
        chunks.push(new NewlineChunk(offset));
      }
    }

    offset += chCharCount;
  }

  if (wordStart !== -1) {
    chunks.push(new WordChunk(text, wordStart, len));
  }

  return chunks;
}

export function countNewlines(words: readonly IInlineChunk[]): number {
  let count = 0;
  for (const word of words) {
    if (word instanceof NewlineChunk) {
      count++;
    }
  }
  return count;
}
