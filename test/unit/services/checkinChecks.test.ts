/**
 * Unit tests for the before-commit check I/O shell (CheckinChecks.ts):
 *  - gatherCheckinContext reads user.name/user.email via the gitCli hatch,
 *    maps committed paths onto working-tree statuses, and detects detached
 *    HEAD.
 *  - The unresolved flag fires (no false positive) when the hatch is absent.
 *  - formatCheckinProblems orders errors before warnings.
 */

import '../../setup';
import * as assert from 'assert';
import { gatherCheckinContext, formatCheckinProblems } from '../../../src/commits/CheckinChecks';
import { runCheckinHandlers } from '../../../src/commits/CheckinHandlers';
import type {
  IGitService,
  IRepository,
  IFileStatus,
} from '../../../src/git-core/interfaces/IGitService';
import { Uri } from '../../mocks/vscode';

function makeRepo(): IRepository {
  return {
    rootUri: Uri.file('/test-repo'),
    state: 'idle',
    head: { name: 'refs/heads/main', ahead: 0, behind: 0 },
    remotes: [],
    submodules: [],
  } as unknown as IRepository;
}

interface FakeCliConfig {
  userName?: string;
  userEmail?: string;
  detached?: boolean;
}

/**
 * Build a gitService stub that exposes a `gitCli` whose `exec` answers the
 * three queries gatherCheckinContext issues:
 *   - config --get user.name / user.email
 *   - symbolic-ref -q HEAD (exit !=0 ⇒ detached)
 */
function makeGitServiceWithCli(statuses: IFileStatus[], cfg: FakeCliConfig): IGitService {
  const exec = async (
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string; combined: string }> => {
    if (args[0] === 'config' && args[2] === 'user.name') {
      return ok(cfg.userName ?? '');
    }
    if (args[0] === 'config' && args[2] === 'user.email') {
      return ok(cfg.userEmail ?? '');
    }
    if (args[0] === 'symbolic-ref') {
      return cfg.detached
        ? { exitCode: 1, stdout: '', stderr: 'detached', combined: 'detached' }
        : ok('refs/heads/main');
    }
    return ok('');
  };
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', combined: stdout });
  return {
    getStatus: async () => statuses,
    gitCli: { exec },
  } as unknown as IGitService;
}

