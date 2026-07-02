// Ported from intellij-community platform/util/testSrc/com/intellij/util/diff/DiffTest.java
// Copyright 2000-2020 JetBrains s.r.o. Apache 2.0 license.

import '../../setup';
import * as assert from 'assert';
import { buildChanges } from '../../../src/diff-engine/diff/Diff';
import { checkChange, checkLastChange } from './intLCS.test';

const DATA_123 = ['1', '2', '3'];
const DATA_AB = ['a', 'b'];
const DATA_12AB23 = ['1', '2', 'a', 'b', '2', '3'];
const DATA_123_ = ['x', 'y', 'z', '1', '2', '3', 'alpha', 'beta'];
const DATA_12AB23_ = ['x', 'y', 'z', '1', '2', 'a', 'b', '2', '3', 'alpha', 'beta'];
const DATA_12nullABnull23 = ['1', '2', undefined, 'a', 'b', undefined, '2', '3'];
const DATA_null12AB23 = [undefined, '1', '2', 'a', 'b', '2', '3'];

describe('diff-engine buildChanges (DiffTest)', () => {
  it('equal', () => {
    assert.strictEqual(buildChanges(DATA_123, DATA_123), undefined);
  });

  it('completely different', () => {
    checkLastChange(buildChanges(DATA_AB, DATA_123), 0, 0, 3, 2);
  });

  it('same middle', () => {
    const change = buildChanges(DATA_123, ['a', '2', 'b']);
    checkChange(change, 0, 0, 1, 1);
    checkLastChange(change.link, 2, 2, 1, 1);
  });

  it('overlap', () => {
    checkLastChange(buildChanges(DATA_123, DATA_12AB23), 2, 2, 3, 0);
  });

  it('trim', () => {
    checkLastChange(buildChanges(DATA_123_, DATA_12AB23_), 5, 5, 3, 0);
  });

  it('equal up to one end', () => {
    checkLastChange(buildChanges(DATA_AB, ['a', 'b', '1']), 2, 2, 1, 0);
  });

  it('empty against something', () => {
    const empty: string[] = [];
    assert.strictEqual(buildChanges(empty, empty), undefined);
    checkLastChange(buildChanges(DATA_AB, empty), 0, 0, 0, 2);
    checkLastChange(buildChanges(empty, DATA_123), 0, 0, 3, 0);
  });

  it('nulls', () => {
    let change = buildChanges(DATA_12nullABnull23, DATA_null12AB23);
    let idx = 0;
    while (change !== undefined) {
      if (idx === 0) {
        checkChange(change, 0, 0, 1, 0);
      }
      if (idx === 1) {
        checkChange(change, 2, 3, 0, 1);
      }
      if (idx === 2) {
        checkChange(change, 5, 5, 0, 1);
      }
      change = change.link;
      idx++;
    }
    assert.strictEqual(idx, 3);
  });
});
