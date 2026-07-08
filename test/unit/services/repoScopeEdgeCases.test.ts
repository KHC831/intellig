import '../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../src/ui-shell/GitToolWindowProvider';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';
import type { RepositoryScopeSelection } from '../../../src/registration/wiring';

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

function handleSingle(p: GitToolWindowProvider, s: number | 'all'): void {
  (
    p as unknown as { _handleRepositorySelection(s: number | 'all'): void }
  )._handleRepositorySelection(s);
}
function handleSubset(p: GitToolWindowProvider, r: string[]): void {
  (
    p as unknown as { _handleVisibleRepositoriesSelection(r: string[]): void }
  )._handleVisibleRepositoriesSelection(r);
}

describe('Repository scope edge cases', () => {
  it('preserves an explicit "all" scope across an empty-then-refill (close/reopen all folders)', () => {
    const p = new GitToolWindowProvider(Uri.file('/x'));
    p.setAvailableRepositories([makeRepo(a), makeRepo(b), makeRepo(c)]);
    handleSingle(p, 'all');
    assert.strictEqual(p.isAllReposSelected(), true, 'explicitly merged');

    p.setAvailableRepositories([]); // all folders closed
    p.setAvailableRepositories([makeRepo(a), makeRepo(b), makeRepo(c)]); // reopened

    assert.strictEqual(
      p.isAllReposSelected(),
      true,
      'merged scope must survive the workspace emptying and refilling'
    );
    p.dispose();
  });

  it('narrows a subset to the single-repo scope when it shrinks to one surviving root', () => {
    const p = new GitToolWindowProvider(Uri.file('/x'));
    p.setAvailableRepositories([makeRepo(a), makeRepo(b), makeRepo(c)]);
    handleSubset(p, [a, b]); // subset excludes C
    assert.deepStrictEqual(p.getVisibleRepoRoots(), [a, b]);

    const events: RepositoryScopeSelection[] = [];
    p.onDidChangeRepositoryScope((e) => events.push(e));

    // Remove A; only B survives the subset while C is still present.
    p.setAvailableRepositories([makeRepo(b), makeRepo(c)]);

    assert.deepStrictEqual(
      events.map((e) => (e.kind === 'repository' ? e.repository.rootUri.fsPath : e.kind)),
      [b],
      'the collapse to single-repo B is announced so the log + branch tree re-route'
    );

    // Single-repo scope on B (not merged 'all'): the log/branch wiring routes to
    // [B] alone, so the excluded C never reappears in the view. (getVisibleRepositories
    // is only consulted in 'all' scope, so it is not the display truth here.)
    assert.strictEqual(p.isAllReposSelected(), false, 'collapses to single-repo scope, not merged');
    assert.strictEqual(p.getVisibleRepoRoots(), null, 'no lingering subset');
    assert.strictEqual(p.getSelectedRepository()?.rootUri.fsPath, b, 'B is the scoped repo');
    p.dispose();
  });
});
