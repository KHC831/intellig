/**
 * The shared save-local-changes bracket (git4idea GitPreservingProcess
 * counterpart) — see src/git-core/ops/preservedChanges.ts.
 *
 * The restore is PINNED to the stash entry the save created: popping
 * `stash@{0}` blindly pops the WRONG stash when two brackets run on one repo
 * or the user (or git itself) created a stash mid-operation. git4idea's
 * GitStashChangesSaver records the stash commit and pops that entry.
 */

import '../../setup';
import * as assert from 'assert';
import { GitCli } from '../../../src/git-core/gitCli';
import {
  detectLocalChanges,
  saveLocalChanges,
  restoreLocalChanges,
  withSavedChanges,
} from '../../../src/git-core/ops/preservedChanges';

const CWD = '/repo';
const SHA = 'a'.repeat(40);

interface ScriptedCli {
  cli: GitCli;
  calls: string[][];
}

/**
 * GitCli stub scripted by verb: `status` returns `statusOut`; `stash push`
 * succeeds; `rev-parse refs/stash` returns `stashSha`; `stash list` returns
 * `listRows` (`[ref, sha]` pairs, newest first); `stash pop` exits `popExit`.
 */
function makeCli(
  statusOut: string,
  opts: {
    popExit?: number;
    popStderr?: string;
    stashSha?: string;
    listRows?: Array<[string, string]>;
  } = {}
): ScriptedCli {
  const { popExit = 0, popStderr = '', stashSha = SHA } = opts;
  const listRows = opts.listRows ?? [['stash@{0}', stashSha]];
  const calls: string[][] = [];
  const cli = {
    exec: async (args: string[], options?: { throwOnError?: boolean }) => {
      calls.push([...args]);
      if (args[0] === 'status') {
        return { exitCode: 0, stdout: statusOut, stderr: '', combined: statusOut };
      }
      if (args[0] === 'rev-parse') {
        return { exitCode: 0, stdout: `${stashSha}\n`, stderr: '', combined: '' };
      }
      if (args[0] === 'stash' && args[1] === 'list') {
        const out = listRows.map(([ref, sha]) => `${ref}\x1f${sha}`).join('\n') + '\n';
        return { exitCode: 0, stdout: out, stderr: '', combined: out };
      }
      if (args[0] === 'stash' && args[1] === 'pop') {
        if (popExit !== 0 && options?.throwOnError) {
          throw new Error(`stash failed: ${popStderr}`);
        }
        return { exitCode: popExit, stdout: '', stderr: popStderr, combined: popStderr };
      }
      return { exitCode: 0, stdout: '', stderr: '', combined: '' };
    },
  } as unknown as GitCli;
  return { cli, calls };
}

describe('detectLocalChanges', () => {
  it("reports 'clean' for an empty status and never mutates", async () => {
    const { cli, calls } = makeCli('');
    assert.strictEqual(await detectLocalChanges(cli, CWD), 'clean');
    assert.ok(
      calls.every((c) => c[0] === 'status'),
      'detection is a read-only probe'
    );
  });

  it("reports 'dirty' for tracked and untracked changes without stashing", async () => {
    for (const line of ['M  staged.ts\0', '?? new.ts\0', ' M unstaged.ts\0']) {
      const { cli, calls } = makeCli(line);
      assert.strictEqual(await detectLocalChanges(cli, CWD), 'dirty', `for status "${line}"`);
      assert.ok(!calls.some((c) => c[0] === 'stash'), 'must never stash');
    }
  });

  it("reports 'blocked-unmerged' for conflicts — including AA/DD with no U column", async () => {
    for (const line of ['UU both.ts\0', 'AA both-added.ts\0', 'DD both-deleted.ts\0']) {
      const { cli } = makeCli(line);
      assert.strictEqual(await detectLocalChanges(cli, CWD), 'blocked-unmerged');
    }
  });

  it('flags unmerged even when ordinary dirt is also present', async () => {
    const { cli } = makeCli('M  staged.ts\0UU both.ts\0');
    assert.strictEqual(await detectLocalChanges(cli, CWD), 'blocked-unmerged');
  });
});

describe('saveLocalChanges', () => {
  it('is a no-op on a clean tree', async () => {
    const { cli, calls } = makeCli('');
    const result = await saveLocalChanges(cli, CWD, 'label');
    assert.deepStrictEqual(result, { status: 'clean' });
    assert.ok(!calls.some((c) => c[0] === 'stash'), 'no stash on a clean tree');
  });

  it('stashes a dirty tree and returns the sha of the CREATED entry', async () => {
    const { cli, calls } = makeCli('M  staged.ts\0?? new.ts\0');
    const result = await saveLocalChanges(cli, CWD, 'Auto-stash before drop');
    assert.deepStrictEqual(result, { status: 'saved', stashSha: SHA });
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
  it('reports a clean pop of the pinned entry', async () => {
    const { cli } = makeCli('');
    assert.deepStrictEqual(await restoreLocalChanges(cli, CWD, SHA), { status: 'restored' });
  });

  it('pops the PINNED entry, not the head, when another stash sits on top', async () => {
    // A concurrent bracket / user stash landed after ours: our entry is now
    // stash@{1}. A blind `stash pop` would pop the OTHER stash into the tree
    // and strand our changes.
    const { cli, calls } = makeCli('', {
      listRows: [
        ['stash@{0}', 'b'.repeat(40)],
        ['stash@{1}', SHA],
      ],
    });
    const result = await restoreLocalChanges(cli, CWD, SHA);
    assert.deepStrictEqual(result, { status: 'restored' });
    const pop = calls.find((c) => c[0] === 'stash' && c[1] === 'pop');
    assert.ok(pop, 'pop must run');
    assert.ok(pop.includes('stash@{1}'), `must pop the pinned entry; got: ${pop.join(' ')}`);
  });

  it('fails WITHOUT popping anything when the pinned entry vanished from the list', async () => {
    const { cli, calls } = makeCli('', { listRows: [['stash@{0}', 'c'.repeat(40)]] });
    const result = await restoreLocalChanges(cli, CWD, SHA);
    assert.strictEqual(result.status, 'failed');
    assert.ok(
      !calls.some((c) => c[0] === 'stash' && c[1] === 'pop'),
      'must not pop an arbitrary entry'
    );
  });

  it('reports a failed pop with sanitized detail and never throws', async () => {
    const { cli } = makeCli('', {
      popExit: 1,
      popStderr: 'error: could not apply /Users/alice/repo/x.ts',
    });
    const result = await restoreLocalChanges(cli, CWD, SHA);
    assert.strictEqual(result.status, 'failed');
    if (result.status === 'failed') {
      assert.ok(!result.detail.includes('/Users/alice/'), 'home path must be scrubbed');
    }
  });
});

describe('withSavedChanges', () => {
  it('runs the op and restores the pinned entry when the tree was dirty', async () => {
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
    const stashVerbs = calls.filter((c) => c[0] === 'stash').map((c) => c[1]);
    assert.deepStrictEqual(
      stashVerbs,
      ['push', 'list', 'pop'],
      'push before the op; pinned lookup + pop after'
    );
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
    const stashVerbs = calls.filter((c) => c[0] === 'stash').map((c) => c[1]);
    assert.deepStrictEqual(
      stashVerbs,
      ['push', 'list', 'pop'],
      'the stash must be restored on op failure'
    );
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