describe('gatherCheckinContext', () => {
  it('reads user.name/user.email and maps committed-path statuses', async () => {
    const statuses: IFileStatus[] = [
      { path: 'a.ts', indexStatus: 'M', workTreeStatus: ' ' },
      { path: 'c.ts', indexStatus: 'U', workTreeStatus: 'U' },
      { path: 'untouched.ts', indexStatus: 'M', workTreeStatus: ' ' },
    ];
    const git = makeGitServiceWithCli(statuses, {
      userName: 'Kit',
      userEmail: 'k@e.com',
    });
    const ctx = await gatherCheckinContext(git, makeRepo(), ['a.ts', 'c.ts']);
    assert.strictEqual(ctx.userName, 'Kit');
    assert.strictEqual(ctx.userEmail, 'k@e.com');
    assert.strictEqual(ctx.userIdentityResolved, true);
    assert.strictEqual(ctx.detachedHead, false);
    // Only committed paths are present; c.ts maps to conflicted.
    assert.deepStrictEqual(ctx.files.map((f) => `${f.path}:${f.status}`).sort(), [
      'a.ts:modified',
      'c.ts:conflicted',
    ]);
  });

  it('classifies AA / DD / UU as conflicted (not just U on one side)', async () => {
    const statuses: IFileStatus[] = [
      { path: 'both-added.ts', indexStatus: 'A', workTreeStatus: 'A' },
      { path: 'both-deleted.ts', indexStatus: 'D', workTreeStatus: 'D' },
      { path: 'both-unmerged.ts', indexStatus: 'U', workTreeStatus: 'U' },
      // A plain added file (A + space) must NOT be classified as conflicted.
      { path: 'plain-add.ts', indexStatus: 'A', workTreeStatus: ' ' },
    ];
    const git = makeGitServiceWithCli(statuses, { userName: 'Kit', userEmail: 'k@e.com' });
    const ctx = await gatherCheckinContext(git, makeRepo(), [
      'both-added.ts',
      'both-deleted.ts',
      'both-unmerged.ts',
      'plain-add.ts',
    ]);
    const byPath = new Map(ctx.files.map((f) => [f.path, f.status]));
    assert.strictEqual(byPath.get('both-added.ts'), 'conflicted');
    assert.strictEqual(byPath.get('both-deleted.ts'), 'conflicted');
    assert.strictEqual(byPath.get('both-unmerged.ts'), 'conflicted');
    assert.strictEqual(byPath.get('plain-add.ts'), 'added');
  });

  it('treats empty user.name as unset', async () => {
    const git = makeGitServiceWithCli([], { userName: '', userEmail: 'k@e.com' });
    const ctx = await gatherCheckinContext(git, makeRepo(), []);
    assert.strictEqual(ctx.userName, undefined);
    assert.strictEqual(ctx.userIdentityResolved, true);
  });

  it('detects detached HEAD via symbolic-ref exit code', async () => {
    const git = makeGitServiceWithCli([], {
      userName: 'Kit',
      userEmail: 'k@e.com',
      detached: true,
    });
    const ctx = await gatherCheckinContext(git, makeRepo(), []);
    assert.strictEqual(ctx.detachedHead, true);
  });

  it('flags identity unresolved when the gitCli hatch is absent (no false positive)', async () => {
    const git = {
      getStatus: async () => [],
    } as unknown as IGitService;
    const ctx = await gatherCheckinContext(git, makeRepo(), []);
    assert.strictEqual(ctx.userIdentityResolved, false);
  });

  it('surfaces a status-read failure instead of silently passing the conflict check', async () => {
    // Regression: a getStatus throw used to swallow to files:[], so the
    // unresolved-merge check saw no conflicts and the commit proceeded with no
    // warning (fail-open). Now the failure is captured + surfaced as a warning.
    const git = {
      getStatus: async () => {
        throw new Error('status read failed');
      },
      gitCli: {
        exec: async (args: string[]) => {
          // Provide a valid identity so the ONLY surfaced problem is the
          // status-read warning (isolates this test from the user.name check).
          if (args[0] === 'config' && args[2] === 'user.name') {
            return { exitCode: 0, stdout: 'Kit\n', stderr: '', combined: 'Kit\n' };
          }
          if (args[0] === 'config' && args[2] === 'user.email') {
            return { exitCode: 0, stdout: 'k@e.com\n', stderr: '', combined: 'k@e.com\n' };
          }
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
      },
    } as unknown as IGitService;
    const ctx = await gatherCheckinContext(git, makeRepo(), ['a.ts']);
    assert.strictEqual(ctx.statusReadFailed, true, 'status-read failure must be flagged');
    assert.deepStrictEqual(ctx.files, [], 'no files when status could not be read');

    const result = runCheckinHandlers(ctx);
    const warn = result.problems.find((p) => p.handlerId === 'git.status.read');
    assert.ok(warn, 'a status-read warning problem must be surfaced');
    assert.strictEqual(warn?.severity, 'warning', 'must be non-blocking');
    assert.strictEqual(result.hasBlockingProblem, false, 'a status-read failure must not block');
  });
});

describe('formatCheckinProblems', () => {
  it('orders errors before warnings', () => {
    const out = formatCheckinProblems([
      { handlerId: 'w', text: 'a warning', severity: 'warning' },
      { handlerId: 'e', text: 'an error', severity: 'error' },
    ]);
    const errIdx = out.indexOf('an error');
    const warnIdx = out.indexOf('a warning');
    assert.ok(errIdx >= 0 && warnIdx >= 0);
    assert.ok(errIdx < warnIdx, 'errors should be listed before warnings');
  });
});
