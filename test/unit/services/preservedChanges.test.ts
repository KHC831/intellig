/**
 * The shared save-local-changes bracket (git4idea GitPreservingProcess
 * counterpart) — see src/git-core/ops/preservedChanges.ts.
 */

import '../../setup';
import * as assert from 'assert';
import { GitCli } from '../../../src/git-core/gitCli';
import {
  saveLocalChanges,
  restoreLocalChanges,
  withSavedChanges,
} from '../../../src/git-core/ops/preservedChanges';

const CWD = '/repo';

interface ScriptedCli {
  cli: GitCli;
  calls: string[][];
}

/** GitCli stub scripted by verb: `status` returns `statusOut`, `stash` pops/pushes per `stashExit`. */
function makeCli(statusOut: string, stashExit = 0, stashStderr = ''): ScriptedCli {
  const calls: string[][] = [];
  const cli = {
    exec: async (args: string[], options?: { throwOnError?: boolean }) => {
      calls.push([...args]);
      if (args[0] === 'status') {
        return { exitCode: 0, stdout: statusOut, stderr: '', combined: statusOut };
      }
      if (args[0] === 'stash') {
        if (stashExit !== 0 && options?.throwOnError) {
          throw new Error(`stash failed: ${stashStderr}`);
        }
        return { exitCode: stashExit, stdout: '', stderr: stashStderr, combined: stashStderr };
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  } as unknown as GitCli;
  return { cli, calls };
}

describe('saveLocalChanges', () => {
  it('is a no-op on a clean tree', async () => {
    const { cli, calls } = makeCli('');
    const result = await saveLocalChanges(cli, CWD, 'label');
    assert.deepStrictEqual(result, { status: 'clean' });
    assert.ok(!calls.some((c) => c[0] === 'stash'), 'no stash on a clean tree');
  });

  it('stashes a dirty tree with untracked files included and the given label', async () => {
    const { cli, calls } = makeCli('M  staged.ts\0?? new.ts\0');
    const result = await saveLocalChanges(cli, CWD, 'Auto-stash before drop');
    assert.deepStrictEqual(result, { status: 'saved' });
    const stash = calls.find((c) => c[0] === 'stash');
    assert.ok(stash, 'stash push must run');
    assert.ok(stash.includes('--include-untracked'));
    assert.ok(stash.includes('Auto-stash before drop'));
  });

  it('refuses on unmerged files — including AA/DD which carry no U column', async () => {
    for (const line of ['UU both.ts\0', 'AA both-added.ts\0', 'DD both-deleted.ts\0']) {
      const { cli, calls } = makeCli(line);
      const result = await saveLocalChanges(cli, CWD, 'label');
      assert.deepStrictEqual(result, { status: 'blocked-unmerged' }, `for status "${line}"`);
      assert.ok(!calls.some((c) => c[0] === 'stash'), 'must never stash over a conflict');
    }
  });
});

describe('restoreLocalChanges', () => {
  it('reports a clean pop', async () => {
    const { cli } = makeCli('', 0);
    assert.deepStrictEqual(await restoreLocalChanges(cli, CWD), { status: 'restored' });
  });

  it('reports a failed pop with sanitized detail and never throws', async () => {
    const { cli } = makeCli('', 1, 'error: could not apply /Users/alice/repo/x.ts');
    const result = await restoreLocalChanges(cli, CWD);
    assert.strictEqual(result.status, 'failed');
    if (result.status === 'failed') {
      assert.ok(!result.detail.includes('/Users/alice/'), 'home path must be scrubbed');
    }
  });
});

describe('withSavedChanges', () => {
  it('runs the op and restores when the tree was dirty', async () => {
    const { cli, calls } = makeCli('M  staged.ts\0');
    let ran = false;
    const outcome = await withSavedChanges(cli, CWD, 'label', async () => {
      ran = true;
      return 42;
    });
    assert.ok(ran);
    assert.deepStrictEqual(outcome, {
      status: 'done',
      result: 42,
      restore: { status: 'restored' },
    });
    const stashCalls = calls.filter((c) => c[0] === 'stash').map((c) => c[1]);
    assert.deepStrictEqual(stashCalls, ['push', 'pop'], 'push before the op, pop after');
  });

  it('never runs the op when unmerged files block the save', async () => {
    const { cli } = makeCli('UU both.ts\0');
    let ran = false;
    const outcome = await withSavedChanges(cli, CWD, 'label', async () => {
      ran = true;
    });
    assert.strictEqual(outcome.status, 'blocked-unmerged');
    assert.strictEqual(ran, false);
  });

  it('restores even when the op throws, then re-throws the op error', async () => {
    const { cli, calls } = makeCli('M  staged.ts\0');
    await assert.rejects(
      withSavedChanges(cli, CWD, 'label', async () => {
        throw new Error('op exploded');
      }),
      /op exploded/
    );
    const stashCalls = calls.filter((c) => c[0] === 'stash').map((c) => c[1]);
    assert.deepStrictEqual(stashCalls, ['push', 'pop'], 'the stash must be restored on op failure');
  });

  it('skips the restore entirely on a clean tree', async () => {
    const { cli, calls } = makeCli('');
    const outcome = await withSavedChanges(cli, CWD, 'label', async () => 'ok');
    assert.deepStrictEqual(outcome, {
      status: 'done',
      result: 'ok',
      restore: { status: 'not-needed' },
    });
    assert.ok(!calls.some((c) => c[0] === 'stash'));
  });
});
