/**
 * Every public tool-window setter that repaints must repaint only when
 * something the document shows has changed.
 *
 * Companion to `scripts/check-render-guards.mjs`. The script reads the KEYS of
 * {@link RENDER_IDEMPOTENCE_CASES} out of this file and requires every public
 * owner of a render site to be one of them or to carry a
 * `render-unconditional:` annotation. The `it()` blocks below are GENERATED
 * from the same table, so a name cannot appear in the fence's coverage set
 * without actually being called twice here — "listed" and "exercised" are one
 * fact rather than two that can drift apart.
 *
 * Each case supplies a fresh provider and calls its method twice with identical
 * input. The second call must not rebuild the document.
 */

import '../../../setup';
import * as assert from 'assert';
import { GitToolWindowProvider } from '../../../../src/ui-shell/GitToolWindowProvider';
import type { ICommit, IRepository } from '../../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../../mocks/vscode';

function mkCommit(hash: string): ICommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    message: `commit ${hash}`,
    author: { name: 'a', email: 'a@x' },
    committer: { name: 'a', email: 'a@x' },
    parents: [],
    authorDate: new Date(0),
    commitDate: new Date(0),
  };
}

function mkRepo(rootPath: string): IRepository {
  return {
    rootUri: Uri.file(rootPath),
    state: 'idle',
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

/** Count `webview.html` assignments — one per document destroyed. */
function tapView(provider: GitToolWindowProvider): { rebuilds: () => number } {
  let count = 0;
  let backing = '';
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  (provider as any)._view = {
    webview: {
      get html(): string {
        return backing;
      },
      set html(v: string) {
        count += 1;
        backing = v;
      },
      options: {},
      cspSource: 'test:',
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
      asWebviewUri: (u: unknown) => u,
    },
    visible: true,
    onDidChangeVisibility: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
  return { rebuilds: () => count };
}

/**
 * One entry per public render-owner that can carry a real idempotence claim.
 *
 * `arrange` runs before the tap is installed and establishes the state the
 * repeated call will match; `act` is what gets called twice. Adding a key here
 * is what removes an owner from the fence's annotation count, so an entry that
 * cannot fail is worse than no entry at all.
 */
export const RENDER_IDEMPOTENCE_CASES: Record<
  string,
  {
    arrange: (p: GitToolWindowProvider) => void | Promise<void>;
    act: (p: GitToolWindowProvider) => void | Promise<void>;
  }
> = {
  setHasRepository: {
    arrange: (p) => p.setHasRepository(true),
    act: (p) => p.setHasRepository(true),
  },
  updateLogState: {
    arrange: (p) => p.updateLogState([mkCommit('a'.repeat(40))]),
    act: (p) => p.updateLogState([mkCommit('a'.repeat(40))]),
  },
  setCherryPickedHashes: {
    arrange: (p) => p.setCherryPickedHashes(new Set(['a'.repeat(40)]), 'origin/main'),
    act: (p) => p.setCherryPickedHashes(new Set(['a'.repeat(40)]), 'origin/main'),
  },
  setAvailableRepositories: {
    arrange: (p) => p.setAvailableRepositories([mkRepo('/repo/a')]),
    act: (p) => p.setAvailableRepositories([mkRepo('/repo/a')]),
  },
  clearConsole: {
    // The Console tab has to be the ACTIVE one here. Left on the Log tab this
    // case passes on the active-tab gate alone, so the already-empty guard it
    // is meant to exercise could be deleted without the spec noticing.
    arrange: async (p) => {
      await p.focusTab('console');
      p.addConsoleEntry({ command: 'git status', output: '', exitCode: 0, isError: false });
      p.clearConsole();
    },
    act: (p) => p.clearConsole(),
  },
};

describe('public render owners repaint only on a real change', () => {
  let provider: GitToolWindowProvider;

  beforeEach(() => {
    provider = new GitToolWindowProvider(Uri.file('/test/extension'));
  });

  afterEach(() => {
    provider.dispose();
  });

  // Instrument control. Every generated case below expects zero rebuilds, and a
  // tap wired to the wrong object reports zero for all of them — which is
  // indistinguishable from every guard working. Prove the tap counts first.
  it('counts a rebuild that is known to happen', () => {
    const view = tapView(provider);

    provider.updateLogState([mkCommit('f'.repeat(40))]);

    assert.strictEqual(view.rebuilds(), 1, 'tap is blind: new log data must rebuild the document');
  });

  // Vacuity probe. The generated cases below all assert ZERO rebuilds, which is
  // trivially true for a scenario that never rendered in the first place — a
  // case whose `arrange` leaves nothing on screen would pass no matter what its
  // guard does, and mutating the guard would not turn it red either, so the
  // companion harness cannot detect it. Asserting that `arrange` itself renders
  // is the precondition that makes each zero-assertion mean something.
  //
  // The guard-mutation half of this control is deliberately NOT in the suite;
  // it is a manual harness at `workspace-notes/idempotence-mutate.mjs`. See
  // section 4(e) of `scripts/check-render-guards.mjs` for why.
  for (const [name, testCase] of Object.entries(RENDER_IDEMPOTENCE_CASES)) {
    it(`${name} arranges a scenario that actually renders, so its zero-assertion means something`, async () => {
      const view = tapView(provider);

      await testCase.arrange(provider);

      assert.ok(
        view.rebuilds() >= 1,
        `${name}'s arrange never rebuilt the document, so "the repeat call does not rebuild" ` +
          'is vacuously true and this case proves nothing about its guard'
      );
    });
  }

  for (const [name, testCase] of Object.entries(RENDER_IDEMPOTENCE_CASES)) {
    it(`${name} does not rebuild the document on an identical repeat call`, async () => {
      await testCase.arrange(provider);
      const view = tapView(provider);

      await testCase.act(provider);

      assert.strictEqual(
        view.rebuilds(),
        0,
        `${name} repainted on a call that changed nothing the document shows`
      );
    });
  }
});
