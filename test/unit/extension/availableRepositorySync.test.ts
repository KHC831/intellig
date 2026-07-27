/**
 * Wiring test for `wireAvailableRepositorySync`.
 *
 * The Git tool window's available-repository list must follow GitService's
 * authoritative repository set — which includes NESTED repos discovered
 * asynchronously after a workspace folder is added. The old registerViews
 * `onDidChangeWorkspaceFolders` listener re-resolved the folder root with a
 * one-shot `getRepository(folder.uri)` (root-only) and read `getRepositories()`
 * before GitService's own nested discovery finished, so the provider could
 * momentarily miss nested repos with no later correction.
 *
 * `wireAvailableRepositorySync` instead derives the list from GitService's
 * `getRepositories()` on every `onDidChangeRepository` / `onDidRemoveRepository`
 * and pushes it every time. Whether the push is worth a repaint is the
 * provider's decision, taken against the state the document actually shows;
 * a caller-side skip would also skip the STORE, leaving superseded repository
 * objects wired into the action paths that read the stored array.
 */

import '../../setup';
import * as assert from 'assert';
import { wireAvailableRepositorySync } from '../../../src/extension';
import { EventEmitter, Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

function repoAt(p: string): IRepository {
  return {
    rootUri: Uri.file(p),
    state: 'idle',
    head: { name: 'main', commit: 'a'.repeat(40), ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

function makeHarness(initial: IRepository[]) {
  let repos = [...initial];
  const changeEmitter = new EventEmitter<IRepository>();
  const removeEmitter = new EventEmitter<IRepository>();
  const setCalls: IRepository[][] = [];

  const gitService = {
    getRepositories: () => repos,
    onDidChangeRepository: changeEmitter.event,
    onDidRemoveRepository: removeEmitter.event,
  };
  const provider = {
    setAvailableRepositories: (r: IRepository[]): void => {
      setCalls.push(r);
    },
  };

  return {
    gitService,
    provider,
    setCalls,
    setRepos: (r: IRepository[]): void => {
      repos = r;
    },
    fireChange: (r: IRepository): void => changeEmitter.fire(r),
    fireRemove: (r: IRepository): void => removeEmitter.fire(r),
  };
}

describe('wireAvailableRepositorySync', () => {
  it('pushes the full nested-aware repo set when discovery adds a repo', () => {
    const root = repoAt('/ws/root');
    const h = makeHarness([root]);

    const disposables = wireAvailableRepositorySync({
      provider: h.provider,
      gitService: h.gitService,
    });

    // GitService asynchronously discovers a NESTED repo and fires the change.
    const nested = repoAt('/ws/root/packages/inner');
    h.setRepos([root, nested]);
    h.fireChange(nested);

    assert.strictEqual(h.setCalls.length, 1, 'set must update once the nested repo appears');
    assert.deepStrictEqual(
      h.setCalls[0].map((r) => r.rootUri.fsPath),
      [root, nested].map((r) => r.rootUri.fsPath),
      'provider receives the full set including the nested repo'
    );

    disposables.forEach((d) => {
      d.dispose();
    });
  });

  it('pushes on an unchanged root set too, so the provider gets the current objects', () => {
    const root = repoAt('/ws/root');
    const h = makeHarness([root]);

    const disposables = wireAvailableRepositorySync({
      provider: h.provider,
      gitService: h.gitService,
    });

    // A commit/checkout fires onDidChangeRepository with the same ROOT SET but
    // a REPLACED repository object — GitService rebuilds these on reload, and
    // the stored array feeds action paths, not just the render. Skipping the
    // push here would freeze the superseded object into those paths. Deciding
    // whether any of this is worth a repaint belongs to the provider, which
    // compares the state the document actually shows.
    const reloaded = repoAt('/ws/root');
    h.setRepos([reloaded]);
    h.fireChange(reloaded);

    assert.strictEqual(
      h.setCalls.length,
      1,
      'the replaced repository object must reach the provider'
    );
    assert.strictEqual(
      h.setCalls[0][0],
      reloaded,
      'the provider must receive the current object, not the one it superseded'
    );

    disposables.forEach((d) => {
      d.dispose();
    });
  });

  it('pushes the shrunk set when a repository is removed', () => {
    const a = repoAt('/ws/a');
    const b = repoAt('/ws/b');
    const h = makeHarness([a, b]);

    const disposables = wireAvailableRepositorySync({
      provider: h.provider,
      gitService: h.gitService,
    });

    h.setRepos([a]);
    h.fireRemove(b);

    assert.strictEqual(h.setCalls.length, 1);
    assert.deepStrictEqual(
      h.setCalls[0].map((r) => r.rootUri.fsPath),
      [a.rootUri.fsPath],
      'provider receives the set with the removed repo dropped'
    );

    disposables.forEach((d) => {
      d.dispose();
    });
  });

  it('returns disposables that detach the listeners', () => {
    const root = repoAt('/ws/root');
    const h = makeHarness([root]);

    const disposables = wireAvailableRepositorySync({
      provider: h.provider,
      gitService: h.gitService,
    });
    disposables.forEach((d) => {
      d.dispose();
    });

    // After disposal, a discovery event must not reach the provider.
    h.setRepos([root, repoAt('/ws/root/inner')]);
    h.fireChange(root);
    assert.strictEqual(h.setCalls.length, 0, 'disposed listeners must not push to the provider');
  });
});
