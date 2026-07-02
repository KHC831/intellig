// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/comparison/ComparisonUtilAutoTest.kt
// (the seeded-random auto tests, re-expressed on fast-check).
// Copyright 2000-2015 JetBrains s.r.o. Apache 2.0 license.
//
// For any pair (or trio) of generated texts, the engines must produce fragments that
// are consistent (ordered, non-empty, squashed), reconstruct equality outside the
// changed ranges under the active whitespace policy, keep surrogate pairs intact, and
// leave no changed block whose boundary lines could still be matched.

import * as fc from 'fast-check';
import * as assert from 'assert';
import * as ComparisonManager from '../../src/diff-engine/comparison/ComparisonManager';
import { ComparisonPolicy } from '../../src/diff-engine/comparison/ComparisonPolicy';
import {
  getUnimportantLineCharCount,
  isEqualTexts,
} from '../../src/diff-engine/comparison/ComparisonUtil';
import * as ByWordRt from '../../src/diff-engine/comparison/ByWordRt';
import { EMPTY_CANCELLATION_CHECKER } from '../../src/diff-engine/comparison/CancellationChecker';
import { setVerifyEnabled } from '../../src/diff-engine/comparison/iterables/DiffIterableUtil';
import {
  equalsIgnoreWhitespaces,
  isSpaceEnterOrTabAt,
} from '../../src/diff-engine/comparison/strings';
import { BitSet } from '../../src/diff-engine/diff/BitSet';
import { MyersLCS } from '../../src/diff-engine/diff/MyersLCS';
import { PatienceIntLCS } from '../../src/diff-engine/diff/PatienceIntLCS';
import { IDiffFragment } from '../../src/diff-engine/fragments/DiffFragment';
import { ILineFragment } from '../../src/diff-engine/fragments/LineFragment';
import { IMergeLineFragment } from '../../src/diff-engine/fragments/MergeLineFragment';
import { IMergeWordFragment } from '../../src/diff-engine/fragments/MergeWordFragment';
import { ILineOffsets, LineOffsetsImpl } from '../../src/diff-engine/text/LineOffsets';
import { getLinesContent } from '../../src/diff-engine/util/DiffRangeUtil';
import { ThreeSide } from '../../src/diff-engine/util/ThreeSide';

const CANCELLATION = EMPTY_CANCELLATION_CHECKER;
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

const NUM_RUNS = 40;
const MAX_LENGTH = 300;

const POLICIES = [
  ComparisonPolicy.DEFAULT,
  ComparisonPolicy.TRIM_WHITESPACES,
  ComparisonPolicy.IGNORE_WHITESPACES,
];

// DiffTestCase.generateText: 12 slots — the 8 predefined chars, then 'i'..'l';
// the high-surrogate variant appends 4 emoji.
const BASE_CHARS = [NL, NL, TAB, ' ', ' ', '.', '<', '!', 'i', 'j', 'k', 'l'];
const SURROGATE_CHARS = [
  ...BASE_CHARS,
  String.fromCodePoint(0x1f602),
  String.fromCodePoint(0x1f92b),
  String.fromCodePoint(0x1f52b),
  String.fromCodePoint(0x1f9d2),
];

function textArb(useHighSurrogates: boolean): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...(useHighSurrogates ? SURROGATE_CHARS : BASE_CHARS)), {
      maxLength: MAX_LENGTH,
      size: 'max',
    })
    .map((chars) => chars.join(''));
}

const textPairArb: fc.Arbitrary<readonly [string, string]> = fc
  .boolean()
  .chain((useHighSurrogates) => fc.tuple(textArb(useHighSurrogates), textArb(useHighSurrogates)));

function isEqualsChunks(chunk1: string, chunk2: string, ignoreSpaces: boolean): boolean {
  if (ignoreSpaces) {
    return equalsIgnoreWhitespaces(chunk1, chunk2);
  }
  return chunk1 === chunk2;
}

function stripNewline(text: string): string | undefined {
  return text.endsWith(NL) ? text.substring(0, text.length - 1) : undefined;
}

function assertEqualsCharSequences(
  chunk1: string,
  chunk2: string,
  ignoreSpaces: boolean,
  skipLastNewline: boolean
): void {
  if (skipLastNewline && !ignoreSpaces) {
    assert.ok(
      chunk1 === chunk2 || stripNewline(chunk1) === chunk2 || chunk1 === stripNewline(chunk2),
      `Text1: '${chunk1}', Text2: '${chunk2}'`
    );
  } else {
    assert.ok(
      isEqualsChunks(chunk1, chunk2, ignoreSpaces),
      `Text1: '${chunk1}', Text2: '${chunk2}'`
    );
  }
}

