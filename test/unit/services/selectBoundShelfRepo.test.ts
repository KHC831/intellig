/**
 * Regression: the Commit tool window's Shelf/Stash tab actions must target the
 * SELECTED repository, not an arbitrary `repos[0]`.
 *
 * The bug: `bindShelfRepo` hard-bound both views to `getRepositories()[0]`, so
 * in a multi-root workspace unshelve / apply-stash / drop could operate on the
 * WRONG repository (a data-affecting mis-target). The fix routes through the
 * tool window's repo selector (`getSelectedRepository`) with a single-repo
 * fallback — exercised here through the extracted pure `selectBoundShelfRepo`.
 */

import '../../setup';
import * as assert from 'assert';
import { selectBoundShelfRepo } from '../../../src/registration/registerViews';
import { Uri } from '../../mocks/vscode';
import type { IRepository } from '../../../src/git-core/interfaces/IGitService';

function repoAt(fsPath: string): IRepository {
  return {
    rootUri: Uri.file(fsPath),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  };
}

describe('selectBoundShelfRepo — Shelf/Stash repo targeting (M-B5)', () => {
  const a = repoAt('/ws/a');
  const b = repoAt('/ws/b');

  it('returns the tool-window SELECTED repo, not the first repo', () => {
    const provider = { getSelectedRepository: (): IRepository => b };
    assert.strictEqual(selectBoundShelfRepo(provider, [a, b]), b);
  });

  it('falls back to the single open repo when there is no explicit selection', () => {
    const provider = { getSelectedRepository: (): IRepository | undefined => undefined };
    assert.strictEqual(selectBoundShelfRepo(provider, [a, b]), a);
  });

  it('falls back to repos[0] when the provider is absent', () => {
    assert.strictEqual(selectBoundShelfRepo(undefined, [a, b]), a);
  });

  it('returns undefined when no repos are open and nothing is selected', () => {
    const provider = { getSelectedRepository: (): IRepository | undefined => undefined };
    assert.strictEqual(selectBoundShelfRepo(provider, []), undefined);
  });
});
