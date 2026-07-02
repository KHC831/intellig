// Ported from intellij-community platform/util/diff/src/com/intellij/diff/util/DiffRangeUtil.kt
// Copyright 2000-2024 JetBrains s.r.o. and contributors. Apache 2.0 license.

import { ILineOffsets } from '../text/LineOffsets';

export class LinesRange {
  constructor(
    readonly startOffset: number,
    readonly endOffset: number
  ) {}
}

export function getLinesContent(
  sequence: string,
  lineOffsets: ILineOffsets,
  line1: number,
  line2: number,
  includeNewline: boolean = false
): string {
  if (sequence.length !== lineOffsets.textLength) {
    throw new Error(
      `text length ${sequence.length} does not match lineOffsets ${lineOffsets.textLength}`
    );
  }
  const linesRange = getLinesRange(lineOffsets, line1, line2, includeNewline);
  return sequence.substring(linesRange.startOffset, linesRange.endOffset);
}

export function getLinesRange(
  lineOffsets: ILineOffsets,
  line1: number,
  line2: number,
  includeNewline: boolean
): LinesRange {
  if (line1 === line2) {
    const lineStartOffset =
      line1 < lineOffsets.lineCount ? lineOffsets.getLineStart(line1) : lineOffsets.textLength;
    return new LinesRange(lineStartOffset, lineStartOffset);
  }
  const startOffset = lineOffsets.getLineStart(line1);
  let endOffset = lineOffsets.getLineEnd(line2 - 1);
  if (includeNewline && endOffset < lineOffsets.textLength) {
    endOffset++;
  }
  return new LinesRange(startOffset, endOffset);
}

export function getLines(
  text: string,
  lineOffsets: ILineOffsets,
  startLine: number = 0,
  endLine: number = lineOffsets.lineCount
): string[] {
  if (startLine < 0 || startLine > endLine || endLine > lineOffsets.lineCount) {
    throw new RangeError(
      `Wrong line range: [${startLine}, ${endLine}); lineCount: '${lineOffsets.lineCount}'`
    );
  }

  const result: string[] = [];
  for (let i = startLine; i < endLine; i++) {
    result.push(text.substring(lineOffsets.getLineStart(i), lineOffsets.getLineEnd(i)));
  }
  return result;
}