function checkDiffConsistency(fragments: readonly IDiffFragment[]): void {
  let last1 = -1;
  let last2 = -1;

  for (const fragment of fragments) {
    assert.ok(fragment.startOffset1 <= fragment.endOffset1);
    assert.ok(fragment.startOffset2 <= fragment.endOffset2);
    assert.ok(
      fragment.startOffset1 !== fragment.endOffset1 || fragment.startOffset2 !== fragment.endOffset2
    );
    assert.ok(
      fragment.startOffset1 !== last1 || fragment.startOffset2 !== last2,
      'fragments must be squashed'
    );

    last1 = fragment.endOffset1;
    last2 = fragment.endOffset2;
  }
}

function checkCodePoints(text: string, changesSet: BitSet): void {
  let offset = 0;
  while (offset < text.length) {
    const cp = text.codePointAt(offset) as number;
    const width = cp >= 0x10000 ? 2 : 1;

    if (width === 2) {
      assert.strictEqual(
        changesSet.get(offset),
        changesSet.get(offset + 1),
        'surrogate pairs must not be split by a change boundary'
      );
    }

    offset += width;
  }
}

function checkValidRanges(
  text1: string,
  text2: string,
  fragments: readonly IDiffFragment[],
  policy: ComparisonPolicy,
  skipNewline: boolean
): void {
  const ignoreSpacesUnchanged = policy !== ComparisonPolicy.DEFAULT;
  const ignoreSpacesChanged = policy === ComparisonPolicy.IGNORE_WHITESPACES;

  const changesSet1 = new BitSet();
  const changesSet2 = new BitSet();

  let last1 = 0;
  let last2 = 0;
  for (const fragment of fragments) {
    const chunk1 = text1.substring(last1, fragment.startOffset1);
    const chunk2 = text2.substring(last2, fragment.startOffset2);
    assertEqualsCharSequences(chunk1, chunk2, ignoreSpacesUnchanged, skipNewline);

    if (!skipNewline) {
      const chunkContent1 = text1.substring(fragment.startOffset1, fragment.endOffset1);
      const chunkContent2 = text2.substring(fragment.startOffset2, fragment.endOffset2);
      assert.ok(
        !isEqualsChunks(chunkContent1, chunkContent2, ignoreSpacesChanged),
        `changed chunks must differ: '${chunkContent1}' vs '${chunkContent2}'`
      );
    }

    changesSet1.setRange(fragment.startOffset1, fragment.endOffset1);
    changesSet2.setRange(fragment.startOffset2, fragment.endOffset2);

    last1 = fragment.endOffset1;
    last2 = fragment.endOffset2;
  }
  assertEqualsCharSequences(
    text1.substring(last1),
    text2.substring(last2),
    ignoreSpacesUnchanged,
    skipNewline
  );

  checkCodePoints(text1, changesSet1);
  checkCodePoints(text2, changesSet2);
}

function getLineCount(lineOffsets: ILineOffsets): number {
  return lineOffsets.lineCount;
}

function checkLineConsistency(
  text1: string,
  text2: string,
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets,
  fragments: readonly ILineFragment[],
  allowNonSquashed: boolean
): void {
  let last1 = -1;
  let last2 = -1;

  for (const fragment of fragments) {
    assert.ok(fragment.startOffset1 >= 0 && fragment.startOffset2 >= 0);
    assert.ok(fragment.endOffset1 <= text1.length && fragment.endOffset2 <= text2.length);
    assert.ok(fragment.startLine1 >= 0 && fragment.startLine2 >= 0);
    assert.ok(
      fragment.endLine1 <= getLineCount(lineOffsets1) &&
        fragment.endLine2 <= getLineCount(lineOffsets2)
    );
    assert.ok(
      fragment.startOffset1 <= fragment.endOffset1 && fragment.startOffset2 <= fragment.endOffset2
    );
    assert.ok(fragment.startLine1 <= fragment.endLine1 && fragment.startLine2 <= fragment.endLine2);
    assert.ok(
      fragment.startLine1 !== fragment.endLine1 || fragment.startLine2 !== fragment.endLine2
    );

    assert.ok(allowNonSquashed || fragment.startLine1 !== last1 || fragment.startLine2 !== last2);

    checkLineOffsets(fragment, text1, lineOffsets1, text2, lineOffsets2);

    last1 = fragment.endLine1;
    last2 = fragment.endLine2;
  }
}

