/**
 * `CtwRepoTarget.resolveFileUri` is the single seam every Commit-window file
 * action resolves through, and the only place a webview-supplied path is
 * checked for containment. `vscode.Uri.joinPath` normalises `..`, so without
 * the check a row path could name a file outside the repository — and the
 * resolved Uri reaches Show Diff, Rollback, Jump to Source and the F4 fallback.
 *
 * Pinned here because the check is otherwise invisible: a refactor that drops
 * it changes no behaviour any other suite observes.
 */

import '../../setup';
import * as assert from 'assert';
import { Uri } from '../../mocks/vscode';
import { CtwRepoTarget } from '../../../src/commits/ctwRepoTarget';
import type { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

function targetAt(root: string): CtwRepoTarget {
  const repo = { rootUri: Uri.file(root) } as unknown as IRepository;
  const gitService = {
    getRepositories: () => [repo],
    getRepository: async () => repo,
  } as unknown as IGitService;
  const target = new CtwRepoTarget(gitService);
  target.set(repo);
  return target;
}

describe('CtwRepoTarget.resolveFileUri', () => {
  it('resolves a repo-relative path against the sticky root', async () => {
    const uri = await targetAt('/repo').resolveFileUri('src/a.ts');
    assert.ok(uri, 'an in-repo path must resolve');
    assert.ok(uri.fsPath.endsWith('src/a.ts'), `got ${uri.fsPath}`);
  });

  // joinPath normalises `..`, so this is the escape the containment check exists
  // to stop. Every file action funnels through here, so one check covers them.
  for (const escaping of ['../outside.txt', '../../etc/passwd', 'src/../../outside.txt']) {
    it(`refuses "${escaping}", which normalises outside the repo`, async () => {
      const uri = await targetAt('/repo').resolveFileUri(escaping);
      assert.strictEqual(uri, undefined, `must not resolve; got ${String(uri?.fsPath)}`);
    });
  }

  it('refuses an empty path', async () => {
    assert.strictEqual(await targetAt('/repo').resolveFileUri(''), undefined);
  });
});
