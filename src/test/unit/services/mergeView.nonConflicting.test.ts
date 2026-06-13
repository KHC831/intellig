/**
 * Unit tests for "Apply all non-conflicting changes from Left/Right".
 *
 * The pure helpers (`identifyNonConflictingConflicts`,
 * `identifyNonConflictingHunks`) are exercised here; the MergeView methods
 * delegate to them, so the end-to-end auto-resolve behaviour follows.
 */

import '../../setup';
import * as assert from 'assert';
import {
  identifyNonConflictingConflicts,
  identifyNonConflictingHunks,
} from '../../../conflicts/MergeView';

describe('identifyNonConflictingConflicts', () => {
  // Shape matching IConflictRegion in the production code, but only the
  // fields the helper reads.
  type TestConflict = {
    id: number;
    resolved: boolean;
    baseContent: string;
    currentContent: string;
    incomingContent: string;
  };
  const C = (
    id: number,
    baseContent: string,
    currentContent: string,
    incomingContent: string,
    resolved = false
  ): TestConflict => ({ id, resolved, baseContent, currentContent, incomingContent });

  it('diff3: left-only change → resolvable from LEFT', () => {
    // Incoming matches base → only left changed.
    const ids = identifyNonConflictingConflicts([C(0, 'x', 'y', 'x')], 'left');
    assert.deepStrictEqual(ids, [0]);
  });

  it('diff3: right-only change → resolvable from RIGHT', () => {
    const ids = identifyNonConflictingConflicts([C(0, 'x', 'x', 'y')], 'right');
    assert.deepStrictEqual(ids, [0]);
  });

  it('diff3: both-sided change → NOT resolvable from either side', () => {
    assert.deepStrictEqual(identifyNonConflictingConflicts([C(0, 'x', 'a', 'b')], 'left'), []);
    assert.deepStrictEqual(identifyNonConflictingConflicts([C(0, 'x', 'a', 'b')], 'right'), []);
  });

  it('diff2 (no base): left-only addition → resolvable from LEFT', () => {
    const ids = identifyNonConflictingConflicts([C(0, '', 'new line', '')], 'left');
    assert.deepStrictEqual(ids, [0]);
  });

  it('diff2 (no base): right-only addition → resolvable from RIGHT', () => {
    const ids = identifyNonConflictingConflicts([C(0, '', '', 'new line')], 'right');
    assert.deepStrictEqual(ids, [0]);
  });

  it('diff2 (no base): both sides non-empty → NOT resolvable', () => {
    // Without base we can't tell if the change is benign; leave alone.
    assert.deepStrictEqual(identifyNonConflictingConflicts([C(0, '', 'a', 'b')], 'left'), []);
    assert.deepStrictEqual(identifyNonConflictingConflicts([C(0, '', 'a', 'b')], 'right'), []);
  });

  it('skips already-resolved conflicts', () => {
    const ids = identifyNonConflictingConflicts([C(0, 'x', 'y', 'x', /*resolved*/ true)], 'left');
    assert.deepStrictEqual(ids, []);
  });

  it('handles mixed sets correctly', () => {
    const conflicts: TestConflict[] = [
      C(0, 'x', 'y', 'x'), // left-only
      C(1, 'x', 'x', 'z'), // right-only
      C(2, 'x', 'a', 'b'), // both
      C(3, '', 'new', ''), // diff2 left-only
    ];
    assert.deepStrictEqual(identifyNonConflictingConflicts(conflicts, 'left'), [0, 3]);
    assert.deepStrictEqual(identifyNonConflictingConflicts(conflicts, 'right'), [1]);
  });
});

describe('identifyNonConflictingHunks (marker-text parser)', () => {
  it('parses a single diff3 conflict and reports left-only', () => {
    const text = [
      'line one',
      '<<<<<<< HEAD',
      'left change',
      '||||||| base',
      'base',
      '=======',
      'base',
      '>>>>>>> feature',
      'line three',
    ].join('\n');
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'left'), [0]);
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'right'), []);
  });

  it('parses a single diff3 conflict and reports right-only', () => {
    const text = [
      '<<<<<<< HEAD',
      'base',
      '||||||| base',
      'base',
      '=======',
      'right change',
      '>>>>>>> feature',
    ].join('\n');
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'right'), [0]);
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'left'), []);
  });

  it('parses multiple conflicts and classifies each', () => {
    const text = [
      '<<<<<<< HEAD',
      'left-A',
      '||||||| base',
      'base-A',
      '=======',
      'base-A',
      '>>>>>>> f',
      'middle',
      '<<<<<<< HEAD',
      'same',
      '||||||| base',
      'same',
      '=======',
      'right-B',
      '>>>>>>> f',
    ].join('\n');
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'left'), [0]);
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'right'), [1]);
  });

  it('diff2 marker (no base) — both-sided treated as conflicting', () => {
    const text = ['<<<<<<< HEAD', 'left', '=======', 'right', '>>>>>>> f'].join('\n');
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'left'), []);
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'right'), []);
  });

  it('diff2 marker — left-only addition (empty right)', () => {
    const text = ['<<<<<<< HEAD', 'added locally', '=======', '>>>>>>> f'].join('\n');
    assert.deepStrictEqual(identifyNonConflictingHunks(text, 'left'), [0]);
  });

  it('text with no markers → empty result', () => {
    assert.deepStrictEqual(identifyNonConflictingHunks('line 1\nline 2', 'left'), []);
    assert.deepStrictEqual(identifyNonConflictingHunks('', 'right'), []);
  });
});