function checkLineOffsets(
  fragment: ILineFragment,
  text1: string,
  lineOffsets1: ILineOffsets,
  text2: string,
  lineOffsets2: ILineOffsets
): void {
  checkSideLineOffsets(
    lineOffsets1,
    text1,
    fragment.startLine1,
    fragment.endLine1,
    fragment.startOffset1,
    fragment.endOffset1
  );
  checkSideLineOffsets(
    lineOffsets2,
    text2,
    fragment.startLine2,
    fragment.endLine2,
    fragment.startOffset2,
    fragment.endOffset2
  );
}

function checkSideLineOffsets(
  lineOffsets: ILineOffsets,
  text: string,
  startLine: number,
  endLine: number,
  startOffset: number,
  endOffset: number
): void {
  if (startLine !== endLine) {
    assert.strictEqual(startOffset, lineOffsets.getLineStart(startLine));
    let offset = lineOffsets.getLineEnd(endLine - 1);
    if (offset < text.length) {
      offset++;
    }
    assert.strictEqual(endOffset, offset);
  } else {
    const offset =
      startLine === getLineCount(lineOffsets) ? text.length : lineOffsets.getLineStart(startLine);
    assert.strictEqual(startOffset, offset);
    assert.strictEqual(endOffset, offset);
  }
}

function countNonWhitespaceCharacters(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (!isSpaceEnterOrTabAt(line, i)) {
      count++;
    }
  }
  return count;
}

function getFirstLastLines(
  text: string,
  lineOffsets: ILineOffsets,
  start: number,
  end: number
): readonly [string, string] | undefined {
  if (start === end) {
    return undefined;
  }

  const firstLine = getLinesContent(text, lineOffsets, start, start + 1);
  const lastLine = getLinesContent(text, lineOffsets, end - 1, end);
  return [firstLine, lastLine];
}

function checkNonEqualsIfLongEnough(
  line1: string,
  line2: string,
  policy: ComparisonPolicy,
  allowNonSquashed: boolean
): void {
  // in non-squashed blocks non-trimmed elements are possible
  if (allowNonSquashed) {
    if (policy !== ComparisonPolicy.IGNORE_WHITESPACES) {
      return;
    }
    if (countNonWhitespaceCharacters(line1) <= getUnimportantLineCharCount()) {
      return;
    }
    if (countNonWhitespaceCharacters(line2) <= getUnimportantLineCharCount()) {
      return;
    }
  }

  assert.ok(!isEqualTexts(line1, line2, policy), `"${line1}" vs "${line2}"`);
}

function checkCantTrimLines(
  text1: string,
  text2: string,
  lineOffsets1: ILineOffsets,
  lineOffsets2: ILineOffsets,
  fragments: readonly ILineFragment[],
  policy: ComparisonPolicy,
  allowNonSquashed: boolean
): void {
  for (const fragment of fragments) {
    const sequence1 = getFirstLastLines(
      text1,
      lineOffsets1,
      fragment.startLine1,
      fragment.endLine1
    );
    const sequence2 = getFirstLastLines(
      text2,
      lineOffsets2,
      fragment.startLine2,
      fragment.endLine2
    );
    if (sequence1 === undefined || sequence2 === undefined) {
      continue;
    }

    checkNonEqualsIfLongEnough(sequence1[0], sequence2[0], policy, allowNonSquashed);
    checkNonEqualsIfLongEnough(sequence1[1], sequence2[1], policy, allowNonSquashed);
  }
}

function checkResultLine(
  text1: string,
  text2: string,
  fragments: readonly ILineFragment[],
  policy: ComparisonPolicy,
  allowNonSquashed: boolean,
  allowNonTrimed: boolean = false
): void {
  const lineOffsets1 = LineOffsetsImpl.create(text1);
  const lineOffsets2 = LineOffsetsImpl.create(text2);

  checkLineConsistency(text1, text2, lineOffsets1, lineOffsets2, fragments, allowNonSquashed);

  for (const fragment of fragments) {
    if (fragment.innerFragments !== undefined) {
      const sequence1 = text1.substring(fragment.startOffset1, fragment.endOffset1);
      const sequence2 = text2.substring(fragment.startOffset2, fragment.endOffset2);

      checkDiffConsistency(fragment.innerFragments);
      checkValidRanges(sequence1, sequence2, fragment.innerFragments, policy, false);
    }
  }

  checkValidRanges(text1, text2, fragments, policy, true);
  if (!allowNonTrimed) {
    checkCantTrimLines(
      text1,
      text2,
      lineOffsets1,
      lineOffsets2,
      fragments,
      policy,
      allowNonSquashed
    );
  }
}

