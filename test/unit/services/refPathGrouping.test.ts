/**
 * The one path-folding rule, tested directly.
 *
 * `partitionRefsByPathSegment` is what makes `feature/auth` and
 * `release/2026/08/17` nest, and it is shared by local branches, remote
 * branches and tags so the three cannot drift. git4idea does the same: one
 * `groupByPrefix` fed by a `RefsCollection` of all three kinds
 * (`NodeDescriptorsModel.buildTreeNodes`).
 */

import '../../setup';
import * as assert from 'assert';
import { partitionRefsByPathSegment } from '../../../src/branches/refPathGrouping';

const refs = (...names: string[]): Array<{ name: string }> => names.map((name) => ({ name }));

describe('partitionRefsByPathSegment', () => {
  it('splits leaves from folders at the current level', () => {
    const { folders, leaves } = partitionRefsByPathSegment(
      refs('main', 'feature/auth', 'feature/billing'),
      '',
      undefined
    );
    assert.deepStrictEqual(
      folders.map((f) => f.segment),
      ['feature']
    );
    assert.deepStrictEqual(
      leaves.map((l) => l.ref.name),
      ['main']
    );
  });

  it('collapses many refs sharing a segment into ONE folder', () => {
    const { folders } = partitionRefsByPathSegment(
      refs('release/1.0', 'release/2.0', 'release/3.0'),
      '',
      undefined
    );
    assert.strictEqual(folders.length, 1);
    assert.strictEqual(folders[0].segment, 'release');
  });

  it('builds the child path by appending to the walked path', () => {
    const { folders } = partitionRefsByPathSegment(
      refs('release/2026/08/17'),
      'release/2026',
      undefined
    );
    assert.deepStrictEqual(folders, [{ segment: '08', childPath: 'release/2026/08' }]);
  });

  it('labels a leaf with its trailing segment while the ref keeps its full name', () => {
    const { leaves } = partitionRefsByPathSegment(
      refs('release/2026/08/17'),
      'release/2026/08',
      undefined
    );
    assert.strictEqual(leaves[0].displayName, '17');
    assert.strictEqual(leaves[0].ref.name, 'release/2026/08/17');
  });

  it('drops refs that do not live under the walked path', () => {
    const { folders, leaves } = partitionRefsByPathSegment(
      refs('feature/auth', 'hotfix/urgent'),
      'feature',
      undefined
    );
    assert.deepStrictEqual(folders, []);
    assert.deepStrictEqual(
      leaves.map((l) => l.ref.name),
      ['feature/auth']
    );
  });

  it('strips the remote prefix before folding', () => {
    const { folders, leaves } = partitionRefsByPathSegment(
      refs('origin/main', 'origin/feature/auth', 'upstream/main'),
      '',
      'origin'
    );
    assert.deepStrictEqual(
      folders.map((f) => f.segment),
      ['feature']
    );
    assert.deepStrictEqual(
      leaves.map((l) => l.ref.name),
      ['origin/main'],
      "another remote's branches belong to that remote's folder, not this one"
    );
  });

  it('sorts folders and leaves alphabetically, independent of input order', () => {
    const { folders, leaves } = partitionRefsByPathSegment(
      refs('zeta', 'beta/one', 'alpha', 'alpha/two'),
      '',
      undefined
    );
    assert.deepStrictEqual(
      folders.map((f) => f.segment),
      ['alpha', 'beta']
    );
    assert.deepStrictEqual(
      leaves.map((l) => l.ref.name),
      ['alpha', 'zeta']
    );
  });

  it('treats a ref that exactly equals the walked path as neither folder nor leaf', () => {
    // `alpha` is both a branch and a folder holding `alpha/two`. The folder
    // level for `alpha` must not list `alpha` itself as an empty-named child.
    const { folders, leaves } = partitionRefsByPathSegment(
      refs('alpha', 'alpha/two'),
      'alpha',
      undefined
    );
    assert.deepStrictEqual(folders, []);
    assert.deepStrictEqual(
      leaves.map((l) => l.displayName),
      ['two']
    );
  });

  it('returns nothing for an empty ref list', () => {
    const { folders, leaves } = partitionRefsByPathSegment([], '', undefined);
    assert.deepStrictEqual(folders, []);
    assert.deepStrictEqual(leaves, []);
  });
});
