/**
 * Index writes for a single repo must be serialized. git's index is one
 * resource guarded by `.git/index.lock`; two concurrent `checkout`+`add` runs
 * collide ("Unable to create index.lock"). The dialog fires per-file accepts
 * fire-and-forget, so different-row accepts arrive concurrently — the service
 * must serialize them so no two index mutations overlap.
 *
 * Deterministic: a mock `gitCli` counts in-flight index-mutating commands and
 * records the peak concurrency. Without serialization the peak is 2.
 */

import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import { IGitCommandResult } from '../../../src/git-core/gitCli';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function makeService(): {
  service: ConflictResolutionService;
  repo: IRepository;
  peakConcurrency: () => number;
} {
  let inFlight = 0;
  let peak = 0;
  const isIndexWrite = (args: string[]): boolean => args[0] === 'checkout' || args[0] === 'rm';

  const gitCli = {
    exec: async (args: string[]): Promise<IGitCommandResult> => {
      // Serve the stage model: one both-modified file per accepted path.
      if (args[0] === 'ls-files' && args.includes('-u')) {
        const dashDash = args.indexOf('--');
        const only = dashDash >= 0 ? args[dashDash + 1] : 'x';
        const out = `100644 ${'2'.repeat(40)} 2\t${only}\u0000100644 ${'3'.repeat(40)} 3\t${only}\u0000`;
        return { exitCode: 0, stdout: out, stderr: '', combined: out };
      }
      if (isIndexWrite(args)) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(); // hold the "index lock" open across a turn
        await tick();
        inFlight--;
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  };

  const gitService = {
    getStatus: async () => [],
    stage: () => okAsync(undefined),
    getRepositories: () => [],
    onDidChangeRepository: () => ({ dispose: () => undefined }),
    gitCli,
  } as unknown as IGitService;

  const service = new ConflictResolutionService(gitService);
  const repo = {
    rootUri: { fsPath: '/repo' },
    state: 'merging',
  } as unknown as IRepository;
  return { service, repo, peakConcurrency: () => peak };
}

describe('conflict accept — index writes serialize per repo', () => {
  it('two concurrent different-row accepts do not overlap their index mutations', async () => {
    const { service, repo, peakConcurrency } = makeService();

    await Promise.all([
      service.acceptCurrent(repo, 'a.ts', false),
      service.acceptIncoming(repo, 'b.ts', false),
    ]);

    assert.strictEqual(
      peakConcurrency(),
      1,
      'index-mutating commands must never run concurrently for one repo'
    );
  });
});