//
// Three-side helpers
//

function mergeStart(fragment: IMergeLineFragment, side: ThreeSide): number {
  return fragment.getStartLine(side);
}

function mergeEnd(fragment: IMergeLineFragment, side: ThreeSide): number {
  return fragment.getEndLine(side);
}

function checkLineConsistency3(
  lineOffsets: readonly [ILineOffsets, ILineOffsets, ILineOffsets],
  fragments: readonly IMergeLineFragment[],
  allowNonSquashed: boolean
): void {
  const sides = [ThreeSide.LEFT, ThreeSide.BASE, ThreeSide.RIGHT];
  let lasts = [-1, -1, -1];

  for (const fragment of fragments) {
    let nonEmpty = false;
    let nonSquashed = false;
    for (let i = 0; i < 3; i++) {
      const start = mergeStart(fragment, sides[i]);
      const end = mergeEnd(fragment, sides[i]);

      assert.ok(start >= 0);
      assert.ok(end <= lineOffsets[i].lineCount);
      assert.ok(start <= end);
      nonEmpty = nonEmpty || start !== end;
      nonSquashed = nonSquashed || start !== lasts[i];
    }

    assert.ok(nonEmpty);
    assert.ok(allowNonSquashed || nonSquashed);

    lasts = sides.map((side) => mergeEnd(fragment, side));
  }
}

function checkValidRanges3(
  texts: readonly [string, string, string],
  lineOffsets: readonly [ILineOffsets, ILineOffsets, ILineOffsets],
  fragments: readonly IMergeLineFragment[],
  policy: ComparisonPolicy
): void {
  const ignoreSpaces = policy !== ComparisonPolicy.DEFAULT;
  const sides = [ThreeSide.LEFT, ThreeSide.BASE, ThreeSide.RIGHT];

  let lasts = [0, 0, 0];
  const checkGap = (starts: readonly number[]): void => {
    const contents = sides.map((_side, i) =>
      getLinesContent(texts[i], lineOffsets[i], lasts[i], starts[i])
    );
    assertEqualsCharSequences(contents[1], contents[0], ignoreSpaces, false);
    assertEqualsCharSequences(contents[1], contents[2], ignoreSpaces, false);
  };

  for (const fragment of fragments) {
    checkGap(sides.map((side) => mergeStart(fragment, side)));
    lasts = sides.map((side) => mergeEnd(fragment, side));
  }
  checkGap(lineOffsets.map((offsets) => offsets.lineCount));
}

function checkDiffConsistency3(fragments: readonly IMergeWordFragment[]): void {
  const sides = [ThreeSide.LEFT, ThreeSide.BASE, ThreeSide.RIGHT];
  let lasts = [-1, -1, -1];

  for (const fragment of fragments) {
    let nonEmpty = false;
    let nonSquashed = false;
    for (let i = 0; i < 3; i++) {
      const start = fragment.getStartOffset(sides[i]);
      const end = fragment.getEndOffset(sides[i]);
      assert.ok(start <= end);
      nonEmpty = nonEmpty || start !== end;
      nonSquashed = nonSquashed || start !== lasts[i];
    }
    assert.ok(nonEmpty);
    assert.ok(nonSquashed);

    lasts = sides.map((side) => fragment.getEndOffset(side));
  }
}

function checkValidWordRanges3(
  texts: readonly [string, string, string],
  fragments: readonly IMergeWordFragment[],
  policy: ComparisonPolicy
): void {
  const ignoreSpacesUnchanged = policy !== ComparisonPolicy.DEFAULT;
  const ignoreSpacesChanged = policy === ComparisonPolicy.IGNORE_WHITESPACES;
  const sides = [ThreeSide.LEFT, ThreeSide.BASE, ThreeSide.RIGHT];

  const changesSets = [new BitSet(), new BitSet(), new BitSet()];

  let lasts = [0, 0, 0];
  for (const fragment of fragments) {
    const starts = sides.map((side) => fragment.getStartOffset(side));
    const ends = sides.map((side) => fragment.getEndOffset(side));

    const gaps = texts.map((text, i) => text.substring(lasts[i], starts[i]));
    assertEqualsCharSequences(gaps[1], gaps[0], ignoreSpacesUnchanged, false);
    assertEqualsCharSequences(gaps[1], gaps[2], ignoreSpacesUnchanged, false);

    const chunks = texts.map((text, i) => text.substring(starts[i], ends[i]));
    assert.ok(
      !(
        isEqualsChunks(chunks[1], chunks[0], ignoreSpacesChanged) &&
        isEqualsChunks(chunks[1], chunks[2], ignoreSpacesChanged)
      ),
      'a changed merge chunk must differ from the base on some side'
    );

    for (let i = 0; i < 3; i++) {
      changesSets[i].setRange(starts[i], ends[i]);
    }

    lasts = ends;
  }

  const tails = texts.map((text, i) => text.substring(lasts[i]));
  assertEqualsCharSequences(tails[1], tails[0], ignoreSpacesUnchanged, false);
  assertEqualsCharSequences(tails[1], tails[2], ignoreSpacesUnchanged, false);

  for (let i = 0; i < 3; i++) {
    checkCodePoints(texts[i], changesSets[i]);
  }
}

