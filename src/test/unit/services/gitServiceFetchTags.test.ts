/**
 * Unit tests for the T3-12 `intellig.fetchTags` integration.
 *
 * `GitService.fetch` now reads the `intellig.fetchTags` config and maps:
 *   - 'auto'  → no flag (git default)
 *   - 'all'   → --tags
 *   - 'never' → --no-tags
 *
 * User-passed `options.tags` / `options.noTags` in the call site override
 * the config. These tests lock in both directions:
 *   - Config-only behaviour (no options) — args reflect config policy.
 *   - User-options wins — explicit `tags: true` when config is 'never'
 *     still fetches tags; explicit `noTags: true` when config is 'all'
 *     still skips them.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitService } from '../../../services/GitService';
import { IRepository } from '../../../services/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
}

interface InstalledService {
  gitService: GitService;
  executed: string[][];
}

function installGitService(): InstalledService {
  const gitService = new GitService();
  const executed: string[][] = [];
  const gitCli = {
    onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
    exec: async (args: string[]) => {
      executed.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
    invalidateCache: () => {},
  };
  (gitService as unknown as { _gitCli: unknown })._gitCli = gitCli;
  return { gitService, executed };
}

async function setFetchTags(value: 'auto' | 'all' | 'never'): Promise<void> {
  await vscode.workspace.getConfiguration('intellig').update('fetchTags', value);
}

describe('T3-12 GitService.fetch — intellig.fetchTags config', () => {
  afterEach(async () => {
    // Restore default so state doesn't leak between tests.
    await vscode.workspace.getConfiguration('intellig').update('fetchTags', 'auto');
  });

  describe('config-only behaviour (no user-passed tag flags)', () => {
    it('"auto" → no --tags / --no-tags in the arg list', async () => {
      await setFetchTags('auto');
      const { gitService, executed } = installGitService();
      await gitService.fetch(makeRepo());
      assert.ok(executed.length > 0);
      const args = executed[0];
      assert.ok(!args.includes('--tags'), `args should NOT include --tags: ${args.join(' ')}`);
      assert.ok(
        !args.includes('--no-tags'),
        `args should NOT include --no-tags: ${args.join(' ')}`
      );
    });

    it('"all" → args include --tags', async () => {
      await setFetchTags('all');
      const { gitService, executed } = installGitService();
      await gitService.fetch(makeRepo());
      assert.ok(executed[0].includes('--tags'), `args: ${executed[0].join(' ')}`);
      assert.ok(!executed[0].includes('--no-tags'));
    });

    it('"never" → args include --no-tags', async () => {
      await setFetchTags('never');
      const { gitService, executed } = installGitService();
      await gitService.fetch(makeRepo());
      assert.ok(executed[0].includes('--no-tags'), `args: ${executed[0].join(' ')}`);
      assert.ok(!executed[0].includes('--tags'));
    });

    it('applies to remote-specific fetch too', async () => {
      await setFetchTags('all');
      const { gitService, executed } = installGitService();
      await gitService.fetch(makeRepo(), 'origin');
      assert.ok(executed[0].includes('--tags'));
      assert.ok(executed[0].includes('origin'));
    });
  });

  describe('user-passed options override config', () => {
    it('config "never" + options.tags=true → --tags wins (user opts in)', async () => {
      await setFetchTags('never');
      const { gitService, executed } = installGitService();
      await gitService.fetch(makeRepo(), { tags: true });
      assert.ok(executed[0].includes('--tags'), `args: ${executed[0].join(' ')}`);
      assert.ok(!executed[0].includes('--no-tags'));
    });

    it('config "all" + options.noTags=true → --no-tags wins (user opts out)', async () => {
      await setFetchTags('all');
      const { gitService, executed } = installGitService();
      await gitService.fetch(makeRepo(), { noTags: true });
      assert.ok(executed[0].includes('--no-tags'), `args: ${executed[0].join(' ')}`);
      assert.ok(!executed[0].includes('--tags'));
    });

    it('config "auto" + options.tags=true → --tags added', async () => {
      await setFetchTags('auto');
      const { gitService, executed } = installGitService();
      await gitService.fetch(makeRepo(), { tags: true });
      assert.ok(executed[0].includes('--tags'));
    });
  });

  describe('arg ordering', () => {
    it('--tags appears before the remote / --all positional', async () => {
      await setFetchTags('all');
      const { gitService, executed } = installGitService();
      await gitService.fetch(makeRepo(), 'origin');
      const args = executed[0];
      const tagsIdx = args.indexOf('--tags');
      const remoteIdx = args.indexOf('origin');
      assert.ok(tagsIdx >= 0 && remoteIdx >= 0);
      assert.ok(tagsIdx < remoteIdx, `--tags should precede the remote arg; got ${args.join(' ')}`);
    });
  });
});
