/**
 * Unit tests for wireFetchReload: every successful fetch that advanced refs
 * must reload the fetched repository so onDidChangeRepository reaches the
 * branch tree / graph even when the .git watcher misses the ref writes.
 */

import '../../setup';
import * as assert from 'assert';
import { IRepository, IFetchResult } from '../../../src/git-core/interfaces/IGitService';
import { wireFetchReload } from '../../../src/sync/fetchReloadBridge';
import { EventEmitter, Uri } from '../../mocks/vscode';

function makeRepo(path: string = '/r1'): IRepository {
  return {
    rootUri: Uri.file(path),
    state: 'idle',
    head: { name: 'refs/heads/main' },
    remotes: [],
  } as unknown as IRepository;
}

function makeHarness(): {
  fire: (repo: IRepository, result: IFetchResult) => void;
  reloadCalls: IRepository[];
  gitService: Parameters<typeof wireFetchReload>[0];
} {
  const fetchEmitter = new EventEmitter<{ repo: IRepository; result: IFetchResult }>();
  const reloadCalls: IRepository[] = [];
  return {
    fire: (repo, result) => fetchEmitter.fire({ repo, result }),
    reloadCalls,
    gitService: {
      onDidFetch: fetchEmitter.event,
      reloadRepository: (repo: IRepository) => {
        reloadCalls.push(repo);
        return Promise.resolve(repo);
      },
    },
  };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('wireFetchReload', () => {
  it('reloads the fetched repo when the fetch updated refs', async () => {
    const h = makeHarness();
    const disposable = wireFetchReload(h.gitService);
    const repo = makeRepo();

    h.fire(repo, {
      updatedRefs: [
        { ref: 'refs/remotes/origin/main', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
      ],
      errors: [],
    });
    await flush();

    assert.deepStrictEqual(h.reloadCalls, [repo]);
    disposable.dispose();
  });

  it('does not reload on a fetch that updated nothing', async () => {
    const h = makeHarness();
    const disposable = wireFetchReload(h.gitService);

    h.fire(makeRepo(), { updatedRefs: [], errors: [] });
    await flush();

    assert.strictEqual(h.reloadCalls.length, 0);
    disposable.dispose();
  });

  it('stops reloading once disposed', async () => {
    const h = makeHarness();
    const disposable = wireFetchReload(h.gitService);
    disposable.dispose();

    h.fire(makeRepo(), {
      updatedRefs: [
        { ref: 'refs/remotes/origin/main', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
      ],
      errors: [],
    });
    await flush();

    assert.strictEqual(h.reloadCalls.length, 0);
  });

  it('reloads per repo in a multi-repo fetch burst', async () => {
    const h = makeHarness();
    const disposable = wireFetchReload(h.gitService);
    const r1 = makeRepo('/r1');
    const r2 = makeRepo('/r2');
    const updated = {
      updatedRefs: [
        { ref: 'refs/remotes/origin/main', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40) },
      ],
      errors: [],
    };

    h.fire(r1, updated);
    h.fire(r2, { updatedRefs: [], errors: [] });
    await flush();

    assert.deepStrictEqual(h.reloadCalls, [r1]);
    disposable.dispose();
  });
});