function checkCantTrimLines3(
  texts: readonly [string, string, string],
  lineOffsets: readonly [ILineOffsets, ILineOffsets, ILineOffsets],
  fragments: readonly IMergeLineFragment[],
  policy: ComparisonPolicy
): void {
  const sides = [ThreeSide.LEFT, ThreeSide.BASE, ThreeSide.RIGHT];
  for (const fragment of fragments) {
    const sequences = sides.map((side, i) =>
      getFirstLastLines(
        texts[i],
        lineOffsets[i],
        mergeStart(fragment, side),
        mergeEnd(fragment, side)
      )
    );
    const [seq1, seq2, seq3] = sequences;
    if (seq1 === undefined || seq2 === undefined || seq3 === undefined) {
      continue;
    }

    assert.ok(!(isEqualTexts(seq2[0], seq1[0], policy) && isEqualTexts(seq2[0], seq3[0], policy)));
    assert.ok(!(isEqualTexts(seq2[1], seq1[1], policy) && isEqualTexts(seq2[1], seq3[1], policy)));
  }
}

function checkResultMerge(
  texts: readonly [string, string, string],
  fragments: readonly IMergeLineFragment[],
  policy: ComparisonPolicy,
  allowIgnoredBlocks: boolean
): void {
  const lineOffsets = [
    LineOffsetsImpl.create(texts[0]),
    LineOffsetsImpl.create(texts[1]),
    LineOffsetsImpl.create(texts[2]),
  ] as const;

  checkLineConsistency3(lineOffsets, fragments, allowIgnoredBlocks);
  checkValidRanges3(texts, lineOffsets, fragments, policy);
  if (!allowIgnoredBlocks) {
    checkCantTrimLines3(texts, lineOffsets, fragments, policy);
  }

  const sides = [ThreeSide.LEFT, ThreeSide.BASE, ThreeSide.RIGHT];
  for (const fragment of fragments) {
    const chunks = sides.map((side, i) =>
      getLinesContent(
        texts[i],
        lineOffsets[i],
        mergeStart(fragment, side),
        mergeEnd(fragment, side)
      )
    ) as unknown as readonly [string, string, string];

    const wordFragments = ByWordRt.compareThreeside(
      chunks[0],
      chunks[1],
      chunks[2],
      policy,
      CANCELLATION
    );
    checkDiffConsistency3(wordFragments);
    checkValidWordRanges3(chunks, wordFragments, policy);
  }
}

