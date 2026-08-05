/**
 * Effect-order characterization for `setAvailableRepositories`, pinned ahead
 * of its extraction into RepoScopeModel: subscribers must see the two events
 * in a fixed order, and the cold population must stay silent on the scope
 * channel. Behavioral (listener-recorded), so the pin survives the method
 * moving between files.
 */

import '../../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../../mocks/vscode';
import type { IRepository } from '../../../../src/git-core/interfaces/IGitService';

function makeRepo(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}
const a = '/work/alpha';
const b = '/work/beta';
const c = '/work/gamma';

function handleSubset(p: GitToolWindowProvider, r: string[]): void {
  (
    p as unknown as { _handleVisibleRepositoriesSelection(r: string[]): void }
  )._handleVisibleRepositoriesSelection(r);
}

describe('setAvailableRepositories effect order', () => {
  it('fires onDidChangeState BEFORE onDidChangeRepositoryScope on a scope-changing update', () => {
    const p = new GitToolWindowProvider(Uri.file('/x'));
    p.setAvailableRepositories([makeRepo(a), makeRepo(b), makeRepo(c)]);
    handleSubset(p, [a, b]);

    const order: string[] = [];
    p.onDidChangeState(() => order.push('state'));
    p.onDidChangeRepositoryScope(() => order.push('scope'));

    // Removing A shrinks the visible subset to B alone, which collapses the
    // scope to that single repo — a real scope transition, so both fire.
    p.setAvailableRepositories([makeRepo(b), makeRepo(c)]);

    assert.deepStrictEqual(
      order,
      ['state', 'scope'],
      'scope subscribers re-route eagerly and must observe "state changed" first'
    );
    p.dispose();
  });

  it('stays silent on the scope channel during the cold population', () => {
    const p = new GitToolWindowProvider(Uri.file('/x'));

    const order: string[] = [];
    p.onDidChangeState(() => order.push('state'));
    p.onDidChangeRepositoryScope(() => order.push('scope'));

    p.setAvailableRepositories([makeRepo(a), makeRepo(b)]);

    assert.deepStrictEqual(
      order,
      ['state'],
      'the branch tree already defaults to "all"; the initial population must not fire scope'
    );
    p.dispose();
  });
});
