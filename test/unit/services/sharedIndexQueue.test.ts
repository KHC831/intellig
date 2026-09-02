/**
 * Per-repo index serialization is a REPO-LEVEL primitive owned by GitService
 * (`withIndexLock`), not a conflicts-local detail.
 *
 * Previously ConflictResolutionService owned a private RepoCommandQueue, so
 * only conflict accepts serialized with each other; MergeView's synthetic
 * merge-base injection (read stages → hash-object → update-index, an index
 * WRITE) ran unqueued and could interleave with a bulk accept — worst case
 * re-writing unmerged stages for a path the bulk had just resolved. Both
 * surfaces now acquire the ONE GitService-owned lock.
 */

import '../../setup';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { okAsync } from 'neverthrow';
import { GitService } from '../../../src/git-core/GitService';
import { RepoCommandQueue } from '../../../src/git-core/repoCommandQueue';
import { ConflictResolutionService } from '../../../src/conflicts/ConflictResolutionService';
import { MergeView } from '../../../src/conflicts/MergeView';
import { GitError } from '../../../src/git-core/errors';
import { IGitService, IRepository } from '../../../src/git-core/interfaces/IGitService';

const ROOT = '/repo';

function makeRepo(): IRepository {
  return {
    rootUri: vscode.Uri.file(ROOT),
    state: 'merging',
    head: { name: 'main', commit: 'deadbeef', ahead: 0, behind: 0 },
    remotes: [],
  } as unknown as IRepository;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('GitService.withIndexLock', () => {
  it('serializes callbacks per repository root', async () => {
    const gitService = new GitService();
    try {
      const order: string[] = [];
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => (releaseFirst = resolve));

      const first = gitService.withIndexLock(ROOT, async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
      });
      const second = gitService.withIndexLock(ROOT, async () => {
        order.push('second');
      });

      await tick();
      assert.deepStrictEqual(order, ['first:start'], 'second must wait for first');
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepStrictEqual(order, ['first:start', 'first:end', 'second']);
    } finally {
      gitService.dispose();
    }
  });
});

describe('ConflictResolutionService uses the shared index lock', () => {
  it('routes a per-file accept through gitService.withIndexLock', async () => {
    const lockedRoots: string[] = [];
    const gitService: Partial<IGitService> & {
      gitCli: unknown;
      withIndexLock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
    } = {
      gitCli: {
        // `ls-files -u` has to report the path as unmerged: an accept on a
        // path with no conflict is refused before it reaches the lock.
        exec: async (args: string[]) => ({
          exitCode: 0,
          stdout:
            args[0] === 'ls-files'
              ? `100644 ${'2'.repeat(40)} 2\tsrc/conflict.ts\x00` +
                `100644 ${'3'.repeat(40)} 3\tsrc/conflict.ts\x00`
              : '',
          stderr: '',
          combined: '',
        }),
        onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
      },
      onDidChangeRepository: () => ({ dispose: (): void => {} }),
      getStatus: () => Promise.resolve([]),
      stage: () => okAsync<void, GitError>(undefined),
      withIndexLock: async <T>(root: string, fn: () => Promise<T>): Promise<T> => {
        lockedRoots.push(root);
        return fn();
      },
    };

    const service = new ConflictResolutionService(gitService as unknown as IGitService);
    try {
      const result = await service.acceptCurrent(makeRepo(), 'src/conflict.ts');
      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(
        lockedRoots,
        [ROOT],
        'the accept must run under the SHARED GitService lock, not a private queue'
      );
    } finally {
      service.dispose();
    }
  });
});

describe('MergeView synthetic-base injection uses the shared index lock', () => {
  it('does not touch the index while another holder owns the lock', async () => {
    const repo = makeRepo();
    const queue = new RepoCommandQueue();
    const execVerbs: string[] = [];
    const gitService: Partial<IGitService> & {
      gitCli: unknown;
      withIndexLock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
    } = {
      getRepository: (): Promise<IRepository> => Promise.resolve(repo),
      getRepositories: (): IRepository[] => [repo],
      gitCli: {
        exec: async (args: string[]) => {
          execVerbs.push(args.find((a) => !a.startsWith('-')) ?? '');
          return { exitCode: 0, stdout: '', stderr: '', combined: '' };
        },
        onCommandExecuted: (): { dispose: () => void } => ({ dispose: (): void => {} }),
      },
      withIndexLock: <T>(root: string, fn: () => Promise<T>): Promise<T> =>
        queue.withLock(root, fn),
    };
    const mergeView = new MergeView(
      vscode.Uri.file('/mock/extension'),
      gitService as unknown as IGitService
    );

    try {
      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => (releaseHolder = resolve));
      const holder = queue.withLock(ROOT, () => holderGate);

      const showing = mergeView.show(`${ROOT}/a.ts`);
      await tick();
      assert.deepStrictEqual(
        execVerbs,
        [] as string[],
        'the stage read/index write must WAIT for the lock holder'
      );

      releaseHolder();
      await holder;
      await showing;
      assert.ok(
        execVerbs.includes('ls-files'),
        `after the lock releases the injection must proceed (got: ${execVerbs.join(', ')})`
      );
    } finally {
      mergeView.dispose();
    }
  });
});
