/**
 * Accept-all resolves every conflicted path in one batch, so what it does when
 * the index cannot be READ decides whether the user is told the truth.
 *
 * `ls-files -u` runs with `throwOnError: false`. A failed read used to arrive as
 * an empty map, indistinguishable from "nothing is conflicted", so the batch
 * returned early, nothing threw, and the caller toasted "Accepted … for all
 * conflicted files" over a repository it had not touched — on an operation the
 * user confirmed knowing one side would be discarded.
 *
 * The two controls matter as much as the failing case: a healthy repo must
 * still resolve (or the harness proves nothing), and a genuinely conflict-free
 * repo must still be a silent success (or the fix is just a new false alarm).
 */

import '../../setup';
import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import { IConflictIndexWriter } from '../../../src/conflicts/conflictIndexWriter';
import { IUnmergedEntry } from '../../../src/conflicts/conflictStageModel';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';
import { GitError } from '../../../src/git-core/errors';

function makeRepo(): IRepository {
  return { rootUri: { fsPath: '/repo' } } as unknown as IRepository;
}

function makeGitService(): IGitService {
  return {
    gitCli: {
      exec: async () => ({ exitCode: 0, stdout: '', stderr: '', combined: '' }),
      onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
    },
    onDidChangeRepository: () => ({ dispose: (): void => {} }),
    getStatus: () => Promise.resolve([]),
    stage: () => okAsync<void, GitError>(undefined),
  } as unknown as IGitService;
}

const entry: IUnmergedEntry = {
  stage2: { mode: '100644', sha: '2'.repeat(40) },
  stage3: { mode: '100644', sha: '3'.repeat(40) },
};

/** Counts the calls that actually change the working tree or index. */
function makeWriter(read: () => ReturnType<IConflictIndexWriter['readStages']>): {
  writer: IConflictIndexWriter;
  mutatingCalls: () => number;
} {
  let calls = 0;
  return {
    writer: {
      readStages: read,
      takeSide: async () => {
        calls++;
        return true;
      },
      restoreConflict: async () => undefined,
    },
    mutatingCalls: () => calls,
  };
}

describe('accept-all when the index cannot be read', () => {
  it('FAILS instead of reporting success over a repository it never touched', async () => {
    const { writer, mutatingCalls } = makeWriter(async () => ({
      ok: false as const,
      stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    }));
    const service = new ConflictResolutionService(makeGitService(), writer);

    try {
      const result = await service.acceptAllCurrent(makeRepo());

      assert.strictEqual(mutatingCalls(), 0, 'nothing was resolved');
      assert.strictEqual(result.success, false, 'so it must not claim success');
    } finally {
      service.dispose();
    }
  });

  it('resolves every conflicted path when the index reads cleanly', async () => {
    // Control: without this, the failing case above could pass because the
    // harness never reaches the mutation at all.
    const { writer, mutatingCalls } = makeWriter(async () => ({
      ok: true as const,
      stages: new Map([['a.ts', entry]]),
    }));
    const service = new ConflictResolutionService(makeGitService(), writer);

    try {
      const result = await service.acceptAllCurrent(makeRepo());

      assert.strictEqual(result.success, true);
      assert.strictEqual(mutatingCalls(), 1, 'the one conflicted path was resolved');
    } finally {
      service.dispose();
    }
  });

  it('stays a silent success when the repository genuinely has no conflicts', async () => {
    // Control: an empty read on a SUCCESSFUL command is real information, and
    // must not become an error now that a failed read is one.
    const { writer, mutatingCalls } = makeWriter(async () => ({
      ok: true as const,
      stages: new Map(),
    }));
    const service = new ConflictResolutionService(makeGitService(), writer);

    try {
      const result = await service.acceptAllCurrent(makeRepo());

      assert.strictEqual(result.success, true);
      assert.strictEqual(mutatingCalls(), 0);
    } finally {
      service.dispose();
    }
  });

  it('still resolves a single file when the index read fails', async () => {
    // The per-file path deliberately keeps its old behaviour: takeSide routes an
    // unknown entry to checkout with throwOnError, so an absent stage fails
    // loudly rather than deleting the file. Refusing here would block a resolve
    // the user can still complete.
    const { writer, mutatingCalls } = makeWriter(async () => ({
      ok: false as const,
      stderr: 'fatal: index file open failed',
    }));
    const service = new ConflictResolutionService(makeGitService(), writer);

    try {
      await service.acceptCurrent(makeRepo(), 'a.ts');

      assert.strictEqual(mutatingCalls(), 1, 'the single-file accept still runs');
    } finally {
      service.dispose();
    }
  });
});
