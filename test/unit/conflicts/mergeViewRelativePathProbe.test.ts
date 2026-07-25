/**
 * A repo-relative conflict path must never be probed as if it were absolute.
 *
 * `ResolveConflictsDialog` hands `MergeView.show()` a repo-relative path (the
 * form `git status --porcelain` reports). `show()` used to probe the verbatim
 * path first "to cover absolute-path callers", but it did so through
 * `vscode.Uri.file(file)`, which turns `greeting.txt` into `/greeting.txt`.
 * That path cannot exist, so the repo-root probe spawned git with a
 * non-existent cwd and logged an ERROR with a spawn ENOENT stack on every
 * merge-view open. The fallback loop below it then found the right repository,
 * so the window still opened and the failure read as a mystery error.
 *
 * Two invariants, one per layer:
 *  - the caller only probes verbatim when the path really is absolute;
 *  - the cwd the probe derives always exists, whatever path it is handed.
 */

import '../../setup';
import * as assert from 'assert';
import * as fs from 'fs';
import { Uri } from '../../mocks/vscode';
import { MergeView } from '../../../src/conflicts/MergeView';
import { IGitService } from '../../../src/git-core/interfaces/IGitService';

describe('merge view: repo-relative conflict paths', () => {
  it('does not probe a relative path as an absolute one', async () => {
    const probed: string[] = [];
    const gitService = {
      getRepository: async (uri: { fsPath: string }) => {
        probed.push(uri.fsPath);
        return undefined;
      },
      getRepositories: () => [],
    } as unknown as IGitService;

    const view = new MergeView(Uri.file('/ext'), gitService);

    // No repositories are discovered, so show() must fail its "no repository"
    // guard — the point here is WHICH paths it probed on the way there.
    await assert.rejects(() => view.show('greeting.txt'));

    // Asserting on the probed STRING would be mock-dependent: the real
    // vscode.Uri.file() prefixes a slash onto a relative path (producing the
    // "/greeting.txt" from the bug report) while the test double does not. The
    // mock-independent invariant is that the verbatim probe does not happen at
    // all for a relative path — with zero repositories discovered, the fallback
    // loop iterates nothing, so a correct show() probes nothing.
    assert.deepStrictEqual(
      probed,
      [],
      'show() must skip the verbatim probe for a relative path. Probing it sends ' +
        'vscode.Uri.file("greeting.txt") -> "/greeting.txt" to getRepository, whose cwd ' +
        `cannot exist, so git is spawned with a bad cwd (ENOENT). Probed: ${probed.join(', ')}`
    );
  });
});

/**
 * Layer 2: whatever path arrives, the cwd used for the repo-root probe must be
 * a directory that exists. `toDirectoryCwd` used to return the path unchanged
 * when it could not be stat'd, which is precisely the case that produces the
 * confusing ENOENT — so the class of bug is closed here, not just at the one
 * caller above.
 */
describe('git service: repo-root probe cwd', () => {
  it('derives an existing directory even from a path that does not exist', async () => {
    // Imported lazily: GitService pulls in the watcher stack, and this suite
    // only needs the cwd derivation.
    const { GitService } = await import('../../../src/git-core/GitService');
    const service = new GitService();
    const cwds: string[] = [];
    const surface = service as unknown as {
      _gitCli: { getRepositoryRoot(p: string): unknown };
    };
    // Patch the METHOD on the real instance: spreading the object would drop
    // every prototype method (dispose among them) and break teardown.
    surface._gitCli.getRepositoryRoot = (p: string) => {
      cwds.push(p);
      // Ok(undefined) — "this directory simply isn't a repo".
      return {
        match: (ok: (v: undefined) => unknown) => Promise.resolve(ok(undefined)),
      };
    };

    try {
      await service.getRepository(Uri.file('/definitely/not/here/greeting.txt'));
      assert.ok(cwds.length > 0, 'expected the repo-root probe to run');
      for (const cwd of cwds) {
        assert.ok(
          fs.existsSync(cwd) && fs.statSync(cwd).isDirectory(),
          `probe cwd "${cwd}" does not exist as a directory; spawn rejects that with ` +
            'ENOENT, which surfaces as a system fault instead of a plain "not a repo".'
        );
      }
    } finally {
      service.dispose();
    }
  });
});
