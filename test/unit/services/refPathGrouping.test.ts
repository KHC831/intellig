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
import { compareRefNames, partitionRefsByPathSegment } from '../../../src/branches/refPathGrouping';

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

  it('sorts folders and leaves by the SAME rule, case-insensitively', () => {
    // A bare .sort() orders by code unit, putting every capitalised name ahead
    // of every lowercase one, while localeCompare interleaves them. Using one
    // for folders and the other for leaves sorts halves of the same tree by
    // different rules: folders read Release, alpha; leaves read alpha, Release.
    const { folders, leaves } = partitionRefsByPathSegment(
      refs('Release/1.0', 'alpha/1.0', 'Beta/1.0', 'Zulu', 'apple', 'Mango'),
      '',
      undefined
    );
    assert.deepStrictEqual(
      folders.map((f) => f.segment),
      ['alpha', 'Beta', 'Release']
    );
    assert.deepStrictEqual(
      leaves.map((l) => l.ref.name),
      ['apple', 'Mango', 'Zulu']
    );
  });

  it('returns nothing for an empty ref list', () => {
    const { folders, leaves } = partitionRefsByPathSegment([], '', undefined);
    assert.deepStrictEqual(folders, []);
    assert.deepStrictEqual(leaves, []);
  });

  it('exports the comparator so a tree can sort its own headers by it', () => {
    // The remote GROUP headers of the Branches tree are sorted by their owner,
    // not by this function, and a bare .sort() there would order the headers by
    // code unit while everything nested under them used localeCompare.
    const remotes = ['origin', 'Upstream', 'fork', 'Backup'];
    assert.deepStrictEqual(
      remotes.slice().sort(compareRefNames),
      ['Backup', 'fork', 'origin', 'Upstream'],
      'one rule for headers and the refs beneath them'
    );
    assert.notDeepStrictEqual(
      remotes.slice().sort(compareRefNames),
      remotes.slice().sort(),
      'and it is genuinely different from a bare sort'
    );
  });
});
