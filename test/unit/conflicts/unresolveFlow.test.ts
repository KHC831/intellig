/**
 * Un-Resolve File flow — sends a mis-resolved file back to conflicted state
 * (`git checkout --merge`) so the user can redo the resolution. The flow
 * refuses politely when no merge/rebase/cherry-pick is in progress and
 * surfaces per-file failures without dropping the rest of the selection.
 */

import '../../setup';
import * as assert from 'assert';
import { runUnresolveFlow, IUnresolveFlowDeps } from '../../../src/conflicts/unresolveFlow';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function makeRepo(inProgress: boolean): IRepository {
  return {
    rootUri: Uri.file('/r'),
    state: inProgress ? 'merging' : 'idle',
    ...(inProgress ? { inProgress: { kind: 'merge' } } : {}),
  } as unknown as IRepository;
}

interface Harness {
  deps: IUnresolveFlowDeps;
  unresolved: string[];
  infos: string[];
  errors: string[];
}

function makeHarness(repo: IRepository, failPaths: string[] = []): Harness {
  const h: Harness = {
    unresolved: [],
    infos: [],
    errors: [],
    deps: {
      repo,
      conflictService: {
        unresolveFile: async (_repo: IRepository, filePath: string) => {
          h.unresolved.push(filePath);
          return failPaths.includes(filePath)
            ? { success: false, error: `Failed to un-resolve: ${filePath}` }
            : { success: true };
        },
      },
      showInformationMessage: async (msg: string) => {
        h.infos.push(msg);
        return undefined;
      },
      showErrorMessage: async (msg: string) => {
        h.errors.push(msg);
        return undefined;
      },
    },
  };
  return h;
}

describe('runUnresolveFlow', () => {
  it('refuses with an honest toast when nothing is in progress', async () => {
    const h = makeHarness(makeRepo(false));
    await runUnresolveFlow(h.deps, ['a.txt']);
    assert.deepStrictEqual(h.unresolved, []);
    assert.strictEqual(h.errors.length, 1);
    assert.match(h.errors[0], /no merge, rebase, or cherry-pick/i);
  });

  it('un-resolves every selected path and toasts once', async () => {
    const h = makeHarness(makeRepo(true));
    await runUnresolveFlow(h.deps, ['a.txt', 'b/c.txt']);
    assert.deepStrictEqual(h.unresolved, ['a.txt', 'b/c.txt']);
    assert.strictEqual(h.infos.length, 1);
    assert.match(h.infos[0], /2 files/);
    assert.strictEqual(h.errors.length, 0);
  });

  it('names the single file in the success toast', async () => {
    const h = makeHarness(makeRepo(true));
    await runUnresolveFlow(h.deps, ['a.txt']);
    assert.ok(h.infos[0].includes('a.txt'), h.infos[0]);
  });

  it('keeps going past a failing path and surfaces the failure', async () => {
    const h = makeHarness(makeRepo(true), ['a.txt']);
    await runUnresolveFlow(h.deps, ['a.txt', 'b.txt']);
    assert.deepStrictEqual(h.unresolved, ['a.txt', 'b.txt']);
    assert.strictEqual(h.errors.length, 1);
    assert.ok(h.errors[0].includes('a.txt'), h.errors[0]);
    assert.strictEqual(h.infos.length, 1, 'the succeeding file still gets its toast');
    assert.ok(h.infos[0].includes('b.txt'), h.infos[0]);
  });
});
