// Ported from intellij-community platform/diff-impl/src/com/intellij/diff/util/DiffUtil.java
// (the document-range helpers the merge model needs: applyModification,
// getLines/getLinesContent, getAffectedLineRange, countLinesShift,
// updateRangeOnModification). Copyright 2000-2025 JetBrains s.r.o. and
// contributors. Apache 2.0 license.

import {
  LinesRange,
  getLines as getLinesFromText,
  getLinesContent as getLinesContentFromText,
  getLinesRange as getLinesRangeFromOffsets,
} from '../../diff-engine/util/DiffRangeUtil';
import { LineRange } from '../../diff-engine/util/LineRange';
import type { IDocumentEvent, IMergeDocument } from './MergeDocument';

export function getLineCount(document: IMergeDocument): number {
  return document.getLineOffsets().lineCount;
}

export function getLinesContent(document: IMergeDocument, line1: number, line2: number): string {
  return getLinesContentFromText(document.getText(), document.getLineOffsets(), line1, line2);
}

export function getLines(
  document: IMergeDocument,
  startLine: number = 0,
  endLine: number = getLineCount(document)
): string[] {
  return getLinesFromText(document.getText(), document.getLineOffsets(), startLine, endLine);
}

export function getLinesRange(document: IMergeDocument, line1: number, line2: number): LinesRange {
  return getLinesRangeFromOffsets(document.getLineOffsets(), line1, line2, false);
}

export function applyModification(
  document: IMergeDocument,
  line1: number,
  line2: number,
  newLines: readonly string[]
): void {
  if (line1 === line2 && newLines.length === 0) {
    return;
  }
  if (line1 === line2) {
    insertLines(document, line1, newLines.join('\n'));
  } else if (newLines.length === 0) {
    deleteLines(document, line1, line2);
  } else {
    replaceLines(document, line1, line2, newLines.join('\n'));
  }
}

function insertLines(document: IMergeDocument, line: number, text: string): void {
  if (line === getLineCount(document)) {
    const length = document.textLength;
    document.replaceString(length, length, '\n' + text);
  } else {
    const offset = document.getLineOffsets().getLineStart(line);
    document.replaceString(offset, offset, text + '\n');
  }
}

function deleteLines(document: IMergeDocument, line1: number, line2: number): void {
  const range = getLinesRange(document, line1, line2);
  let offset1 = range.startOffset;
  let offset2 = range.endOffset;

  if (offset1 > 0) {
    offset1--;
  } else if (offset2 < document.textLength) {
    offset2++;
  }
  document.replaceString(offset1, offset2, '');
}

function replaceLines(document: IMergeDocument, line1: number, line2: number, text: string): void {
  const range = getLinesRange(document, line1, line2);
  document.replaceString(range.startOffset, range.endOffset, text);
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      count++;
    }
  }
  return count;
}

/** Line range touched by the event; must be called before the change is applied. */
export function getAffectedLineRange(document: IMergeDocument, event: IDocumentEvent): LineRange {
  const lineOffsets = document.getLineOffsets();
  const line1 = lineOffsets.getLineNumber(event.offset);
  const line2 = lineOffsets.getLineNumber(event.offset + event.oldFragment.length) + 1;
  return new LineRange(line1, line2);
}

export function countLinesShift(event: IDocumentEvent): number {
  return countNewlines(event.newFragment) - countNewlines(event.oldFragment);
}

export class UpdatedLineRange {
  constructor(
    readonly startLine: number,
    readonly endLine: number,
    readonly damaged: boolean
  ) {}
}

export function updateRangeOnModification(
  start: number,
  end: number,
  changeStart: number,
  changeEnd: number,
  shift: number,
  greedy: boolean = false
): UpdatedLineRange {
  if (end <= changeStart) {
    // change before
    return new UpdatedLineRange(start, end, false);
  }
  if (start >= changeEnd) {
    // change after
    return new UpdatedLineRange(start + shift, end + shift, false);
  }

  if (start <= changeStart && end >= changeEnd) {
    // change inside
    return new UpdatedLineRange(start, end + shift, false);
  }

  // range is damaged. We don't know new boundaries.
  // But we can try to return approximate new position
  const newChangeEnd = changeEnd + shift;

  if (start >= changeStart && end <= changeEnd) {
    // fully inside change
    return greedy
      ? new UpdatedLineRange(changeStart, newChangeEnd, true)
      : new UpdatedLineRange(newChangeEnd, newChangeEnd, true);
  }

  if (start < changeStart) {
    // bottom boundary damaged
    return greedy
      ? new UpdatedLineRange(start, newChangeEnd, true)
      : new UpdatedLineRange(start, changeStart, true);
  } else {
    // top boundary damaged
    return greedy
      ? new UpdatedLineRange(changeStart, end + shift, true)
      : new UpdatedLineRange(newChangeEnd, end + shift, true);
  }
}