describe('diff-engine randomized comparison properties (ComparisonUtilAutoTest)', () => {
  before(() => {
    setVerifyEnabled(true);
  });

  after(() => {
    setVerifyEnabled(false);
  });

  it('by-char fragments are consistent and reconstruct the texts', () => {
    fc.assert(
      fc.property(textPairArb, ([text1, text2]) => {
        for (const policy of POLICIES) {
          const fragments = ComparisonManager.compareChars(text1, text2, policy, CANCELLATION);
          checkDiffConsistency(fragments);
          checkValidRanges(text1, text2, fragments, policy, false);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('by-word fragments are consistent and reconstruct the texts', () => {
    fc.assert(
      fc.property(textPairArb, ([text1, text2]) => {
        for (const policy of POLICIES) {
          const fragments = ComparisonManager.compareWords(text1, text2, policy, CANCELLATION);
          checkDiffConsistency(fragments);
          checkValidRanges(text1, text2, fragments, policy, false);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('by-line fragments with inner word/char fragments hold the line invariants', () => {
    fc.assert(
      fc.property(textPairArb, ([text1, text2]) => {
        for (const policy of POLICIES) {
          for (const fragmentsPolicy of ['WORDS', 'CHARS'] as const) {
            const fragments = ComparisonManager.compareLinesInner(
              text1,
              text2,
              policy,
              CANCELLATION,
              fragmentsPolicy
            );
            checkResultLine(text1, text2, fragments, policy, true);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('squashed line fragments stay consistent', () => {
    fc.assert(
      fc.property(textPairArb, ([text1, text2]) => {
        for (const policy of POLICIES) {
          for (const fragmentsPolicy of ['WORDS', 'CHARS'] as const) {
            const fragments = ComparisonManager.compareLinesInner(
              text1,
              text2,
              policy,
              CANCELLATION,
              fragmentsPolicy
            );
            const squashed = ComparisonManager.squash(fragments);
            checkResultLine(text1, text2, squashed, policy, false);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('trimmed and squashed line fragments stay consistent', () => {
    fc.assert(
      fc.property(textPairArb, ([text1, text2]) => {
        for (const policy of POLICIES) {
          for (const fragmentsPolicy of ['WORDS', 'CHARS'] as const) {
            const fragments = ComparisonManager.compareLinesInner(
              text1,
              text2,
              policy,
              CANCELLATION,
              fragmentsPolicy
            );
            const processed = ComparisonManager.processBlocks(
              fragments,
              text1,
              text2,
              policy,
              true,
              true
            );
            checkResultLine(text1, text2, processed, policy, false);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('words-first line fragments hold the line invariants', () => {
    fc.assert(
      fc.property(textPairArb, ([text1, text2]) => {
        for (const policy of POLICIES) {
          const lineOffsets1 = LineOffsetsImpl.create(text1);
          const lineOffsets2 = LineOffsetsImpl.create(text2);
          const fragments = ComparisonManager.compareLinesWordFirst(
            text1,
            text2,
            lineOffsets1,
            lineOffsets2,
            policy,
            CANCELLATION
          );
          const processed = ComparisonManager.processBlocks(
            fragments,
            text1,
            text2,
            policy,
            true,
            true
          );
          // we do not consider 'x x' and 'xx' identical lines
          checkResultLine(
            text1,
            text2,
            processed,
            policy,
            true,
            policy === ComparisonPolicy.IGNORE_WHITESPACES
          );
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('three-way line diff holds the merge invariants', () => {
    fc.assert(
      fc.property(textPairArb, ([text1, text2]) => {
        for (const policy of POLICIES) {
          const texts = [text1, text2, text2] as const;
          const fragments = ComparisonManager.compareLinesThreeside(
            texts[0],
            texts[1],
            texts[2],
            policy,
            CANCELLATION
          );
          checkResultMerge(texts, fragments, policy, false);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('both LCS algorithms pair up only truly equal elements', () => {
    const intsArb = fc.array(fc.integer({ min: 0, max: 60 }), { maxLength: 100, size: 'max' });
    fc.assert(
      fc.property(intsArb, intsArb, (ints1, ints2) => {
        for (const algorithm of ['myers', 'patience'] as const) {
          let changes: readonly [BitSet, BitSet];
          if (algorithm === 'myers') {
            const lcs = new MyersLCS(ints1, ints2);
            lcs.execute();
            changes = lcs.changes;
          } else {
            const lcs = new PatienceIntLCS(ints1, ints2);
            lcs.execute();
            changes = lcs.changes;
          }

          // walk the unchanged elements in lockstep: they must match pairwise and
          // both sides must run out together
          let index1 = changes[0].nextClearBit(0);
          let index2 = changes[1].nextClearBit(0);
          while (index1 < ints1.length || index2 < ints2.length) {
            assert.ok(index1 < ints1.length && index2 < ints2.length, 'unpaired unchanged element');
            assert.strictEqual(ints1[index1], ints2[index2]);
            index1 = changes[0].nextClearBit(index1 + 1);
            index2 = changes[1].nextClearBit(index2 + 1);
          }
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });

  it('three-way line merge holds the merge invariants', () => {
    fc.assert(
      fc.property(textPairArb, ([text1, text2]) => {
        for (const policy of POLICIES) {
          const texts = [text1, text2, text2] as const;
          const fragments = ComparisonManager.mergeLines(
            texts[0],
            texts[1],
            texts[2],
            policy,
            CANCELLATION
          );
          checkResultMerge(texts, fragments, policy, policy !== ComparisonPolicy.DEFAULT);
        }
      }),
      { numRuns: NUM_RUNS }
    );
  });
});
