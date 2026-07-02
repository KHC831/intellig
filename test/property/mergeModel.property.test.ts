// Ported from intellij-community platform/diff-impl/tests/testSrc/com/intellij/diff/merge/MergeAutoTest.kt
// (the seeded-random undo tests, re-expressed on fast-check).
// Copyright 2000-2025 JetBrains s.r.o. Apache 2.0 license.
//
// For any generated left/base/right texts and any sequence of random actions
// (apply side, ignore side, try auto-resolve, edit the result text), the merge
// model must keep changes ordered by result range, and undoing/redoing each
// action cycle must restore the full state (text + ranges + resolved flags)
// exactly.

import * as fc from 'fast-check';
import * as assert from 'assert';
import { ComparisonPolicy } from '../../src/diff-engine/comparison/ComparisonPolicy';
import { Side } from '../../src/diff-engine/util/Side';
import { ThreeSide } from '../../src/diff-engine/util/ThreeSide';
import { TextMergeChange } from '../../src/conflicts/merge-model/TextMergeChange';
import { MergeTestBuilder, doTest } from '../unit/merge-model/mergeTestUtil';

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

const NUM_RUNS = 25;
const MAX_TEXT_LENGTH = 300;
const MODIFICATION_CYCLE_COUNT = 5;
const MODIFICATION_CYCLE_SIZE = 3;

// DiffTestCase.generateText char table (no '_': doTest parses '_' as a newline).
const CHARS = [NL, NL, TAB, ' ', ' ', '.', '<', '!', 'i', 'j', 'k', 'l'];

function textArb(maxLength: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...CHARS), { size: 'max', maxLength })
    .map((chars) => chars.join(''));
}

interface IFuzzOp {
  readonly kind: number;
  readonly pick: number;
  readonly side: boolean;
  readonly modifier: boolean;
  readonly i1: number;
  readonly i2: number;
  readonly text: string;
}

const opArb: fc.Arbitrary<IFuzzOp> = fc.record({
  kind: fc.integer({ min: 0, max: 3 }),
  pick: fc.nat(),
  side: fc.boolean(),
  modifier: fc.boolean(),
  i1: fc.nat(),
  i2: fc.nat(),
  text: textArb(30),
});

const cyclesArb = fc.array(
  fc.array(opArb, { minLength: MODIFICATION_CYCLE_SIZE, maxLength: MODIFICATION_CYCLE_SIZE }),
  { minLength: MODIFICATION_CYCLE_COUNT, maxLength: MODIFICATION_CYCLE_COUNT }
);

function runOp(t: MergeTestBuilder, op: IFuzzOp): void {
  const changes = t.changes;
  switch (op.kind) {
    case 0: {
      const change = changes[op.pick % changes.length];
      const side = Side.fromLeft(op.side);
      t.command(change, () => t.model.replaceChange(change.index, side, op.modifier));
      break;
    }
    case 1: {
      const change = changes[op.pick % changes.length];
      const side = Side.fromLeft(op.side);
      t.command(change, () => t.model.ignoreChange(change.index, side, op.modifier));
      break;
    }
    case 2: {
      const change = changes[op.pick % changes.length];
      t.command(change, () => {
        t.model.resolveChangeAutomatically(change.index, ThreeSide.BASE);
      });
      break;
    }
    case 3: {
      const length = t.document.textLength;
      let index1 = 0;
      let index2 = 0;
      if (length !== 0) {
        index1 = op.i1 % length;
        index2 = index1 + (op.i2 % (length - index1));
      }
      const oldText = t.document.getText().substring(index1, index2);

      let newText = op.text;
      // Ensure non-identical modification
      if (newText === oldText) {
        newText += '?';
      }

      t.write(() => t.document.replaceString(index1, index2, newText));
      break;
    }
    default:
      throw new Error(`unexpected op kind: ${op.kind}`);
  }
}

function checkChangesRangeOrdering(changes: readonly TextMergeChange[]): void {
  for (let i = 1; i < changes.length; i++) {
    const lastEnd = changes[i - 1].getEndLine(ThreeSide.BASE);
    const start = changes[i].getStartLine(ThreeSide.BASE);
    assert.ok(lastEnd <= start, `lastEnd: ${lastEnd}, start: ${start}`);
  }
}

function doUndoTest(policy: ComparisonPolicy): void {
  fc.assert(
    fc.property(
      textArb(MAX_TEXT_LENGTH),
      textArb(MAX_TEXT_LENGTH),
      textArb(MAX_TEXT_LENGTH),
      cyclesArb,
      (text1, text2, text3, cycles) => {
        doTest(text1, text2, text3, -1, policy, (t) => {
          if (t.changes.length === 0) {
            assert.strictEqual(text1, text2);
            assert.strictEqual(text1, text3);
            assert.strictEqual(text2, text3);
            return;
          }

          for (const cycle of cycles) {
            t.checkUndo(MODIFICATION_CYCLE_SIZE, () => {
              for (const op of cycle) {
                runOp(t, op);
                checkChangesRangeOrdering(t.changes);
              }
            });
          }
        });
      }
    ),
    { numRuns: NUM_RUNS }
  );
}

describe('merge model auto tests (MergeAutoTest)', function () {
  this.timeout(60000);

  it('undo - default policy', () => {
    doUndoTest(ComparisonPolicy.DEFAULT);
  });

  it('undo - trim whitespaces', () => {
    doUndoTest(ComparisonPolicy.TRIM_WHITESPACES);
  });

  it('undo - ignore whitespaces', () => {
    doUndoTest(ComparisonPolicy.IGNORE_WHITESPACES);
  });
});
