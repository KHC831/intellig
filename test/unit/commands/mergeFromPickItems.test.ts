/**
 * Top-level "Merge…" front-door (IntelliJ Git.Merge, action.Git.Merge.text).
 *
 * The command picks a branch to merge into the current one. `buildMergeBranchPickItems`
 * is the pure list-builder behind the quick-pick: it offers local + remote
 * branches and excludes the current branch (you cannot merge a branch into
 * itself) and tags.
 */

import '../../setup';
import * as assert from 'assert';
import { buildMergeBranchPickItems } from '../../../src/commands/registration/branchCommands';
import { IBranch } from '../../../src/git-core/interfaces/IGitService';

function branch(name: string, type: IBranch['type'], isHead = false): IBranch {
  return { name, type, commit: 'deadbeef', isHead };
}

describe('buildMergeBranchPickItems', () => {
  it('excludes the current (HEAD) branch — cannot merge a branch into itself', () => {
    const items = buildMergeBranchPickItems([
      branch('main', 'local', true),
      branch('feature', 'local'),
    ]);
    const names = items.map((i) => i.branchName);
    assert.ok(!names.includes('main'), 'HEAD branch excluded');
    assert.ok(names.includes('feature'), 'other local branch offered');
  });

  it('excludes tags', () => {
    const items = buildMergeBranchPickItems([branch('v1.0.0', 'tag'), branch('feature', 'local')]);
    assert.deepStrictEqual(
      items.map((i) => i.branchName),
      ['feature']
    );
  });

  it('offers remote branches as merge sources', () => {
    const items = buildMergeBranchPickItems([
      branch('main', 'local', true),
      branch('origin/feature', 'remote'),
    ]);
    assert.deepStrictEqual(
      items.map((i) => i.branchName),
      ['origin/feature']
    );
  });

  it('returns an empty list when only the current branch exists', () => {
    const items = buildMergeBranchPickItems([branch('main', 'local', true)]);
    assert.strictEqual(items.length, 0);
  });
});
