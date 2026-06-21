/**
 * G item 1 — ref-aware log filter dropdowns.
 *
 * `getLogContributors` powers the author-filter datalist. It runs
 * `git shortlog -sne --all HEAD` and parses each `N\tName <email>` line into
 * `"Name <email>"`, preserving shortlog's commit-count ordering.
 */

import '../../setup';
import * as assert from 'assert';
import { GitService } from '../../../src/git-core/GitService';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';

interface ExecStub {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function makeService(stub: ExecStub): { service: GitService; calls: string[][] } {
  const calls: string[][] = [];
  const service = Object.create(GitService.prototype) as GitService;
  // RULE G1: swap the private `_gitCli` so the real binary is never invoked.
  (service as unknown as { _gitCli: unknown })._gitCli = {
    exec: async (args: string[]) => {
      calls.push(args);
      return stub;
    },
  };
  return { service, calls };
}

const repo = { rootUri: { fsPath: '/repo' } } as unknown as IRepository;

describe('GitService.getLogContributors — author datalist source (G1)', () => {
  it('parses each shortlog line into "Name <email>" in commit-count order', async () => {
    const { service, calls } = makeService({
      exitCode: 0,
      stdout: '   42\tAlice <alice@a.com>\n    7\tBob <bob@b.com>',
      stderr: '',
    });
    const result = await service.getLogContributors(repo);
    assert.deepStrictEqual(result, ['Alice <alice@a.com>', 'Bob <bob@b.com>']);
    assert.ok(
      calls[0].includes('shortlog') &&
        calls[0].includes('-sne') &&
        calls[0].includes('--all') &&
        calls[0].includes('HEAD'),
      'invokes git shortlog -sne --all HEAD'
    );
  });

  it('returns an empty array for empty stdout', async () => {
    const { service } = makeService({ exitCode: 0, stdout: '', stderr: '' });
    assert.deepStrictEqual(await service.getLogContributors(repo), []);
  });

  it('deduplicates repeated contributors, keeping first occurrence', async () => {
    const { service } = makeService({
      exitCode: 0,
      stdout: '  10\tAlice <alice@a.com>\n   5\tBob <bob@b.com>\n   1\tAlice <alice@a.com>',
      stderr: '',
    });
    assert.deepStrictEqual(await service.getLogContributors(repo), [
      'Alice <alice@a.com>',
      'Bob <bob@b.com>',
    ]);
  });

  it('slices the result to 500 entries when shortlog returns more', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 600; i++) {
      lines.push(`  ${600 - i}\tUser${i} <u${i}@x.com>`);
    }
    const { service } = makeService({ exitCode: 0, stdout: lines.join('\n'), stderr: '' });
    const result = await service.getLogContributors(repo);
    assert.strictEqual(result.length, 500);
    assert.strictEqual(result[0], 'User0 <u0@x.com>');
  });
});
