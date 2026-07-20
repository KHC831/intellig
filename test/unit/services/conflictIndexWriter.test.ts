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
    assert.deepStrictEqual(calls[0], ['checkout', '--theirs', '--', 'f.txt']);
  });

  it('git-rm-s when the wanted stage is absent (AU + accept theirs)', async () => {
    const calls: string[][] = [];
    const writer = new ConflictIndexWriter(fakeGitCli(calls));
    const needsStage = await writer.takeSide('/r', 'f.txt', '--theirs', oursOnly);
    assert.strictEqual(needsStage, false);
    assert.deepStrictEqual(calls[0], ['rm', '--', 'f.txt']);
  });

  it('falls through to checkout for an unknown (non-unmerged) entry', async () => {
    const calls: string[][] = [];
    const writer = new ConflictIndexWriter(fakeGitCli(calls));
    const needsStage = await writer.takeSide('/r', 'f.txt', '--ours', undefined);
    assert.strictEqual(needsStage, true);
    assert.strictEqual(calls[0][0], 'checkout');
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
});

describe('ConflictIndexWriter.restoreConflict', () => {
  it('recreates the conflict with `checkout --merge -- <path>`', async () => {
    const calls: string[][] = [];
    const writer = new ConflictIndexWriter(fakeGitCli(calls));
    await writer.restoreConflict('/r', 'f.txt');
    assert.deepStrictEqual(calls[0], ['checkout', '--merge', '--', 'f.txt']);
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
