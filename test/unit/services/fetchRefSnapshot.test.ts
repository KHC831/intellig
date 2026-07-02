/**
 * Fetch reports updated refs via a before/after ref snapshot — NOT
 * `git fetch --porcelain`.
 *
 * `--porcelain` requires git ≥ 2.41 (mid-2023): on Ubuntu 22.04 (2.34) /
 * Debian 12 (2.39) every fetch — manual, Pull pre-fetch, AutoFetch tick,
 * Update Project — hard-failed with `error: unknown option 'porcelain'`,
 * and AutoFetch degraded silently (transient backoff, no toast). The
 * snapshot approach (`git for-each-ref` before + after, diffed) works on
 * every supported git with one code path and no version probe.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository, IFetchResult } from '../../../src/git-core/interfaces/IGitService';
import { diffRefSnapshots } from '../../../src/git-core/ops/RemoteOps';
import { Uri } from '../../mocks/vscode';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEW2 = 'c'.repeat(40);
const ZERO = '0'.repeat(40);

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test/repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [{ name: 'origin' }],
    submodules: [],
  };
}

interface IExecCall {
  args: string[];
}

/**
 * Install a scripted GitCli stub: `for-each-ref` returns the FIRST snapshot
 * until a `fetch` runs, then the SECOND. Everything else exits 0.
 */
function installGitService(
  beforeSnapshot: string,
  afterSnapshot: string,
  fetchStderr = ''
): { gitService: GitService; calls: IExecCall[] } {
  const gitService = new GitService();
  const calls: IExecCall[] = [];
  let fetched = false;
  const gitCli = {
    onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
    exec: async (args: string[]) => {
      calls.push({ args });
      const verb = args.find((a) => !a.startsWith('-'));
      if (verb === 'for-each-ref') {
        const stdout = fetched ? afterSnapshot : beforeSnapshot;
        return { exitCode: 0, stdout, stderr: '', combined: stdout };
      }
      if (verb === 'fetch') {
        fetched = true;
        return { exitCode: 0, stdout: '', stderr: fetchStderr, combined: fetchStderr };
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  };
  (gitService as unknown as { _gitCli: unknown })._gitCli = gitCli;
  return { gitService, calls };
}

function snapshotLine(ref: string, sha: string): string {
  return `${ref}\x1f${sha}`;
}

async function runFetch(
  beforeSnapshot: string,
  afterSnapshot: string,
  fetchStderr = ''
): Promise<{ result: IFetchResult; calls: IExecCall[] }> {
  const { gitService, calls } = installGitService(beforeSnapshot, afterSnapshot, fetchStderr);
  const result = await gitService.fetch(makeRepo(), 'origin');
  assert.ok(result.isOk(), 'fetch should resolve Ok');
  return { result: result._unsafeUnwrap(), calls };
}

describe('RemoteOps fetch ref-snapshot reporting', () => {
  it('never passes --porcelain (git < 2.41 compatibility)', async () => {
    const { calls } = await runFetch('', '');
    const fetchCall = calls.find((c) => c.args.find((a) => !a.startsWith('-')) === 'fetch');
    assert.ok(fetchCall, 'a fetch must have run');
    assert.ok(
      !fetchCall.args.includes('--porcelain'),
      `fetch argv must not contain --porcelain (got: ${fetchCall.args.join(' ')})`
    );
  });

  it('reports a fast-forwarded ref from the before/after diff', async () => {
    const before = snapshotLine('refs/remotes/origin/main', OLD);
    const after = snapshotLine('refs/remotes/origin/main', NEW);
    const { result } = await runFetch(before, after);
    assert.deepStrictEqual(result.updatedRefs, [
      { ref: 'refs/remotes/origin/main', oldSha: OLD, newSha: NEW },
    ]);
  });

  it('reports created refs with an all-zero oldSha and pruned refs with an all-zero newSha', async () => {
    const before = [
      snapshotLine('refs/remotes/origin/main', OLD),
      snapshotLine('refs/remotes/origin/gone', NEW2),
    ].join('\n');
    const after = [
      snapshotLine('refs/remotes/origin/main', OLD),
      snapshotLine('refs/remotes/origin/feature', NEW),
    ].join('\n');
    const { result } = await runFetch(before, after);
    assert.deepStrictEqual(
      [...result.updatedRefs].sort((a, b) => a.ref.localeCompare(b.ref)),
      [
        { ref: 'refs/remotes/origin/feature', oldSha: ZERO, newSha: NEW },
        { ref: 'refs/remotes/origin/gone', oldSha: NEW2, newSha: ZERO },
      ]
    );
  });

  it('reports nothing when the snapshots are identical (already up to date)', async () => {
    const snapshot = snapshotLine('refs/remotes/origin/main', OLD);
    const { result } = await runFetch(snapshot, snapshot);
    assert.deepStrictEqual(result.updatedRefs, []);
  });

  it('still collects non-informational stderr lines as non-fatal errors', async () => {
    const { result } = await runFetch('', '', 'warning: something odd happened\nFrom origin\n');
    assert.deepStrictEqual(result.errors, ['warning: something odd happened']);
  });
});

describe('diffRefSnapshots (pure)', () => {
  it('pads the zero sha to the object-id length of the other side (SHA-256 ready)', () => {
    const sha256 = 'd'.repeat(64);
    const updates = diffRefSnapshots(new Map(), new Map([['refs/remotes/origin/x', sha256]]));
    assert.deepStrictEqual(updates, [
      { ref: 'refs/remotes/origin/x', oldSha: '0'.repeat(64), newSha: sha256 },
    ]);
  });

  it('ignores unchanged refs and reports changed ones', () => {
    const before = new Map([
      ['refs/remotes/origin/same', OLD],
      ['refs/remotes/origin/moved', OLD],
    ]);
    const after = new Map([
      ['refs/remotes/origin/same', OLD],
      ['refs/remotes/origin/moved', NEW],
    ]);
    assert.deepStrictEqual(diffRefSnapshots(before, after), [
      { ref: 'refs/remotes/origin/moved', oldSha: OLD, newSha: NEW },
    ]);
  });
});
