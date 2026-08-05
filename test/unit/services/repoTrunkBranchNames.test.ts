/**
 * The tool window derives the graph's trunk (mainline) branch names from the
 * in-scope repositories' detected default branch, so a repo that follows a
 * non-standard default (e.g. `develop`) colors that branch as the trunk.
 */

import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

function makeRepo(rootPath: string, defaultBranch?: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
    ...(defaultBranch ? { defaultBranch } : {}),
  } as unknown as IRepository;
}

function trunk(p: GitToolWindowProvider): string[] {
  return p.repoScope.trunkBranchNamesForScope().sort();
}
function selectSingle(p: GitToolWindowProvider, i: number): void {
  p.repoScope.handleRepositorySelection(i);
}

describe('Trunk branch names for the graph coloring scope', () => {
  it('single-repo scope uses the selected repo default', () => {
    const p = new GitToolWindowProvider(Uri.file('/x'));
    p.setAvailableRepositories([makeRepo('/a', 'develop'), makeRepo('/b', 'main')]);
    selectSingle(p, 0);
    assert.deepStrictEqual(trunk(p), ['develop']);
    selectSingle(p, 1);
    assert.deepStrictEqual(trunk(p), ['main']);
    p.dispose();
  });

  it('merged scope unions the in-scope repo defaults', () => {
    const p = new GitToolWindowProvider(Uri.file('/x'));
    p.setAvailableRepositories([
      makeRepo('/a', 'develop'),
      makeRepo('/b', 'main'),
      makeRepo('/c', 'main'),
    ]);
    p.repoScope.handleRepositorySelection('all');
    assert.deepStrictEqual(trunk(p), ['develop', 'main'], 'union, de-duplicated');
    p.dispose();
  });

  it('is empty when no in-scope repo reports a default (coloring falls back to main/master)', () => {
    const p = new GitToolWindowProvider(Uri.file('/x'));
    p.setAvailableRepositories([makeRepo('/a'), makeRepo('/b')]);
    p.repoScope.handleRepositorySelection('all');
    assert.deepStrictEqual(trunk(p), []);
    p.dispose();
  });
});
