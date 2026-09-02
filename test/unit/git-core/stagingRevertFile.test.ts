/**
 * StagingOps.revertFile must restore from HEAD, not the index.
 *
 * The old `git checkout -- <path>` restores from the INDEX, so a partially-
 * staged file kept its staged edits after "Revert" claimed to discard all
 * changes (the confirm dialog promises "cannot be undone"). It now routes
 * through the shared restore-to-HEAD writer: `git checkout HEAD -- <path>`
 * for a tracked file, and an unindex for a file that is only ADDED.
 */

import '../../setup';
import * as assert from 'assert';
import { StagingOps } from '../../../src/git-core/ops/StagingOps';
import { IGitOpsContext } from '../../../src/git-core/ops/GitOpsContext';
import { IRepository } from '../../../src/git-core/interfaces/IGitService';
import { literalPathspec } from '../../../src/git-core/gitCli';

interface ExecCall {
  args: string[];
}

/** Stub whose `cat-file -e HEAD:<path>` exit is scripted per path. */
function makeOps(inHead: Set<string>): { ops: StagingOps; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const gitCli = {
    exec: async (args: string[]) => {
      calls.push({ args });
      if (args[0] === 'cat-file' && args[1] === '-e') {
        const spec = args[2].replace(/^HEAD:/, '');
        return { exitCode: inHead.has(spec) ? 0 : 1, stdout: '', stderr: '', combined: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  };
  const ctx = {
    gitCli,
    invalidateCache: () => undefined,
    fireDidFetch: () => undefined,
  } as unknown as IGitOpsContext;
  return { ops: new StagingOps(ctx), calls };
}

const repo = (): IRepository => ({ rootUri: { fsPath: '/r' } }) as unknown as IRepository;

describe('StagingOps.revertFile', () => {
  it('restores a tracked file from HEAD (checkout HEAD --), not from the index', async () => {
    const { ops, calls } = makeOps(new Set(['src/a.ts']));
    const result = await ops.revertFile(repo(), 'src/a.ts');
    assert.ok(result.isOk());
    const checkout = calls.find((c) => c.args[0] === 'checkout');
    assert.ok(checkout, 'expected a checkout call');
    assert.deepStrictEqual(checkout.args, ['checkout', 'HEAD', '--', literalPathspec('src/a.ts')]);
    // The old bug was `checkout -- <path>` (index restore) with no HEAD.
    assert.ok(!calls.some((c) => c.args[0] === 'checkout' && c.args[1] === '--'));
  });

  it('unindexes an added-only file instead of a fatal checkout', async () => {
    const { ops, calls } = makeOps(new Set()); // not in HEAD → added
    const result = await ops.revertFile(repo(), 'new.ts');
    assert.ok(result.isOk());
    assert.ok(
      calls.some((c) => c.args[0] === 'rm' && c.args.includes('--cached')),
      'an added-only file must be unindexed, not checked out'
    );
    assert.ok(!calls.some((c) => c.args[0] === 'checkout' && c.args[1] === 'HEAD'));
  });
});
