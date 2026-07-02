/**
 * Update Project dialog flow + Update Info summary (Workstream C, Item 5).
 *
 * Covers the pure method resolution (BRANCH_DEFAULT / MERGE / REBASE parity
 * with git4idea's GitUpdater.getUpdater), the multi-root orchestration in
 * `runUpdateProject` (fetch → incoming count → pull, per repo), the summary
 * fold, and the Update Info tab headline + state.
 */

import '../../setup';
import * as assert from 'assert';
import type { IPullOptions, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitCommandError, IGitCommandResult } from '../../../src/git-core/gitCli';
import {
  buildUpdatePullOptions,
  repoDisplayName,
  resolveUpdateRebase,
  runUpdateProject,
  summarizeUpdate,
  type IUpdateGitService,
  type IUpdateRepoResult,
} from '../../../src/sync/updateProject';
import {
  UpdateInfoTab,
  updateInfoHeadline,
} from '../../../src/git-core/gitToolWindow/tabs/UpdateInfoTab';

function repo(name: string, branch = 'main'): IRepository {
  return {
    rootUri: { fsPath: `/repos/${name}` },
    state: 'idle',
    head: { name: branch, ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

// ─── resolveUpdateRebase ─────────────────────────────────────────────────────

describe('resolveUpdateRebase (UpdateMethod parity)', () => {
  it('rebase method always rebases', () => {
    assert.strictEqual(resolveUpdateRebase('rebase', false), true);
    assert.strictEqual(resolveUpdateRebase('rebase', true), true);
  });
  it('merge method always merges', () => {
    assert.strictEqual(resolveUpdateRebase('merge', true), false);
    assert.strictEqual(resolveUpdateRebase('merge', false), false);
  });
  it('branch-default follows the pull.rebase analog', () => {
    assert.strictEqual(resolveUpdateRebase('branch-default', true), true);
    assert.strictEqual(resolveUpdateRebase('branch-default', false), false);
  });
});

describe('buildUpdatePullOptions', () => {
  it('rebase=true sets --rebase and --prune', () => {
    const o: IPullOptions = buildUpdatePullOptions(true);
    assert.strictEqual(o.rebase, true);
    assert.strictEqual(o.prune, true);
  });
  it('rebase=false leaves rebase unset (plain merge pull) but keeps prune', () => {
    const o: IPullOptions = buildUpdatePullOptions(false);
    assert.strictEqual(o.rebase, undefined);
    assert.strictEqual(o.prune, true);
  });
  it('always autostashes so a dirty working tree does not fail the update', () => {
    // git4idea GitUpdateProcess saves local changes before updating; without
    // --autostash a plain pull dead-ends on "local changes would be
    // overwritten" and every dirty repo becomes an error row.
    assert.strictEqual(buildUpdatePullOptions(true).autostash, true);
    assert.strictEqual(buildUpdatePullOptions(false).autostash, true);
  });
});

describe('repoDisplayName', () => {
  it('returns the last path segment', () => {
    assert.strictEqual(repoDisplayName(repo('alpha')), 'alpha');
  });
});

// ─── summarizeUpdate ─────────────────────────────────────────────────────────

describe('summarizeUpdate', () => {
  const r = (status: IUpdateRepoResult['status'], incoming: number): IUpdateRepoResult => ({
    name: 'x',
    rootPath: '/x',
    branch: 'main',
    rebase: false,
    incoming,
    status,
  });

  it('totals incoming and flags allClean', () => {
    const s = summarizeUpdate('merge', [r('updated', 3), r('up-to-date', 0)]);
    assert.strictEqual(s.totalIncoming, 3);
    assert.strictEqual(s.allClean, true);
  });
  it('allClean is false when any repo conflicts or errors', () => {
    assert.strictEqual(
      summarizeUpdate('merge', [r('updated', 1), r('conflict', 0)]).allClean,
      false
    );
    assert.strictEqual(summarizeUpdate('merge', [r('error', 0)]).allClean, false);
  });
});

// ─── runUpdateProject (multi-root orchestration) ─────────────────────────────

interface IStub extends IUpdateGitService {
  pullCalls: Array<{ root: string; options?: IPullOptions }>;
  fetchCalls: string[];
}

function makeGit(opts: {
  incomingByRoot: Record<string, { incoming: number; noUpstream?: boolean; branch?: string }>;
  unmergedRoots?: Set<string>;
  pullThrows?: Record<string, Error>;
}): IStub {
  const pullCalls: Array<{ root: string; options?: IPullOptions }> = [];
  const fetchCalls: string[] = [];
  return {
    pullCalls,
    fetchCalls,
    async getStatus(r) {
      return opts.unmergedRoots?.has(r.rootUri.fsPath)
        ? [{ path: 'conflict.ts', indexStatus: 'U' as const, workTreeStatus: 'U' as const }]
        : [];
    },
    async fetch(r) {
      fetchCalls.push(r.rootUri.fsPath);
      return undefined;
    },
    async getIncomingOutgoing(r) {
      const info = opts.incomingByRoot[r.rootUri.fsPath] ?? { incoming: 0 };
      return {
        branch: info.branch ?? 'main',
        upstream: info.noUpstream ? undefined : 'origin/main',
        incoming: info.incoming,
        outgoing: 0,
        noUpstream: info.noUpstream ?? false,
      };
    },
    async pull(r, options) {
      const thrown = opts.pullThrows?.[r.rootUri.fsPath];
      if (thrown) {
        throw thrown;
      }
      pullCalls.push({ root: r.rootUri.fsPath, options });
    },
    async reloadRepository() {
      return undefined;
    },
  };
}

describe('runUpdateProject', () => {
  it('updates a single repo with incoming commits via the chosen strategy', async () => {
    const git = makeGit({ incomingByRoot: { '/repos/a': { incoming: 4 } } });
    const summary = await runUpdateProject({
      repos: [repo('a')],
      gitService: git,
      method: 'rebase',
      pullRebaseDefault: false,
    });
    assert.strictEqual(summary.repos.length, 1);
    assert.strictEqual(summary.repos[0].status, 'updated');
    assert.strictEqual(summary.repos[0].incoming, 4);
    assert.strictEqual(summary.repos[0].rebase, true);
    assert.strictEqual(git.fetchCalls.length, 1);
    assert.strictEqual(git.pullCalls.length, 1);
    assert.strictEqual(git.pullCalls[0].options?.rebase, true);
  });

  it('marks an in-sync repo up-to-date and does not pull', async () => {
    const git = makeGit({ incomingByRoot: { '/repos/a': { incoming: 0 } } });
    const summary = await runUpdateProject({
      repos: [repo('a')],
      gitService: git,
      method: 'merge',
      pullRebaseDefault: false,
    });
    assert.strictEqual(summary.repos[0].status, 'up-to-date');
    assert.strictEqual(git.pullCalls.length, 0, 'no pull when nothing incoming');
    assert.strictEqual(git.fetchCalls.length, 1, 'still fetches');
  });

  it('reports no-upstream repos as up-to-date without pulling', async () => {
    const git = makeGit({ incomingByRoot: { '/repos/a': { incoming: 0, noUpstream: true } } });
    const summary = await runUpdateProject({
      repos: [repo('a')],
      gitService: git,
      method: 'merge',
      pullRebaseDefault: false,
    });
    assert.strictEqual(summary.repos[0].status, 'up-to-date');
    assert.strictEqual(git.pullCalls.length, 0);
  });

  it('updates multiple roots independently and aggregates the summary', async () => {
    const git = makeGit({
      incomingByRoot: { '/repos/a': { incoming: 2 }, '/repos/b': { incoming: 0 } },
    });
    const summary = await runUpdateProject({
      repos: [repo('a'), repo('b')],
      gitService: git,
      method: 'merge',
      pullRebaseDefault: false,
    });
    assert.strictEqual(summary.repos.length, 2);
    assert.strictEqual(summary.totalIncoming, 2);
    assert.strictEqual(summary.allClean, true);
    assert.strictEqual(git.fetchCalls.length, 2);
    assert.strictEqual(git.pullCalls.length, 1, 'only the repo with incoming pulls');
  });

  it('skips a blocked repo (unmerged files) with an error result and continues others', async () => {
    const git = makeGit({
      incomingByRoot: { '/repos/a': { incoming: 1 }, '/repos/b': { incoming: 1 } },
      unmergedRoots: new Set(['/repos/a']),
    });
    const summary = await runUpdateProject({
      repos: [repo('a'), repo('b')],
      gitService: git,
      method: 'merge',
      pullRebaseDefault: false,
    });
    const a = summary.repos.find((r) => r.name === 'a')!;
    const b = summary.repos.find((r) => r.name === 'b')!;
    assert.strictEqual(a.status, 'error');
    assert.ok(/conflict|unmerged/i.test(a.detail ?? ''));
    assert.strictEqual(b.status, 'updated');
    assert.strictEqual(summary.allClean, false);
  });

  it('classifies a conflicting pull as status=conflict', async () => {
    const git = makeGit({
      incomingByRoot: { '/repos/a': { incoming: 3 } },
      pullThrows: { '/repos/a': new Error('CONFLICT (content): Merge conflict in foo.ts') },
    });
    const summary = await runUpdateProject({
      repos: [repo('a')],
      gitService: git,
      method: 'merge',
      pullRebaseDefault: false,
    });
    assert.strictEqual(summary.repos[0].status, 'conflict');
  });

  // M4 — a real conflicting pull writes "CONFLICT (content)…" to STDOUT, while
  // GitCommandError.message is `stderr || stdout`. When stderr carries hint
  // text the marker is only on stdout/combined; classifying on `.message`
  // would misreport the conflict as a generic error.
  it('classifies a conflicting pull as status=conflict when the marker is only on stdout', async () => {
    const result: IGitCommandResult = {
      exitCode: 1,
      stdout:
        'Auto-merging foo.ts\nCONFLICT (content): Merge conflict in foo.ts\n' +
        'Automatic merge failed; fix conflicts and then commit the result.',
      stderr: 'hint: see git config advice.mergeConflict',
      combined:
        'Auto-merging foo.ts\nCONFLICT (content): Merge conflict in foo.ts\n' +
        'Automatic merge failed; fix conflicts and then commit the result.\n' +
        'hint: see git config advice.mergeConflict',
    };
    const git = makeGit({
      incomingByRoot: { '/repos/a': { incoming: 3 } },
      pullThrows: { '/repos/a': new GitCommandError('git', ['pull'], result) },
    });
    const summary = await runUpdateProject({
      repos: [repo('a')],
      gitService: git,
      method: 'merge',
      pullRebaseDefault: false,
    });
    assert.strictEqual(summary.repos[0].status, 'conflict');
  });

  // ─── Finding #7: AA/DD conflict detection ─────────────────────────────────
  //
  // Regression: the preflight getStatus check only matched 'U' markers, missing
  // both-sides-added (AA) and both-sides-deleted (DD) conflicts — e.g. after a
  // stash re-apply where git exits 0 but leaves 'AA' entries. The fix imports
  // and delegates to isConflictedStatus so all three cases are caught.

  it('blocks update when getStatus reports a both-sides-added (AA) conflict', async () => {
    // Build a custom stub that returns { indexStatus: 'A', workTreeStatus: 'A' }
    // — a both-added merge conflict that the old 'U'-only check would miss.
    const blockedStub = {
      async getStatus() {
        return [{ indexStatus: 'A', workTreeStatus: 'A', path: 'collide.ts' }];
      },
      async fetch() {},
      async getIncomingOutgoing() {
        return {
          branch: 'main',
          upstream: 'origin/main',
          incoming: 1,
          outgoing: 0,
          noUpstream: false,
        };
      },
      async pull() {},
      async reloadRepository() {},
    };

    const summary = await runUpdateProject({
      repos: [repo('aa-conflict')],
      gitService:
        blockedStub as unknown as import('../../../src/sync/updateProject').IUpdateGitService,
      method: 'merge',
      pullRebaseDefault: false,
    });

    const r = summary.repos[0];
    assert.strictEqual(r.status, 'error', 'AA conflict must block update with error status');
    assert.ok(
      /conflict|unmerged/i.test(r.detail ?? ''),
      `error detail must mention conflicts/unmerged; got: ${r.detail}`
    );
  });

  it('blocks update when getStatus reports a both-sides-deleted (DD) conflict', async () => {
    const blockedStub = {
      async getStatus() {
        return [{ indexStatus: 'D', workTreeStatus: 'D', path: 'gone.ts' }];
      },
      async fetch() {},
      async getIncomingOutgoing() {
        return {
          branch: 'main',
          upstream: 'origin/main',
          incoming: 1,
          outgoing: 0,
          noUpstream: false,
        };
      },
      async pull() {},
      async reloadRepository() {},
    };

    const summary = await runUpdateProject({
      repos: [repo('dd-conflict')],
      gitService:
        blockedStub as unknown as import('../../../src/sync/updateProject').IUpdateGitService,
      method: 'merge',
      pullRebaseDefault: false,
    });

    assert.strictEqual(summary.repos[0].status, 'error');
  });

  it('falls through to pull when getIncomingOutgoing throws after a successful fetch', async () => {
    // Regression: when getIncomingOutgoing throws, `incoming` stays 0 and
    // the `if (incoming === 0)` short-circuit reports 'up-to-date' WITHOUT
    // pulling — silently doing nothing even if the remote had new commits.
    // The fix tracks whether the incoming count is KNOWN; only skip the pull
    // when we positively know incoming === 0.
    const pullCalls: string[] = [];
    const stub: import('../../../src/sync/updateProject').IUpdateGitService = {
      async getStatus() {
        return [];
      },
      async fetch() {},
      async getIncomingOutgoing() {
        throw new Error('network timeout');
      },
      async pull(r) {
        pullCalls.push(r.rootUri.fsPath);
      },
      async reloadRepository() {},
    };

    const summary = await runUpdateProject({
      repos: [repo('a')],
      gitService: stub,
      method: 'merge',
      pullRebaseDefault: false,
    });

    assert.strictEqual(pullCalls.length, 1, 'pull must be called when incoming count is unknown');
    // Status is driven by what pull produces; no pull-specific error here means 'updated'
    assert.notStrictEqual(
      summary.repos[0].status,
      'up-to-date',
      'must NOT report up-to-date when incoming count was unknown'
    );
  });

  it('classifies a non-conflict pull failure as status=error', async () => {
    const git = makeGit({
      incomingByRoot: { '/repos/a': { incoming: 3 } },
      pullThrows: { '/repos/a': new Error('fatal: could not read from remote') },
    });
    const summary = await runUpdateProject({
      repos: [repo('a')],
      gitService: git,
      method: 'merge',
      pullRebaseDefault: false,
    });
    assert.strictEqual(summary.repos[0].status, 'error');
  });

  it('sanitizes credentials out of the error detail surfaced in the Update Info tab', async () => {
    const git = makeGit({
      incomingByRoot: { '/repos/a': { incoming: 1 } },
      pullThrows: {
        '/repos/a': new Error(
          'fatal: unable to access https://x-access-token:ghp_SECRET123@github.com/o/r.git/'
        ),
      },
    });
    const summary = await runUpdateProject({
      repos: [repo('a')],
      gitService: git,
      method: 'merge',
      pullRebaseDefault: false,
    });
    const detail = summary.repos[0].detail ?? '';
    assert.ok(!detail.includes('ghp_SECRET123'), `credential must be scrubbed; got: ${detail}`);
    assert.ok(!detail.includes('x-access-token'), 'the userinfo segment must be scrubbed');
  });
});

// ─── UpdateInfoTab ───────────────────────────────────────────────────────────

describe('updateInfoHeadline', () => {
  const result = (status: IUpdateRepoResult['status'], incoming = 0): IUpdateRepoResult => ({
    name: 'r',
    rootPath: '/r',
    branch: 'main',
    rebase: false,
    incoming,
    status,
  });

  it('reports up to date for a single in-sync repo', () => {
    const s = summarizeUpdate('merge', [result('up-to-date', 0)]);
    assert.strictEqual(updateInfoHeadline(s), 'Already up to date.');
  });
  it('reports updated count + commits pulled', () => {
    const s = summarizeUpdate('merge', [result('updated', 5)]);
    assert.ok(/Updated 1 repository; 5 commit/.test(updateInfoHeadline(s)));
  });
  it('reports conflicts first', () => {
    const s = summarizeUpdate('merge', [result('updated', 1), result('conflict', 0)]);
    assert.ok(/conflict/i.test(updateInfoHeadline(s)));
  });
  it('reports errors when present and no conflicts', () => {
    const s = summarizeUpdate('merge', [result('error', 0), result('updated', 1)]);
    assert.ok(/failed/i.test(updateInfoHeadline(s)));
  });
});

describe('UpdateInfoTab', () => {
  it('holds the latest summary and emits onStateChange', () => {
    const states: Array<{ summary: ReturnType<typeof summarizeUpdate> | undefined }> = [];
    const tab = new UpdateInfoTab({ onStateChange: (s) => states.push({ summary: s.summary }) });
    const summary = summarizeUpdate('rebase', [
      { name: 'r', rootPath: '/r', branch: 'main', rebase: true, incoming: 2, status: 'updated' },
    ]);
    tab.setSummary(summary);
    assert.strictEqual(tab.getState().summary, summary);
    assert.strictEqual(states.length, 1);
    assert.strictEqual(states[0].summary, summary);
  });

  it('updateInfo.refresh re-emits the current state', () => {
    let emits = 0;
    const tab = new UpdateInfoTab({ onStateChange: () => (emits += 1) });
    tab.handleMessage({ type: 'updateInfo.refresh' });
    assert.strictEqual(emits, 1);
  });

  it('updateInfo.jumpToCommit routes through the hook', () => {
    const jumped: string[] = [];
    const tab = new UpdateInfoTab({ jumpToCommit: (h) => jumped.push(h) });
    tab.handleMessage({ type: 'updateInfo.jumpToCommit', hash: 'abc123' });
    assert.deepStrictEqual(jumped, ['abc123']);
  });

  it('ignores malformed messages', () => {
    let emits = 0;
    const tab = new UpdateInfoTab({ onStateChange: () => (emits += 1) });
    tab.handleMessage({} as never);
    tab.handleMessage({ type: 'updateInfo.unknown' });
    assert.strictEqual(emits, 0);
  });
});
