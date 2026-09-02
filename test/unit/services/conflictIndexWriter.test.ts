/**
 * Unit tests for Layer 1 ConflictIndexWriter + the fault-injection seam it gives
 * the orchestrator (a test double can now stand in for the git index plumbing).
 */

import * as assert from 'assert';
import { okAsync } from 'neverthrow';
import {
  ConflictIndexWriter,
  IConflictIndexWriter,
} from '../../../src/conflicts/conflictIndexWriter';
import { IUnmergedEntry } from '../../../src/conflicts/conflictStageModel';
import { GitCli } from '../../../src/git-core/gitCli';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

function fakeGitCli(record: string[][]): GitCli {
  return {
    exec: async (args: string[]) => {
      record.push(args);
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  } as unknown as GitCli;
}

const bothStages: IUnmergedEntry = {
  stage2: { mode: 'm', sha: 's2' },
  stage3: { mode: 'm', sha: 's3' },
};
const oursOnly: IUnmergedEntry = { stage2: { mode: 'm', sha: 's2' } };

describe('ConflictIndexWriter.takeSide', () => {
  it('checks out the wanted side when its stage is present', async () => {
    const calls: string[][] = [];
    const writer = new ConflictIndexWriter(fakeGitCli(calls));
    const needsStage = await writer.takeSide('/r', 'f.txt', '--theirs', bothStages);
    assert.strictEqual(needsStage, true);
    assert.deepStrictEqual(calls[0], ['checkout', '--theirs', '--', ':(literal)f.txt']);
  });

  it('git-rm-s when the wanted stage is absent (AU + accept theirs)', async () => {
    const calls: string[][] = [];
    const writer = new ConflictIndexWriter(fakeGitCli(calls));
    const needsStage = await writer.takeSide('/r', 'f.txt', '--theirs', oursOnly);
    assert.strictEqual(needsStage, false);
    assert.deepStrictEqual(calls[0], ['rm', '--', ':(literal)f.txt']);
  });

  it('falls through to checkout when the index could not be read', async () => {
    // Unknown is not the same as not-conflicted: an unreadable index leaves
    // the stage model unknown, and checkout with throwOnError fails loudly
    // rather than refusing a resolve the user can still complete.
    const calls: string[][] = [];
    const writer = new ConflictIndexWriter(fakeGitCli(calls));
    const needsStage = await writer.takeSide('/r', 'f.txt', '--ours', undefined, false);
    assert.strictEqual(needsStage, true);
    assert.strictEqual(calls[0][0], 'checkout');
  });

  it('refuses when the index is readable and the path is not unmerged', async () => {
    // `git checkout --ours` exits 0 on an ordinary file and rewrites it from
    // HEAD, so this is where uncommitted work would go.
    const calls: string[][] = [];
    const writer = new ConflictIndexWriter(fakeGitCli(calls));
    await assert.rejects(
      () => writer.takeSide('/r', 'f.txt', '--ours', undefined),
      /no merge conflict/i
    );
    assert.deepStrictEqual(calls, [], 'no git command runs at all');
  });
});

describe('ConflictResolutionService — injected index writer (fault injection)', () => {
  it('surfaces a writer failure as an accept error instead of throwing', async () => {
    const faultWriter: IConflictIndexWriter = {
      readStages: async () => ({ ok: true as const, stages: new Map([['f.txt', bothStages]]) }),
      takeSide: async () => {
        throw new Error('index locked');
      },
      restoreConflict: async () => undefined,
    };
    const gitService = {
      getStatus: async () => [],
      stage: () => okAsync(undefined),
      getRepositories: () => [],
      onDidChangeRepository: () => ({ dispose: () => undefined }),
    } as unknown as IGitService;

    const service = new ConflictResolutionService(gitService, faultWriter);
    const repo = { rootUri: { fsPath: '/r' }, state: 'merging' } as unknown as IRepository;

    const res = await service.acceptCurrent(repo, 'f.txt', false);
    assert.strictEqual(res.success, false);
    assert.ok(res.error && res.error.includes('index locked'), res.error);
    service.dispose();
  });

  // `_acceptSide` threads `readStages()`'s `.ok` through to `takeSide` as
  // `indexReadable` — this is the ONE place that fact reaches takeSide, and
  // nothing else pins it. `takeSide`'s own unit tests
  // (above) only prove the function behaves correctly GIVEN the right
  // argument; they cannot see whether the orchestrator hands it the right
  // one.
  it('threads a failed index read through to takeSide as indexReadable=false, not the refusing default', async () => {
    let capturedIndexReadable: boolean | undefined;
    const faultWriter: IConflictIndexWriter = {
      readStages: async () => ({ ok: false as const, stderr: 'index read failed' }),
      takeSide: async (_root, _filePath, _flag, _entry, indexReadable) => {
        capturedIndexReadable = indexReadable;
        // The documented escape: falls through to checkout and succeeds,
        // rather than refusing with "no merge conflict to resolve".
        return true;
      },
      restoreConflict: async () => undefined,
    };
    const gitService = {
      getStatus: async () => [],
      stage: () => okAsync(undefined),
      getRepositories: () => [],
      onDidChangeRepository: () => ({ dispose: () => undefined }),
    } as unknown as IGitService;

    const service = new ConflictResolutionService(gitService, faultWriter);
    const repo = { rootUri: { fsPath: '/r' }, state: 'merging' } as unknown as IRepository;

    const res = await service.acceptCurrent(repo, 'f.txt', false);

    assert.strictEqual(
      capturedIndexReadable,
      false,
      'a failed readStages() must reach takeSide as indexReadable=false, not undefined/true'
    );
    assert.strictEqual(
      res.success,
      true,
      `an unreadable index must fall through to checkout, not report a refusal; got: ${JSON.stringify(res)}`
    );
    service.dispose();
  });
});

describe('ConflictIndexWriter.restoreConflict', () => {
  it('recreates the conflict with `checkout --merge -- <path>`', async () => {
    const calls: string[][] = [];
    const writer = new ConflictIndexWriter(fakeGitCli(calls));
    await writer.restoreConflict('/r', 'f.txt');
    assert.deepStrictEqual(calls[0], ['checkout', '--merge', '--', ':(literal)f.txt']);
  });
});

describe('ConflictResolutionService.unresolveFile', () => {
  function makeGitServiceStub(): IGitService {
    return {
      getStatus: async () => [],
      stage: () => okAsync(undefined),
      getRepositories: () => [],
      onDidChangeRepository: () => ({ dispose: () => undefined }),
    } as unknown as IGitService;
  }

  it('restores the conflict through the writer and reports success', async () => {
    const restored: string[] = [];
    const writer: IConflictIndexWriter = {
      readStages: async () => ({ ok: true as const, stages: new Map() }),
      takeSide: async () => true,
      restoreConflict: async (_root: string, filePath: string) => {
        restored.push(filePath);
      },
    };
    const service = new ConflictResolutionService(makeGitServiceStub(), writer);
    const repo = { rootUri: { fsPath: '/r' }, state: 'merging' } as unknown as IRepository;

    const res = await service.unresolveFile(repo, 'f.txt');
    assert.strictEqual(res.success, true);
    assert.deepStrictEqual(restored, ['f.txt']);
    service.dispose();
  });

  it('surfaces a writer failure as a sanitized error result', async () => {
    const writer: IConflictIndexWriter = {
      readStages: async () => ({ ok: true as const, stages: new Map() }),
      takeSide: async () => true,
      restoreConflict: async () => {
        throw new Error("error: path 'f.txt' does not have merge information");
      },
    };
    const service = new ConflictResolutionService(makeGitServiceStub(), writer);
    const repo = { rootUri: { fsPath: '/r' }, state: 'merging' } as unknown as IRepository;

    const res = await service.unresolveFile(repo, 'f.txt');
    assert.strictEqual(res.success, false);
    assert.ok(res.error && res.error.includes('merge information'), res.error);
    service.dispose();
  });
});
