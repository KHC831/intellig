/**
 * A repo that was explicitly REMOVED (workspace folder removed, watcher
 * teardown) must stay gone: a late fire-and-forget `reloadRepository` or a
 * queued watcher refresh must not resurrect it as a phantom in every
 * repository picker. Reproduced live in the e2e lane: suite N's late
 * reload re-registered its deleted fixture during suite N+1, turning a
 * single-repo test into a surprise multi-repo picker whose auto-cancelled
 * prompt read as "command did nothing".
 *
 * The guard is a removal TOMBSTONE, not cache membership — the cache entry
 * is legitimately absent mid-reload (invalidate → load), and a transient
 * load failure must not unhook the root's refreshes forever.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

interface GitServiceLifecycleSurface {
  _repositories: Map<string, unknown>;
  _removedRoots: Set<string>;
  removeRepositoryWatcher(rootPath: string): void;
}

describe('GitService — removed-repo tombstone', () => {
  it('reloadRepository is a no-op for a removed repo and does not resurrect it', async () => {
    const service = new GitService();
    const internals = service as unknown as GitServiceLifecycleSurface;
    const root = '/tombstoned-repo';
    const repo = { rootUri: Uri.file(root), state: 'idle' } as unknown as IRepository;

    // Discovered once (seed the cache the way loadRepository would)...
    internals._repositories.set(root, { repository: repo });
    // ...then explicitly removed.
    internals.removeRepositoryWatcher(root);
    assert.strictEqual(internals._repositories.has(root), false, 'removal empties the cache');
    assert.strictEqual(internals._removedRoots.has(root), true, 'removal tombstones the root');

    const result = await service.reloadRepository(repo);

    assert.strictEqual(result, undefined, 'reload of a removed repo must return undefined');
    assert.strictEqual(
      internals._repositories.has(root),
      false,
      'reload must NOT resurrect the removed repo into the cache'
    );
    service.dispose();
  });
});
